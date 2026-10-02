import { getDb, logJob } from './db'
import { getSecret } from './keyvault'
import { fetchDailyBars, fetchMinuteBars, type AlpacaKeys } from './alpaca'
import { invalidateSignalsCache } from './signals'
import type { BarRow, IntradayBar } from '../shared/types'

// Daily-bar store: cache-first with incremental refresh. Alpaca free tier serves
// IEX-feed bars back to ~2016 — good for daily charts on liquid names; do not add
// minute-bar features on this feed (PLAN.md §2.4).

const HISTORY_START = '2016-01-01'
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000
const lastAttempt = new Map<string, number>()

function nyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function alpacaKeys(): AlpacaKeys | null {
  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  return keyId && secret ? { keyId, secret } : null
}

function cachedBars(symbol: string): BarRow[] {
  return getDb()
    .prepare('SELECT symbol, date, open, high, low, close, volume FROM daily_bars WHERE symbol = ? ORDER BY date ASC')
    .all(symbol) as BarRow[]
}

async function refreshSymbol(
  symbol: string,
  keys: AlpacaKeys,
  fallbackStart = HISTORY_START,
  forceStart?: string
): Promise<number> {
  const db = getDb()
  const maxRow = db.prepare('SELECT MAX(date) AS d FROM daily_bars WHERE symbol = ?').get(symbol) as { d: string | null }
  // Re-fetch from ~10 days before the last cached date: the overlap both
  // corrects a partial final bar AND detects a backward re-scale (a stock
  // split re-scales ALL history — resuming blindly from MAX(date) would
  // splice pre-split and post-split scales into one series).
  const newest = forceStart ? null : maxRow.d
  const start = forceStart ?? (newest ? new Date(Date.parse(newest) - 10 * 86_400_000).toISOString().slice(0, 10) : fallbackStart)
  let bars = await fetchDailyBars(symbol, keys, start)
  if (bars.length === 0) return 0
  if (newest) {
    // Compare overlapping closes, EXCLUDING the cached tip (it may be a
    // partial intraday bar — corrected by the upsert either way).
    const cachedOverlap = db
      .prepare('SELECT date, close FROM daily_bars WHERE symbol = ? AND date >= ? AND date < ? ORDER BY date ASC')
      .all(symbol, start, newest) as { date: string; close: number }[]
    const fetchedByDate = new Map(bars.map((b) => [b.date, b.close]))
    const rescaled = cachedOverlap.some((row) => {
      const f = fetchedByDate.get(row.date)
      return f != null && row.close > 0 && Math.abs(f / row.close - 1) > 0.001
    })
    if (rescaled) {
      const full = await fetchDailyBars(symbol, keys, fallbackStart)
      if (full.length > 0) {
        db.prepare('DELETE FROM daily_bars WHERE symbol = ?').run(symbol)
        bars = full
      }
    }
  }
  const upsert = db.prepare(`
    INSERT INTO daily_bars(symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, date) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume
  `)
  const tx = db.transaction((rows: typeof bars) => {
    for (const b of rows) upsert.run(symbol, b.date, b.open, b.high, b.low, b.close, b.volume)
  })
  tx(bars)
  // Fresh history may unlock momentum for this symbol — drop any cached report.
  invalidateSignalsCache(symbol)
  return bars.length
}

// Symbols first seeded by the Discovery backfill only have history from
// DISCOVERY_HISTORY_START (~2024) — since refreshes always resume from
// MAX(date), the 2016+ range the interactive chart wants would otherwise
// never be fetched. getBars deep-fills ONCE per symbol (flagged in settings,
// so post-2016 IPOs don't refetch their full history every view).
const DEEP_MIN_DATE = '2016-03-01'

function deepFillDone(symbol: string): boolean {
  return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`bars_deep:${symbol}`) != null
}

function markDeepFill(symbol: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(`bars_deep:${symbol}`, '1')
}

export async function getBars(symbol: string): Promise<BarRow[]> {
  const cached = cachedBars(symbol)
  const newest = cached.length ? cached[cached.length - 1].date : null
  const stale = newest === null || newest < nyDate()
  const shallow = cached.length > 0 && cached[0].date > DEEP_MIN_DATE && !deepFillDone(symbol)
  // A failed BACKGROUND fetch (discovery sweep) must not lock the interactive
  // chart into a blank 15-minute wait — empty caches retry after 60s.
  const cooldownMs = cached.length === 0 ? 60_000 : REFRESH_COOLDOWN_MS
  const cooledDown = Date.now() - (lastAttempt.get(symbol) ?? 0) > cooldownMs
  const keys = alpacaKeys()

  if ((stale || shallow) && cooledDown && keys) {
    lastAttempt.set(symbol, Date.now())
    try {
      await refreshSymbol(symbol, keys, HISTORY_START, shallow ? HISTORY_START : undefined)
      // Full-history fetch just happened (deep fill, or first fetch from
      // scratch) — don't repeat it for post-2016 listings.
      if (shallow || cached.length === 0) markDeepFill(symbol)
      return cachedBars(symbol)
    } catch (e) {
      // Serve the cache on API failure — offline/holiday friendly.
      logJob('bars_refresh', 'error', `${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return cached
}

// Intraday minute bars for the "1D" view. One REST call per fetch, in-memory
// cached for 60s per symbol; live updates come from the websocket after that.
const intradayCache = new Map<string, { at: number; bars: IntradayBar[] }>()

export async function getIntradayBars(symbol: string, span: '1D' | '1W' = '1D'): Promise<IntradayBar[]> {
  const cacheKey = `${symbol}:${span}`
  const cached = intradayCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 60_000) return cached.bars
  const keys = alpacaKeys()
  if (!keys) return []
  // 1D: last ~32 hours of 1-minute bars so the view can be scrolled back through
  // after-hours and the overnight session into the prior day's close.
  // 1W: last ~8 days of 15-minute bars.
  // Note: the free IEX feed covers ~4am–8pm ET; true overnight (8pm–4am) prints
  // are sparse or absent.
  const hours = span === '1W' ? 8 * 24 : 32
  const timeframe = span === '1W' ? '15Min' : '1Min'
  const startIso = new Date(Date.now() - hours * 3_600_000).toISOString()
  try {
    const bars = await fetchMinuteBars(symbol, keys, startIso, timeframe)
    intradayCache.set(cacheKey, { at: Date.now(), bars })
    return bars
  } catch (e) {
    logJob('bars_intraday', 'error', `${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    return cached?.bars ?? []
  }
}

// One-time full-history (2016+) backfill for symbols first seeded by the
// shallow Discovery sweep — the backtester needs long history for every
// universe symbol, not just the ones the user happened to chart. Symbols
// whose cache already reaches DEEP_MIN_DATE are just flagged, not refetched.
let deepInFlight: Promise<{ ok: number; failed: number; skipped: number }> | null = null

export async function deepBackfillFor(symbols: string[]): Promise<{ ok: number; failed: number; skipped: number }> {
  // Serialize concurrent callers (e.g. two backtest invokes): the second
  // waits, then finds everything flagged and skips — instead of both loops
  // re-fetching the same full histories in lockstep.
  while (deepInFlight) {
    try {
      await deepInFlight
    } catch {
      /* previous run's failure is its own problem */
    }
  }
  const p = doDeepBackfill(symbols).finally(() => {
    if (deepInFlight === p) deepInFlight = null
  })
  deepInFlight = p
  return p
}

async function doDeepBackfill(symbols: string[]): Promise<{ ok: number; failed: number; skipped: number }> {
  const keys = alpacaKeys()
  if (!keys) return { ok: 0, failed: 0, skipped: symbols.length }
  const db = getDb()
  const minStmt = db.prepare('SELECT MIN(date) AS d FROM daily_bars WHERE symbol = ?')
  let ok = 0
  let failed = 0
  let skipped = 0
  for (const symbol of symbols) {
    if (deepFillDone(symbol)) {
      skipped++
      continue
    }
    const minD = (minStmt.get(symbol) as { d: string | null }).d
    if (minD != null && minD <= DEEP_MIN_DATE) {
      markDeepFill(symbol) // pre-flag era history is already deep
      skipped++
      continue
    }
    try {
      await refreshSymbol(symbol, keys, HISTORY_START, HISTORY_START)
      markDeepFill(symbol)
      lastAttempt.set(symbol, Date.now())
      ok++
    } catch (e) {
      failed++
      logJob('bars_deep', 'error', `${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (ok > 0 || failed > 0) logJob('bars_deep', failed === 0 ? 'ok' : 'partial', `${ok} deep-filled, ${failed} failed, ${skipped} already deep`)
  return { ok, failed, skipped }
}

// --- Total-return (dividend-adjusted) bars — the BACKTESTER's price series. ---
// Price-only backtests understate every dividend payer and make bond ETFs
// meaningless (AGG's return is mostly coupons), so the engine uses
// adjustment=all bars kept in their own table. The chart keeps split-only
// bars: those match what the screen would actually have shown on a given day.
//
// Backward-adjustment trap: every new dividend rescales the WHOLE history, so
// "resume from MAX(date)" silently splices two incompatible scales. Refresh
// therefore re-fetches a short overlap window and compares the overlap close —
// a mismatch means a distribution landed since last fetch → full re-fetch.

const lastAdjAttempt = new Map<string, number>()
// Tickers Alpaca returned zero rows for — remembered so cooldown-skipped
// re-runs still REPORT them missing (warnings must not vanish on re-run).
const knownEmpty = new Set<string>()

function adjNewest(symbol: string): string | null {
  return (getDb().prepare('SELECT MAX(date) AS d FROM daily_bars_adj WHERE symbol = ?').get(symbol) as { d: string | null }).d
}

function upsertAdj(symbol: string, bars: { date: string; open: number; high: number; low: number; close: number; volume: number }[]): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO daily_bars_adj(symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, date) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume
  `)
  const tx = db.transaction((rows: typeof bars) => {
    for (const b of rows) stmt.run(symbol, b.date, b.open, b.high, b.low, b.close, b.volume)
  })
  tx(bars)
}

async function refreshAdjSymbol(symbol: string, keys: AlpacaKeys): Promise<'ok' | 'empty'> {
  const db = getDb()
  const newest = adjNewest(symbol)
  if (newest == null) {
    const bars = await fetchDailyBars(symbol, keys, HISTORY_START, 'all')
    if (bars.length === 0) return 'empty'
    upsertAdj(symbol, bars)
    return 'ok'
  }
  // Overlap window: ~10 calendar days before the cached tip. The tip itself
  // is EXCLUDED from the comparison — it may be a partial intraday bar (the
  // upsert corrects it regardless), and a partial print must never be read
  // as "a dividend re-scaled history" (that would full-refetch the universe).
  const overlapStart = new Date(Date.parse(newest) - 10 * 86_400_000).toISOString().slice(0, 10)
  const bars = await fetchDailyBars(symbol, keys, overlapStart, 'all')
  if (bars.length === 0) return 'ok' // nothing new (holiday stretch) — cache stands
  const cachedOverlap = db
    .prepare('SELECT date, close FROM daily_bars_adj WHERE symbol = ? AND date >= ? AND date < ? ORDER BY date ASC')
    .all(symbol, overlapStart, newest) as { date: string; close: number }[]
  const fetchedByDate = new Map(bars.map((b) => [b.date, b.close]))
  let rescaled = false
  for (const row of cachedOverlap) {
    const f = fetchedByDate.get(row.date)
    if (f != null && row.close > 0 && Math.abs(f / row.close - 1) > 0.001) {
      rescaled = true
      break
    }
  }
  if (rescaled) {
    // A dividend re-scaled history — replace the whole series.
    const full = await fetchDailyBars(symbol, keys, HISTORY_START, 'all')
    if (full.length === 0) return 'empty'
    db.prepare('DELETE FROM daily_bars_adj WHERE symbol = ?').run(symbol)
    upsertAdj(symbol, full)
    return 'ok'
  }
  upsertAdj(symbol, bars)
  return 'ok'
}

export interface AdjEnsureResult {
  ok: number
  failed: number
  skipped: number
  missing: string[] // symbols Alpaca returned zero rows for (bad/unknown tickers)
}

let adjInFlight: Promise<AdjEnsureResult> | null = null

// Bring adjusted history up to date for `symbols` (serialized across callers,
// like deepBackfillFor). Missing tickers are reported, not thrown — a typo in
// a custom backtest universe should degrade into a warning.
export async function ensureAdjBars(symbols: string[]): Promise<AdjEnsureResult> {
  while (adjInFlight) {
    try {
      await adjInFlight
    } catch {
      /* previous run's failure is its own problem */
    }
  }
  const p = doEnsureAdjBars(symbols).finally(() => {
    if (adjInFlight === p) adjInFlight = null
  })
  adjInFlight = p
  return p
}

async function doEnsureAdjBars(symbols: string[]): Promise<AdjEnsureResult> {
  const keys = alpacaKeys()
  const out: AdjEnsureResult = { ok: 0, failed: 0, skipped: 0, missing: [] }
  if (!keys) {
    out.skipped = symbols.length
    return out
  }
  const today = nyDate()
  for (const symbol of symbols) {
    const newest = adjNewest(symbol)
    const cooldownMs = newest == null ? 60_000 : REFRESH_COOLDOWN_MS
    if ((newest != null && newest >= today) || Date.now() - (lastAdjAttempt.get(symbol) ?? 0) <= cooldownMs) {
      if (knownEmpty.has(symbol)) out.missing.push(symbol) // still no data — keep reporting it
      out.skipped++
      continue
    }
    lastAdjAttempt.set(symbol, Date.now())
    try {
      const r = await refreshAdjSymbol(symbol, keys)
      if (r === 'empty') {
        knownEmpty.add(symbol)
        out.missing.push(symbol)
        out.failed++
      } else {
        knownEmpty.delete(symbol)
        out.ok++
      }
    } catch (e) {
      out.failed++
      logJob('bars_adj', 'error', `${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (out.ok > 0 || out.failed > 0) {
    logJob('bars_adj', out.failed === 0 ? 'ok' : 'partial', `${out.ok} refreshed, ${out.failed} failed, ${out.skipped} fresh${out.missing.length ? `, no data: ${out.missing.join(',')}` : ''}`)
  }
  return out
}

// Batch refresh for the Discovery universe: shorter history (momentum 12-1
// needs ~253 trading days; ~2.5 years is ample) keeps the first backfill to
// ~1 REST call per symbol. Skips symbols already fresh today or in cooldown.
export async function ensureBarsFor(
  symbols: string[],
  fallbackStart: string
): Promise<{ ok: number; failed: number; skipped: number }> {
  const keys = alpacaKeys()
  if (!keys) return { ok: 0, failed: 0, skipped: symbols.length }
  const db = getDb()
  const newestStmt = db.prepare('SELECT MAX(date) AS d FROM daily_bars WHERE symbol = ?')
  const today = nyDate()
  let ok = 0
  let failed = 0
  let skipped = 0
  for (const symbol of symbols) {
    const newest = (newestStmt.get(symbol) as { d: string | null }).d
    const cooledDown = Date.now() - (lastAttempt.get(symbol) ?? 0) > REFRESH_COOLDOWN_MS
    if ((newest != null && newest >= today) || !cooledDown) {
      skipped++
      continue
    }
    lastAttempt.set(symbol, Date.now())
    try {
      await refreshSymbol(symbol, keys, fallbackStart)
      ok++
    } catch (e) {
      failed++
      logJob('bars_discovery', 'error', `${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ok, failed, skipped }
}

export async function refreshWatchlistBars(): Promise<{ ok: number; failed: number }> {
  const keys = alpacaKeys()
  if (!keys) return { ok: 0, failed: 0 }
  const symbols = (getDb().prepare('SELECT symbol FROM watchlist ORDER BY symbol').all() as { symbol: string }[]).map(
    (r) => r.symbol
  )
  let ok = 0
  let failed = 0
  for (const symbol of symbols) {
    try {
      await refreshSymbol(symbol, keys)
      lastAttempt.set(symbol, Date.now())
      ok++
    } catch {
      failed++
    }
  }
  logJob('bars_refresh', failed === 0 ? 'ok' : 'partial', `${ok}/${symbols.length} symbols refreshed`)
  return { ok, failed }
}
