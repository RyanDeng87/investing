import { getDb, logJob } from './db'
import { hasSecret } from './keyvault'
import { ensureBarsFor } from './bars'
import { DISCOVERY_UNIVERSE, type DiscoveryEntry } from './discovery-universe'
import type { DiscoveryReport, DiscoverySymbolStat } from '../shared/types'

// Phase 8 Market Discovery (PLAN.md): broad-market CONTEXT, never a buy list.
// Everything here is computed from locally cached daily bars — zero marginal
// API cost after the one-time backfill. Candidates funnel into the engines:
// clicking a symbol loads it so the Buffett/Signals/Options tabs can vet it.

// ~2.5 years back: 12-1 momentum needs ~253 trading days; this gives margin
// without multi-page history fetches per symbol.
const DISCOVERY_HISTORY_START = '2024-01-01'
const CACHE_MS = 10 * 60_000

const CAVEATS = [
  'Ranked context, not recommendations — relative strength and momentum describe what HAS happened; run any candidate through the Buffett Score / Signals / Options tabs before acting.',
  'Momentum percentile is cross-sectional across the ~70 locally tracked symbols (watchlist + discovery universe), not the whole market.',
  'Returns use split-adjusted IEX-feed daily closes; 1M/3M/6M = 21/63/126 trading days. Symbols newer than a window show “—”.',
  'Quantum names are early-stage and extremely volatile — sizing and expectations should reflect that.'
]

const NY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
const NY_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

function nyWeekday(t: number): string {
  return NY_CLOCK.formatToParts(new Date(t)).find((p) => p.type === 'weekday')?.value ?? 'Mon'
}

// The newest daily bar we can reasonably EXPECT to exist. Comparing against
// the calendar date made weekends/pre-market permanently "stale" — an endless
// refreshing banner, a defeated report cache, and a full universe re-sweep
// every cooldown expiry. Weekday after 9:30am ET → today; otherwise the most
// recent prior weekday. (Market holidays still look stale for one day —
// bounded by the 15-min cooldown and rare enough to accept.)
function expectedLatestBarDate(): string {
  let t = Date.now()
  const parts = NY_CLOCK.formatToParts(new Date(t))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  const weekday = get('weekday')
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
  const openWeekday = !['Sat', 'Sun'].includes(weekday) && minutes >= 9 * 60 + 30
  if (!openWeekday) {
    do {
      t -= 86_400_000
    } while (['Sat', 'Sun'].includes(nyWeekday(t)))
  }
  return NY_DATE.format(new Date(t))
}

function closesFor(symbol: string): number[] {
  return (
    getDb()
      .prepare('SELECT close FROM daily_bars WHERE symbol = ? ORDER BY date ASC')
      .all(symbol) as { close: number }[]
  ).map((r) => r.close)
}

function retOver(c: number[], tradingDays: number): number | null {
  const n = c.length
  if (n < tradingDays + 1) return null
  const base = c[n - 1 - tradingDays]
  return base > 0 ? c[n - 1] / base - 1 : null
}

function momentum121(c: number[]): number | null {
  const n = c.length
  if (n < 253) return null
  const start = c[n - 253]
  return start > 0 ? c[n - 22] / start - 1 : null
}

function sma(c: number[], window: number): number | null {
  if (c.length < window) return null
  let sum = 0
  for (let i = c.length - window; i < c.length; i++) sum += c[i]
  return sum / window
}

function buildStat(entry: DiscoveryEntry, spy: { r1m: number | null; r3m: number | null; r6m: number | null }): DiscoverySymbolStat {
  const c = closesFor(entry.symbol)
  const r1m = retOver(c, 21)
  const r3m = retOver(c, 63)
  const r6m = retOver(c, 126)
  const s200 = sma(c, 200)
  const last = c.length ? c[c.length - 1] : null
  const hi52 = c.length >= 2 ? Math.max(...c.slice(-252)) : null
  return {
    symbol: entry.symbol,
    name: entry.name,
    category: entry.category,
    last,
    ret1m: r1m,
    ret3m: r3m,
    ret6m: r6m,
    rel3m: r3m != null && spy.r3m != null ? r3m - spy.r3m : null,
    mom121: momentum121(c),
    momPct: null, // filled in cross-sectionally below
    above200d: last != null && s200 != null ? last > s200 : null,
    from52wHigh: last != null && hi52 != null && hi52 > 0 ? last / hi52 - 1 : null,
    barsDays: c.length
  }
}

// Seed non-ETF discovery names into the fundamentals-crawl universe so the
// Buffett engine's cross-section widens over time (crawler is budget-capped
// and watchlist-first, so this only consumes idle capacity).
function seedFundamentalsUniverse(): void {
  const insert = getDb().prepare('INSERT OR IGNORE INTO universe(symbol) VALUES (?)')
  for (const entry of DISCOVERY_UNIVERSE) {
    if (!entry.etf) insert.run(entry.symbol)
  }
}

export async function ensureDiscoveryBars(): Promise<{ ok: number; failed: number; skipped: number }> {
  const symbols = DISCOVERY_UNIVERSE.map((d) => d.symbol)
  const result = await ensureBarsFor(symbols, DISCOVERY_HISTORY_START)
  if (result.ok > 0 || result.failed > 0) {
    logJob('bars_discovery', result.failed === 0 ? 'ok' : 'partial', `${result.ok} refreshed, ${result.failed} failed, ${result.skipped} fresh`)
  }
  return result
}

let cached: { at: number; report: DiscoveryReport } | null = null
let backfillRunning = false

export async function getDiscovery(force = false): Promise<DiscoveryReport> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.report

  seedFundamentalsUniverse()

  // Backfill/refresh bars in the BACKGROUND on first call — a cold start is
  // ~50 REST calls and must not block the view. The report renders from
  // whatever history exists and flags itself as still refreshing. Staleness
  // is judged against the last EXPECTED trading bar (see expectedLatestBarDate)
  // and the backfill is only attempted when keys exist — otherwise weekends
  // and key-less installs would show a refreshing banner forever while
  // re-sweeping the whole universe every cooldown.
  const keysOk = hasSecret('alpaca_key_id') && hasSecret('alpaca_secret')
  let refreshing = false
  if (backfillRunning) {
    refreshing = true
  } else if (keysOk) {
    const expected = expectedLatestBarDate()
    const stale = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS c FROM (SELECT s.symbol FROM (${DISCOVERY_UNIVERSE.map(() => 'SELECT ? AS symbol').join(' UNION ALL ')}) s
           LEFT JOIN (SELECT symbol, MAX(date) AS d FROM daily_bars GROUP BY symbol) b ON b.symbol = s.symbol
           WHERE b.d IS NULL OR b.d < ?)`
        )
        .get(...DISCOVERY_UNIVERSE.map((d) => d.symbol), expected) as { c: number }
    ).c
    if (stale > 0) {
      refreshing = true
      backfillRunning = true
      void ensureDiscoveryBars()
        .then((r) => {
          // Only bust the report cache when bars actually changed — a no-op
          // sweep (everything in cooldown) must not defeat the 10-min cache.
          if (r.ok > 0) cached = null
        })
        .catch(() => undefined)
        .finally(() => {
          backfillRunning = false
        })
    }
  }

  const spyCloses = closesFor('SPY')
  const spy = { r1m: retOver(spyCloses, 21), r3m: retOver(spyCloses, 63), r6m: retOver(spyCloses, 126) }

  const stats = DISCOVERY_UNIVERSE.map((entry) => buildStat(entry, spy))

  // Cross-sectional momentum percentile (midrank) over every tracked symbol
  // with enough history — including watchlist symbols outside this universe.
  const inUniverse = new Set(stats.map((s) => s.symbol))
  const extraSymbols = (
    getDb().prepare('SELECT DISTINCT symbol FROM daily_bars').all() as { symbol: string }[]
  ).map((r) => r.symbol).filter((s) => !inUniverse.has(s))
  const pool: { symbol: string; mom: number }[] = []
  for (const s of stats) if (s.mom121 != null) pool.push({ symbol: s.symbol, mom: s.mom121 })
  for (const sym of extraSymbols) {
    const m = momentum121(closesFor(sym))
    if (m != null) pool.push({ symbol: sym, mom: m })
  }
  if (pool.length >= 8) {
    for (const s of stats) {
      if (s.mom121 == null) continue
      const below = pool.filter((p) => p.mom < (s.mom121 as number)).length
      const equal = pool.filter((p) => p.mom === s.mom121).length
      s.momPct = ((below + equal / 2) / pool.length) * 100
    }
  }

  const withHist = stats.filter((s) => s.ret1m != null)
  const byMomPct = stats.filter((s) => s.momPct != null).sort((a, b) => (b.momPct as number) - (a.momPct as number))

  const report: DiscoveryReport = {
    asOf: new Date().toISOString(),
    spyRet: spy,
    universeSize: stats.length,
    withHistory: withHist.length,
    poolSize: pool.length,
    sectors: stats
      .filter((s) => s.category === 'sector')
      .sort((a, b) => (b.rel3m ?? -Infinity) - (a.rel3m ?? -Infinity)),
    moversUp: [...withHist].sort((a, b) => (b.ret1m as number) - (a.ret1m as number)).slice(0, 6),
    moversDown: [...withHist].sort((a, b) => (a.ret1m as number) - (b.ret1m as number)).slice(0, 6),
    momentumLeaders: byMomPct.slice(0, 10),
    focus: {
      tech: stats.filter((s) => s.category === 'tech').sort((a, b) => (b.momPct ?? -1) - (a.momPct ?? -1)),
      quantum: stats.filter((s) => s.category === 'quantum').sort((a, b) => (b.ret3m ?? -Infinity) - (a.ret3m ?? -Infinity)),
      broad: stats.filter((s) => s.category === 'broad').sort((a, b) => (b.ret3m ?? -Infinity) - (a.ret3m ?? -Infinity)),
      goldfx: stats.filter((s) => s.category === 'goldfx').sort((a, b) => (b.ret3m ?? -Infinity) - (a.ret3m ?? -Infinity))
    },
    refreshing,
    caveats: keysOk ? CAVEATS : [...CAVEATS, 'Alpaca keys are missing — the price-history backfill is paused. Set keys in Settings and hit Refresh.']
  }
  cached = { at: Date.now(), report }
  return report
}
