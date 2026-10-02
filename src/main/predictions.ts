import { getDb, logJob } from './db'
import { getSignals } from './signals'
import { scoreSymbol } from './scoring'
import type { TrackRecord, TrackRecordKind } from '../shared/types'

// Prediction track record: every day the collector TIMESTAMPS what the app's
// engines are saying (signal tilt, QARP percentile, IV Rank) into
// prediction_snapshots. Once a snapshot's horizon passes, it is scored
// against what actually happened. This is the honest kind of forecast
// evaluation — written down in advance, misses kept, survivorship-free.
// The AI retrospective (llm.ts) reads this output to explain the misses.

const HORIZONS = {
  signal_tilt: 63, // ~3 months of trading days — the tilt's stated horizon
  buffett_qarp: 252, // quality/value theses play out over ~a year
  iv_rank: 21 // IV rich/cheap mean-reverts (or doesn't) within ~a month
} as const

// IV Rank over the same 370-day window the Options tab uses. Shared with
// alerts so every consumer fires against the number the user sees.
export function ivRank370(symbol: string): { rank: number; current: number; days: number } | null {
  const rows = getDb()
    .prepare(
      "SELECT atm_iv_30d FROM iv_snapshots WHERE symbol = ? AND atm_iv_30d IS NOT NULL AND snapshot_date >= date('now', '-370 days') ORDER BY snapshot_date ASC"
    )
    .all(symbol) as { atm_iv_30d: number }[]
  if (rows.length < 5) return null
  const ivs = rows.map((r) => r.atm_iv_30d)
  const current = ivs[ivs.length - 1]
  const lo = Math.min(...ivs)
  const hi = Math.max(...ivs)
  if (hi <= lo) return null
  return { rank: ((current - lo) / (hi - lo)) * 100, current, days: rows.length }
}

// Record today's engine outputs for every watchlist symbol (idempotent per
// day — INSERT OR IGNORE on the unique key). Called by the collector.
export async function recordPredictionSnapshots(): Promise<{ recorded: number }> {
  const db = getDb()
  const today = new Date().toLocaleDateString('sv')
  const insert = db.prepare(
    'INSERT OR IGNORE INTO prediction_snapshots(snapshot_date, symbol, kind, value, horizon_days, meta) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const symbols = (db.prepare('SELECT symbol FROM watchlist ORDER BY symbol').all() as { symbol: string }[]).map((r) => r.symbol)
  let recorded = 0
  for (const symbol of symbols) {
    try {
      const sig = await getSignals(symbol)
      if (sig.tilt != null && sig.confidence !== 'none') {
        recorded += insert.run(today, symbol, 'signal_tilt', sig.tilt, HORIZONS.signal_tilt, sig.label).changes
      }
    } catch {
      /* per-symbol failure must not stop the sweep */
    }
    try {
      const score = scoreSymbol(symbol)
      if (score.available && score.qarp != null) {
        recorded += insert.run(today, symbol, 'buffett_qarp', score.qarp, HORIZONS.buffett_qarp, score.dataSource ?? '').changes
      }
    } catch {
      /* ditto */
    }
    try {
      const iv = ivRank370(symbol)
      if (iv) {
        recorded += insert.run(today, symbol, 'iv_rank', iv.rank, HORIZONS.iv_rank, String(iv.current)).changes
      }
    } catch {
      /* ditto */
    }
  }
  if (recorded > 0) logJob('predictions', 'ok', `${recorded} snapshots for ${symbols.length} symbols`)
  return { recorded }
}

interface SnapRow {
  snapshot_date: string
  symbol: string
  value: number
  horizon_days: number
  meta: string | null
}

// Outcome of trying to score one snapshot. 'frozen' = the symbol's bar
// series stopped updating (delisted/acquired/removed from the watchlist)
// before the horizon — surfaced, never silently dropped: the blow-ups that
// stop trading are exactly the misses survivorship bias would hide.
type Scored =
  | { status: 'matured'; excess: number }
  | { status: 'pending' }
  | { status: 'frozen'; partialRet: number | null; lastDate: string | null }

// Memoized SPY forward returns: the track record grows by watchlist×days —
// without this, every matured row would re-run the same SPY query.
type SpyKey = string

function scoreForward(symbol: string, fromDate: string, h: number, spyCache: Map<SpyKey, number | null>): Scored {
  const db = getDb()
  // Basis consistency: the SPY leg is read from the SAME table as the
  // symbol's bars — excess must never mix total-return with split-only.
  for (const table of ['daily_bars_adj', 'daily_bars']) {
    const rows = db
      .prepare(`SELECT date, close FROM ${table} WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT ?`)
      .all(symbol, fromDate, h + 1) as { date: string; close: number }[]
    if (rows.length === 0) continue
    if (rows.length >= h + 1 && rows[0].close > 0) {
      const key = `${table}|${fromDate}|${h}`
      let spy = spyCache.get(key)
      if (spy === undefined) {
        const s = db
          .prepare(`SELECT close FROM ${table} WHERE symbol = 'SPY' AND date >= ? ORDER BY date ASC LIMIT ?`)
          .all(fromDate, h + 1) as { close: number }[]
        spy = s.length >= h + 1 && s[0].close > 0 ? s[h].close / s[0].close - 1 : null
        spyCache.set(key, spy)
      }
      if (spy == null) return { status: 'pending' }
      return { status: 'matured', excess: rows[h].close / rows[0].close - 1 - spy }
    }
    // Not enough forward bars — pending, unless the series has gone stale
    // (no new bars in ~2 weeks): then it can never mature.
    const newest = (db.prepare(`SELECT MAX(date) AS d FROM ${table} WHERE symbol = ?`).get(symbol) as { d: string | null }).d
    const staleCutoff = new Date(Date.now() - 14 * 86_400_000).toLocaleDateString('sv')
    if (newest != null && newest < staleCutoff) {
      const last = rows[rows.length - 1]
      return {
        status: 'frozen',
        partialRet: rows.length >= 2 && rows[0].close > 0 ? last.close / rows[0].close - 1 : null,
        lastDate: last.date
      }
    }
    return { status: 'pending' }
  }
  return { status: 'pending' }
}

const pctStr = (v: number, digits = 1): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`

// Absolute forward return (no SPY leg) — for market-level predictions where
// the symbol IS the benchmark (fear_greed records SPY itself).
function absForward(symbol: string, fromDate: string, h: number): { status: 'matured'; ret: number } | { status: 'pending' } {
  const db = getDb()
  for (const table of ['daily_bars_adj', 'daily_bars']) {
    const rows = db
      .prepare(`SELECT close FROM ${table} WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT ?`)
      .all(symbol, fromDate, h + 1) as { close: number }[]
    if (rows.length >= h + 1 && rows[0].close > 0) return { status: 'matured', ret: rows[h].close / rows[0].close - 1 }
    if (rows.length > 0) return { status: 'pending' }
  }
  return { status: 'pending' }
}

export function getTrackRecord(): TrackRecord {
  const db = getDb()
  const asOf = new Date().toISOString()
  const kinds: TrackRecordKind[] = []
  const spyCache = new Map<SpyKey, number | null>()

  const all = (kind: string): SnapRow[] =>
    db.prepare('SELECT snapshot_date, symbol, value, horizon_days, meta FROM prediction_snapshots WHERE kind = ? ORDER BY snapshot_date ASC').all(kind) as SnapRow[]

  // --- signal_tilt: does the tilt's SIGN predict excess return vs SPY? ---
  {
    const rows = all('signal_tilt')
    let matured = 0
    let pending = 0
    let frozen = 0
    let calls = 0
    let hits = 0
    const bullEx: number[] = []
    const bearEx: number[] = []
    const missList: { text: string; badness: number }[] = []
    for (const r of rows) {
      const s = scoreForward(r.symbol, r.snapshot_date, r.horizon_days, spyCache)
      if (s.status === 'pending') {
        pending++
        continue
      }
      if (s.status === 'frozen') {
        frozen++
        // A frozen series is often the WORST outcome — keep it visible.
        if (s.partialRet != null && Math.abs(r.value) >= 20 && Math.sign(r.value) !== Math.sign(s.partialRet)) {
          missList.push({
            text: `${r.snapshot_date} ${r.symbol}: tilt ${r.value > 0 ? '+' : ''}${r.value.toFixed(0)}, series stopped ${s.lastDate} at ${pctStr(s.partialRet)} (truncated, absolute)`,
            badness: Math.abs(s.partialRet) * Math.abs(r.value)
          })
        }
        continue
      }
      matured++
      const excess = s.excess
      if (Math.abs(r.value) < 20) continue // neutral tilts make no call
      calls++
      const right = Math.sign(r.value) === Math.sign(excess)
      if (right) hits++
      if (r.value > 0) bullEx.push(excess)
      else bearEx.push(excess)
      if (!right) {
        missList.push({
          text: `${r.snapshot_date} ${r.symbol}: tilt ${r.value > 0 ? '+' : ''}${r.value.toFixed(0)} but ${r.horizon_days}d excess ${pctStr(excess)}`,
          badness: Math.abs(excess) * Math.abs(r.value)
        })
      }
    }
    const avg = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    const stats = [
      { label: 'Directional calls (|tilt| ≥ 20)', value: String(calls) },
      { label: 'Direction hit rate', value: calls > 0 ? `${((hits / calls) * 100).toFixed(0)}%` : '—' },
      { label: 'Avg 63d excess after bullish calls', value: avg(bullEx) != null ? pctStr(avg(bullEx) as number) : '—' },
      { label: 'Avg 63d excess after bearish calls', value: avg(bearEx) != null ? pctStr(avg(bearEx) as number) : '—' }
    ]
    if (frozen > 0) stats.push({ label: 'Unscoreable (series stopped trading/updating)', value: String(frozen) })
    kinds.push({
      kind: 'signal_tilt',
      label: 'Signal tilt → 3-month excess return vs SPY',
      matured,
      pending,
      stats,
      misses: missList.sort((a, b) => b.badness - a.badness).slice(0, 5).map((m) => m.text),
      note: 'The tilt is DESIGNED as a weak probabilistic lean. The literature would call ~55% directional accuracy a success; anything near 50% means the inputs carry no edge at this horizon.'
    })
  }

  // --- buffett_qarp: do high-QARP names beat low-QARP over a year? ---
  {
    const rows = all('buffett_qarp')
    let matured = 0
    let pending = 0
    let frozen = 0
    const hi: number[] = []
    const lo: number[] = []
    const missList: { text: string; badness: number }[] = []
    for (const r of rows) {
      const s = scoreForward(r.symbol, r.snapshot_date, r.horizon_days, spyCache)
      if (s.status === 'pending') {
        pending++
        continue
      }
      if (s.status === 'frozen') {
        frozen++
        if (s.partialRet != null && r.value >= 70 && s.partialRet < -0.1) {
          missList.push({
            text: `${r.snapshot_date} ${r.symbol}: QARP ${r.value.toFixed(0)}, series stopped ${s.lastDate} at ${pctStr(s.partialRet)} (truncated, absolute)`,
            badness: -s.partialRet
          })
        }
        continue
      }
      matured++
      const excess = s.excess
      if (r.value >= 70) {
        hi.push(excess)
        if (excess < -0.1) missList.push({ text: `${r.snapshot_date} ${r.symbol}: QARP ${r.value.toFixed(0)} but 1y excess ${pctStr(excess)}`, badness: -excess })
      } else if (r.value <= 30) {
        lo.push(excess)
        if (excess > 0.1) missList.push({ text: `${r.snapshot_date} ${r.symbol}: QARP ${r.value.toFixed(0)} but 1y excess ${pctStr(excess)}`, badness: excess })
      }
    }
    const avg = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    const qarpStats = [
      { label: 'High-QARP (≥70) matured / avg excess', value: `${hi.length} / ${avg(hi) != null ? pctStr(avg(hi) as number) : '—'}` },
      { label: 'Low-QARP (≤30) matured / avg excess', value: `${lo.length} / ${avg(lo) != null ? pctStr(avg(lo) as number) : '—'}` },
      {
        label: 'High-minus-low spread',
        value: avg(hi) != null && avg(lo) != null ? pctStr((avg(hi) as number) - (avg(lo) as number)) : '—'
      }
    ]
    if (frozen > 0) qarpStats.push({ label: 'Unscoreable (series stopped trading/updating)', value: String(frozen) })
    kinds.push({
      kind: 'buffett_qarp',
      label: 'Buffett QARP percentile → 1-year excess return vs SPY',
      matured,
      pending,
      stats: qarpStats,
      misses: missList.sort((a, b) => b.badness - a.badness).slice(0, 5).map((m) => m.text),
      note: 'The QARP thesis: quality-at-a-reasonable-price outruns the market over years, not quarters. One year is the SHORTEST horizon worth glancing at.'
    })
  }

  // --- iv_rank: does IV-rich (≥70) fall and IV-cheap (≤30) rise within a month? ---
  {
    const rows = all('iv_rank')
    let matured = 0
    let pending = 0
    let richCalls = 0
    let richHits = 0
    let cheapCalls = 0
    let cheapHits = 0
    const missList: { text: string; badness: number }[] = []
    for (const r of rows) {
      const ivThen = Number(r.meta)
      if (!Number.isFinite(ivThen) || ivThen <= 0) continue
      // IV at/after the horizon: the first snapshot ≥ horizon calendar days later.
      const later = getDb()
        .prepare(
          "SELECT atm_iv_30d FROM iv_snapshots WHERE symbol = ? AND atm_iv_30d IS NOT NULL AND snapshot_date >= date(?, '+' || ? || ' days') ORDER BY snapshot_date ASC LIMIT 1"
        )
        .get(r.symbol, r.snapshot_date, Math.round(r.horizon_days * 1.45)) as { atm_iv_30d: number } | undefined
      if (!later) {
        pending++
        continue
      }
      matured++
      const change = later.atm_iv_30d / ivThen - 1
      if (r.value >= 70) {
        richCalls++
        if (change < 0) richHits++
        else missList.push({ text: `${r.snapshot_date} ${r.symbol}: IV Rank ${r.value.toFixed(0)} (rich) but IV rose ${pctStr(change)}`, badness: change })
      } else if (r.value <= 30) {
        cheapCalls++
        if (change > 0) cheapHits++
        else missList.push({ text: `${r.snapshot_date} ${r.symbol}: IV Rank ${r.value.toFixed(0)} (cheap) but IV fell ${pctStr(change)}`, badness: -change })
      }
    }
    kinds.push({
      kind: 'iv_rank',
      label: 'IV Rank extremes → 1-month IV mean reversion',
      matured,
      pending,
      stats: [
        { label: 'Rich calls (rank ≥ 70) / IV fell', value: richCalls > 0 ? `${richCalls} / ${((richHits / richCalls) * 100).toFixed(0)}%` : '0 / —' },
        { label: 'Cheap calls (rank ≤ 30) / IV rose', value: cheapCalls > 0 ? `${cheapCalls} / ${((cheapHits / cheapCalls) * 100).toFixed(0)}%` : '0 / —' }
      ],
      misses: missList.sort((a, b) => b.badness - a.badness).slice(0, 5).map((m) => m.text),
      note: 'IV Rank needs ~a year of collected history to mean much — early readings rank against a thin window. Mean reversion is the bet the options screener leans on.'
    })
  }

  // --- stance: do the Description tab's buy/sell calls beat SPY over their stated timeframe? ---
  {
    const rows = all('stance')
    let matured = 0
    let pending = 0
    let frozen = 0
    let hits = 0
    const buyEx: number[] = []
    const sellEx: number[] = []
    const missList: { text: string; badness: number }[] = []
    for (const r of rows) {
      let action: 'buy' | 'sell' = r.value > 0 ? 'buy' : 'sell'
      try {
        const m = JSON.parse(r.meta ?? '{}') as { action?: string }
        if (m.action === 'buy' || m.action === 'sell') action = m.action
      } catch {
        /* legacy/malformed meta — the composite's sign carries the call */
      }
      // A stance ON the benchmark itself cannot be graded on excess vs itself
      // (identically zero — every call would count as a miss). SPY stances are
      // market calls: grade them on ABSOLUTE return ("stay invested" vs "step
      // aside"), and keep them out of the excess averages.
      if (r.symbol === 'SPY') {
        const s = absForward('SPY', r.snapshot_date, r.horizon_days)
        if (s.status !== 'matured') {
          pending++
          continue
        }
        matured++
        const right = action === 'buy' ? s.ret > 0 : s.ret < 0
        if (right) hits++
        else {
          missList.push({
            text: `${r.snapshot_date} SPY: ${action.toUpperCase()} but ${r.horizon_days}d absolute return ${pctStr(s.ret)}`,
            badness: Math.abs(s.ret)
          })
        }
        continue
      }
      const s = scoreForward(r.symbol, r.snapshot_date, r.horizon_days, spyCache)
      if (s.status === 'pending') {
        pending++
        continue
      }
      if (s.status === 'frozen') {
        frozen++
        if (s.partialRet != null && ((action === 'buy' && s.partialRet < 0) || (action === 'sell' && s.partialRet > 0))) {
          missList.push({
            text: `${r.snapshot_date} ${r.symbol}: ${action.toUpperCase()} but series stopped ${s.lastDate} at ${pctStr(s.partialRet)} (truncated, absolute)`,
            badness: Math.abs(s.partialRet)
          })
        }
        continue
      }
      matured++
      const excess = s.excess
      const right = action === 'buy' ? excess > 0 : excess < 0
      if (right) hits++
      if (action === 'buy') buyEx.push(excess)
      else sellEx.push(excess)
      if (!right) {
        missList.push({
          text: `${r.snapshot_date} ${r.symbol}: ${action.toUpperCase()} (composite ${r.value >= 0 ? '+' : ''}${r.value.toFixed(0)}) but ${r.horizon_days}d excess ${pctStr(excess)}`,
          badness: Math.abs(excess)
        })
      }
    }
    const avg = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    const stats = [
      { label: 'Buy/sell stances matured', value: String(matured) },
      { label: 'Direction hit rate (vs SPY)', value: matured > 0 ? `${((hits / matured) * 100).toFixed(0)}%` : '—' },
      { label: 'Avg excess after BUY stances', value: avg(buyEx) != null ? pctStr(avg(buyEx) as number) : '—' },
      { label: 'Avg excess after SELL stances', value: avg(sellEx) != null ? pctStr(avg(sellEx) as number) : '—' }
    ]
    if (frozen > 0) stats.push({ label: 'Unscoreable (series stopped trading/updating)', value: String(frozen) })
    kinds.push({
      kind: 'stance',
      label: 'Description-tab stance → excess return vs SPY over its stated timeframe',
      matured,
      pending,
      stats,
      misses: missList.sort((a, b) => b.badness - a.badness).slice(0, 5).map((m) => m.text),
      note: 'Only ★ starred symbols are recorded, only buy/sell (holds make no claim), graded over each stance’s own horizon. SPY stances are graded on absolute return (excess vs itself is meaningless) and stay out of the excess averages; near-benchmark ETFs (VOO/VTI) carry little information either way. If the hit rate hugs 50%, the folding-together added nothing over its inputs.'
    })
  }

  // --- fear_greed: after extreme readings, does SPY's next month look different? ---
  {
    const rows = all('fear_greed')
    let matured = 0
    let pending = 0
    const fearRets: number[] = []
    const greedRets: number[] = []
    const missList: { text: string; badness: number }[] = []
    for (const r of rows) {
      const s = absForward(r.symbol, r.snapshot_date, r.horizon_days)
      if (s.status !== 'matured') {
        pending++
        continue
      }
      matured++
      if (r.value <= 25) {
        fearRets.push(s.ret)
        if (s.ret < -0.03) {
          missList.push({
            text: `${r.snapshot_date}: extreme fear (${r.value.toFixed(0)}) but SPY fell ${pctStr(s.ret)} over the next month`,
            badness: -s.ret
          })
        }
      } else if (r.value >= 75) {
        greedRets.push(s.ret)
        if (s.ret > 0.03) {
          missList.push({
            text: `${r.snapshot_date}: extreme greed (${r.value.toFixed(0)}) but SPY rose ${pctStr(s.ret)} over the next month`,
            badness: s.ret
          })
        }
      }
    }
    const avg = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    kinds.push({
      kind: 'fear_greed',
      label: 'Fear & Greed extremes → SPY return over the next month',
      matured,
      pending,
      stats: [
        { label: 'Extreme-fear days (≤25) / avg 21d SPY return', value: `${fearRets.length} / ${avg(fearRets) != null ? pctStr(avg(fearRets) as number) : '—'}` },
        { label: 'Extreme-greed days (≥75) / avg 21d SPY return', value: `${greedRets.length} / ${avg(greedRets) != null ? pctStr(avg(greedRets) as number) : '—'}` },
        {
          label: 'Fear-minus-greed spread',
          value: avg(fearRets) != null && avg(greedRets) != null ? pctStr((avg(fearRets) as number) - (avg(greedRets) as number)) : '—'
        }
      ],
      misses: missList.sort((a, b) => b.badness - a.badness).slice(0, 5).map((m) => m.text),
      note: 'Only extremes are recorded — mid-range readings carry no claim. The contrarian thesis is that the month AFTER extreme fear beats the month after extreme greed; greed-side calls fight the market’s upward drift, so read the spread, not raw hit counts. Extremes are rare: this card fills in slowly, over years.'
    })
  }

  const anyData = kinds.some((k) => k.matured > 0 || k.pending > 0)
  return {
    available: anyData,
    asOf,
    kinds,
    disclosures: [
      'Snapshots are timestamped BEFORE outcomes are known and misses are never deleted — the honest, survivorship-free way to judge a signal. The numbers will look worse than backtests. That is the point.',
      'Small samples say almost nothing: treat every rate here as an anecdote until the matured count reaches the hundreds. One quarter of data cannot validate (or damn) a signal family.',
      'Same-day snapshots share one market backdrop, so twenty calls recorded the same week are closer to one bet than twenty — the effective sample is smaller than the count shown.',
      'Excess returns are vs SPY over the same window, with both legs read from the SAME bar table (total-return preferred) — bases are never mixed. Symbols whose series stopped updating are counted as unscoreable and their truncated wrong-way outcomes stay in the misses list.'
    ],
    message: anyData ? undefined : 'No snapshots yet — they start accruing with the next collector run (daily, per watchlist symbol).'
  }
}
