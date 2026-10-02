import { getDb, logJob } from './db'
import { getSecret } from './keyvault'
import { fmpBudget } from './budgeter'
import type { CompanyProfile, CrawlSummary } from '../shared/types'

// Rolling fundamentals crawl (PLAN.md §2.1): FMP free tier is 250 calls/day, so we
// refresh the scoring universe a few symbols at a time, stalest first, watchlist
// first. Results land append-only in fundamentals_snapshots (point-in-time data).

// FMP's legacy /api/v3 endpoints return 403 for current accounts — use the stable API.
const FMP_BASE = 'https://financialmodelingprep.com/stable'

// 4 calls per symbol; keep a reserve so interactive features never hit a dead budget.
const ENDPOINTS: { source: string; path: (s: string) => string }[] = [
  { source: 'fmp:profile', path: (s) => `/profile?symbol=${s}` },
  { source: 'fmp:ratios-ttm', path: (s) => `/ratios-ttm?symbol=${s}` },
  { source: 'fmp:key-metrics-ttm', path: (s) => `/key-metrics-ttm?symbol=${s}` },
  { source: 'fmp:income-annual', path: (s) => `/income-statement?symbol=${s}&limit=5` }
]
const CALLS_PER_SYMBOL = ENDPOINTS.length
const DAILY_RESERVE = 50
const MAX_CRAWL_CALLS_PER_RUN = 100

// ETFs have no statement fundamentals; don't burn budget on them.
const ETF_SKIP = new Set(['QQQ', 'SPY', 'XLK', 'SMH', 'IGV', 'VGT', 'SOXX', 'VOO', 'VTI', 'VXUS', 'GLD'])

async function fmpGet(path: string, apiKey: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${FMP_BASE}${path}${sep}apikey=${apiKey}`)
  if (!res.ok) throw new Error(`FMP ${res.status}: ${(await res.text()).slice(0, 150)}`)
  return res.json()
}

function crawlTargets(limit: number): string[] {
  // Stalest-first across watchlist ∪ universe, watchlist prioritized.
  const rows = getDb()
    .prepare(
      `
      SELECT u.symbol,
             (SELECT MAX(fetched_at) FROM fundamentals_snapshots f WHERE f.symbol = u.symbol) AS last_fetched,
             EXISTS(SELECT 1 FROM watchlist w WHERE w.symbol = u.symbol) AS on_watchlist
      FROM (SELECT symbol FROM universe UNION SELECT symbol FROM watchlist) u
      ORDER BY on_watchlist DESC, COALESCE(last_fetched, '') ASC, u.symbol ASC
      `
    )
    .all() as { symbol: string }[]
  return rows.map((r) => r.symbol).filter((s) => !ETF_SKIP.has(s)).slice(0, limit)
}

export async function crawlFundamentals(): Promise<CrawlSummary> {
  const apiKey = getSecret('fmp_key')
  if (!apiKey) {
    logJob('fundamentals_crawl', 'skipped', 'FMP key not configured')
    return { symbols: [], callsUsed: 0, remainingToday: fmpBudget.remainingToday(), message: 'FMP key not configured' }
  }

  const available = Math.min(MAX_CRAWL_CALLS_PER_RUN, fmpBudget.remainingToday() - DAILY_RESERVE)
  const symbolCount = Math.floor(available / CALLS_PER_SYMBOL)
  if (symbolCount <= 0) {
    logJob('fundamentals_crawl', 'skipped', 'FMP daily budget exhausted')
    return { symbols: [], callsUsed: 0, remainingToday: fmpBudget.remainingToday(), message: 'daily budget exhausted' }
  }

  const db = getDb()
  const insert = db.prepare('INSERT INTO fundamentals_snapshots(symbol, source, payload) VALUES (?, ?, ?)')
  const targets = crawlTargets(symbolCount)
  const done: string[] = []
  let callsUsed = 0

  for (const symbol of targets) {
    try {
      for (const ep of ENDPOINTS) {
        // Consume before the call — FMP counts failed requests against the quota too.
        callsUsed++
        fmpBudget.consume(1)
        const payload = await fmpGet(ep.path(symbol), apiKey)
        // Empty arrays mean FMP has nothing for this symbol/endpoint — still record
        // the attempt so the crawler doesn't retry it every day.
        insert.run(symbol, ep.source, JSON.stringify(payload))
      }
      done.push(symbol)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('FMP 402')) {
        // Symbol gated behind a premium plan on the free tier — record a marker row
        // so stalest-first ordering stops retrying it every day. (EDGAR fallback
        // planned in Phase 2; FMP Starter would also unlock these.)
        insert.run(symbol, 'fmp:unavailable', JSON.stringify({ error: msg.slice(0, 200) }))
      }
      logJob('fundamentals_crawl', 'error', `${symbol}: ${msg}`)
    }
  }

  logJob('fundamentals_crawl', 'ok', `${done.length} symbols, ${callsUsed} calls (${fmpBudget.remainingToday()} left today)`)
  return { symbols: done, callsUsed, remainingToday: fmpBudget.remainingToday() }
}

// --- Company profile for the Description tab ---
// Cache-first: the rolling crawl already stores fmp:profile for stocks. ETFs
// are ETF_SKIP'd by the crawl (no statement fundamentals) but /profile still
// describes them, so a missing profile triggers ONE budgeted on-demand call
// whose result lands in fundamentals_snapshots like any crawl row.

function pick(obj: Record<string, unknown> | null, keys: string[]): unknown {
  if (!obj) return null
  for (const k of keys) {
    const v = obj[k]
    if (v != null && v !== '') return v
  }
  return null
}

function parseProfile(symbol: string, payload: unknown, fetchedAt: string): CompanyProfile | null {
  const rec = Array.isArray(payload) ? ((payload[0] as Record<string, unknown>) ?? null) : null
  const obj = rec ?? (payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null)
  if (!obj) return null
  const name = String(pick(obj, ['companyName', 'name']) ?? '')
  const description = String(pick(obj, ['description']) ?? '')
  if (!name && !description) return null
  const mkt = pick(obj, ['marketCap', 'mktCap'])
  return {
    symbol,
    available: true,
    name: name || symbol,
    exchange: String(pick(obj, ['exchangeShortName', 'exchange']) ?? ''),
    sector: String(pick(obj, ['sector']) ?? ''),
    industry: String(pick(obj, ['industry']) ?? ''),
    marketCap: typeof mkt === 'number' && Number.isFinite(mkt) && mkt > 0 ? mkt : null,
    description,
    website: String(pick(obj, ['website']) ?? ''),
    isEtf: pick(obj, ['isEtf']) === true || pick(obj, ['isFund']) === true,
    fetchedAt
  }
}

export async function getCompanyProfile(symbol: string): Promise<CompanyProfile> {
  const sym = symbol.toUpperCase()
  const miss: CompanyProfile = {
    symbol: sym,
    available: false,
    name: sym,
    exchange: '',
    sector: '',
    industry: '',
    marketCap: null,
    description: '',
    website: '',
    isEtf: false,
    fetchedAt: ''
  }
  const db = getDb()
  const row = db
    .prepare("SELECT payload, fetched_at FROM fundamentals_snapshots WHERE symbol = ? AND source = 'fmp:profile' ORDER BY fetched_at DESC, id DESC LIMIT 1")
    .get(sym) as { payload: string; fetched_at: string } | undefined
  if (row) {
    try {
      const parsed = parseProfile(sym, JSON.parse(row.payload), row.fetched_at)
      if (parsed) return parsed
    } catch {
      /* corrupt cache row — fall through to a fresh fetch */
    }
  }

  const apiKey = getSecret('fmp_key')
  if (!apiKey) return { ...miss, message: 'No profile cached and no FMP key set — add one in Settings for company descriptions.' }
  if (fmpBudget.remainingToday() < 5) return { ...miss, message: 'No profile cached and the FMP daily budget is spent — it will retry tomorrow.' }
  try {
    fmpBudget.consume(1)
    const payload = await fmpGet(`/profile?symbol=${sym}`, apiKey)
    db.prepare('INSERT INTO fundamentals_snapshots(symbol, source, payload) VALUES (?, ?, ?)').run(sym, 'fmp:profile', JSON.stringify(payload))
    const parsed = parseProfile(sym, payload, new Date().toISOString())
    if (parsed) return parsed
    return { ...miss, message: 'FMP has no profile for this symbol.' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logJob('profile', 'error', `${sym}: ${msg}`)
    return { ...miss, message: `Profile fetch failed: ${msg.slice(0, 120)}` }
  }
}
