import { getDb, logJob } from './db'
import type { FearGreed, FearGreedComponent } from '../shared/types'

// CNN Fear & Greed Index — the unofficial JSON endpoint CNN's own dashboard
// reads. Composite 0–100 of seven market internals (momentum, breadth,
// highs/lows, put/call, VIX, junk-bond demand, safe-haven demand).
// Undocumented and unauthenticated: it demands a browser-like User-Agent
// (the default fetch UA gets HTTP 418) and can change or block at any time,
// so every consumer degrades to the last cached row — losing the feed only
// dims a panel, never breaks a feature.

const FG_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'

const COMPONENT_DEFS: { key: string; label: string }[] = [
  { key: 'market_momentum_sp500', label: 'S&P 500 momentum vs 125-day MA' },
  { key: 'stock_price_strength', label: '52-week highs vs lows (NYSE)' },
  { key: 'stock_price_breadth', label: 'Volume breadth (McClellan)' },
  { key: 'put_call_options', label: 'Put/call ratio (5-day)' },
  { key: 'market_volatility_vix', label: 'VIX vs 50-day MA' },
  { key: 'junk_bond_demand', label: 'Junk bond spread' },
  { key: 'safe_haven_demand', label: 'Stocks vs bonds (20-day)' }
]

const NOTE =
  'A description of market mood, not a signal: mid-range wiggles are noise, and even the contrarian read of extremes (fear ≤ 25 as a tailwind, greed ≥ 75 as caution) has weak evidence. Extreme readings are recorded and graded in the Journal’s track record — judge the index there.'

interface FgRow {
  date: string
  score: number
  rating: string
  components: string | null
  fetched_at: string
}

function numField(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strField(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return ''
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

// Fetch and persist. Backfills CNN's own daily composite history (INSERT OR
// IGNORE — a live row with components is never overwritten by a bare
// historical point). Failures log and return ok:false; callers keep the cache.
export async function refreshFearGreed(): Promise<{ ok: boolean; score?: number; message?: string }> {
  try {
    const res = await fetch(FG_URL, {
      headers: {
        // CNN's bot filter rejects non-browser UAs with HTTP 418.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://www.cnn.com/markets/fear-and-greed'
      }
    })
    if (!res.ok) throw new Error(`CNN endpoint HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, unknown>

    const fg = data.fear_and_greed
    const score = numField(fg, 'score')
    if (score == null) throw new Error('response shape changed — no fear_and_greed.score')
    const rating = strField(fg, 'rating')
    const ts = strField(fg, 'timestamp')
    const date = /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : new Date().toLocaleDateString('sv')

    const components: FearGreedComponent[] = COMPONENT_DEFS.map((d) => ({
      key: d.key,
      label: d.label,
      score: numField(data[d.key], 'score'),
      rating: strField(data[d.key], 'rating')
    }))
    const extras = JSON.stringify({
      components,
      weekAgo: numField(fg, 'previous_1_week'),
      monthAgo: numField(fg, 'previous_1_month'),
      yearAgo: numField(fg, 'previous_1_year')
    })

    const db = getDb()
    db.prepare(
      `INSERT INTO fear_greed(date, score, rating, components, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(date) DO UPDATE SET score = excluded.score, rating = excluded.rating, components = excluded.components, fetched_at = excluded.fetched_at`
    ).run(date, score, rating, extras)

    // Historical composite series (multi-year daily) — context only, never a
    // prediction source: only rows recorded live get graded.
    const hist = data.fear_and_greed_historical
    const points = hist && typeof hist === 'object' ? (hist as Record<string, unknown>).data : null
    if (Array.isArray(points)) {
      const ins = db.prepare('INSERT OR IGNORE INTO fear_greed(date, score, rating, components) VALUES (?, ?, ?, NULL)')
      const insertAll = db.transaction((rows: unknown[]) => {
        for (const p of rows) {
          const x = numField(p, 'x')
          const y = numField(p, 'y')
          if (x == null || y == null) continue
          ins.run(new Date(x).toISOString().slice(0, 10), y, strField(p, 'rating'))
        }
      })
      insertAll(points)
    }

    logJob('fear_greed', 'ok', `score ${score.toFixed(0)} (${rating}) for ${date}`)
    return { ok: true, score }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logJob('fear_greed', 'error', msg)
    return { ok: false, message: msg }
  }
}

// Throttle in-app refreshes: the endpoint is a courtesy, not a contract.
let lastAttempt = 0

export async function getFearGreed(force = false): Promise<FearGreed> {
  const db = getDb()
  const latest = db.prepare('SELECT * FROM fear_greed WHERE components IS NOT NULL ORDER BY date DESC LIMIT 1').get() as
    | FgRow
    | undefined
  const fetchedMs = latest ? Date.parse(latest.fetched_at.replace(' ', 'T') + 'Z') : 0
  const staleCache = !latest || Date.now() - fetchedMs > 6 * 60 * 60_000
  if ((force || staleCache) && Date.now() - lastAttempt > 5 * 60_000) {
    lastAttempt = Date.now()
    await refreshFearGreed()
  }

  const row = db.prepare('SELECT * FROM fear_greed WHERE components IS NOT NULL ORDER BY date DESC LIMIT 1').get() as
    | FgRow
    | undefined
  if (!row) {
    return {
      available: false,
      score: null,
      rating: '',
      asOf: '',
      fetchedAt: '',
      stale: false,
      weekAgo: null,
      monthAgo: null,
      yearAgo: null,
      components: [],
      history: [],
      note: NOTE,
      message: 'Fear & Greed unavailable — CNN’s unofficial endpoint could not be reached yet (it retries with each collector run).'
    }
  }

  let components: FearGreedComponent[] = []
  let weekAgo: number | null = null
  let monthAgo: number | null = null
  let yearAgo: number | null = null
  try {
    const extras = JSON.parse(row.components ?? '{}') as {
      components?: FearGreedComponent[]
      weekAgo?: number | null
      monthAgo?: number | null
      yearAgo?: number | null
    }
    if (Array.isArray(extras.components)) components = extras.components
    weekAgo = typeof extras.weekAgo === 'number' ? extras.weekAgo : null
    monthAgo = typeof extras.monthAgo === 'number' ? extras.monthAgo : null
    yearAgo = typeof extras.yearAgo === 'number' ? extras.yearAgo : null
  } catch {
    /* old/malformed extras — score and rating still stand */
  }

  const history = (
    db.prepare('SELECT date, score FROM fear_greed ORDER BY date DESC LIMIT 250').all() as { date: string; score: number }[]
  ).reverse()

  // "Stale" = the newest full row is more than ~2 days old (weekend-tolerant).
  const stale = Date.now() - Date.parse(`${row.date}T12:00:00`) > 2.5 * 86_400_000
  return {
    available: true,
    score: row.score,
    rating: row.rating,
    asOf: row.date,
    fetchedAt: row.fetched_at,
    stale,
    weekAgo,
    monthAgo,
    yearAgo,
    components,
    history,
    note: NOTE,
    message: stale ? `Showing the last cached reading (${row.date}) — the CNN endpoint has not answered since.` : undefined
  }
}

// Synchronous cache read for the stance engine, LLM context, and prediction
// recording — never triggers a network call.
export function latestFearGreed(maxAgeDays = 4): { score: number; rating: string; date: string } | null {
  const row = getDb().prepare('SELECT date, score, rating FROM fear_greed ORDER BY date DESC LIMIT 1').get() as
    | { date: string; score: number; rating: string }
    | undefined
  if (!row) return null
  if (Date.now() - Date.parse(`${row.date}T12:00:00`) > maxAgeDays * 86_400_000) return null
  return { score: row.score, rating: row.rating, date: row.date }
}
