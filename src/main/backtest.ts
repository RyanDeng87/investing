import { createHash } from 'crypto'
import { getDb } from './db'
import { ensureAdjBars } from './bars'
import { DISCOVERY_UNIVERSE } from './discovery-universe'
import type {
  BacktestConfig,
  BacktestMetrics,
  BacktestPoint,
  BacktestResult,
  BootstrapPercentiles,
  BootstrapResult,
  ContributionResult,
  DrawdownEpisode,
  RebalanceRecord,
  RebalanceFreq,
  StrategyKind
} from '../shared/types'

// Backtester v2 (RESEARCH.md §4, PLAN.md Phase 5): an HONEST, small
// event-driven engine over locally cached TOTAL-RETURN daily bars
// (adjustment=all — dividends reinvested; the chart keeps split-only bars).
// Its job is calibration, not discovery — every known bias is either
// corrected or loudly labeled:
//   - costs: one-way bps haircut on every weight change (incl. the first buy)
//   - no lookahead: signals use data through day t, positions earn day t+1
//   - deflated Sharpe (Bailey & López de Prado 2014): PSR against the expected
//     max Sharpe of N tried variants — N grows in backtest_trials every time a
//     new config is run, so re-running with tweaks honestly deflates results
//   - survivorship: cannot be fixed with this data (today's universe only) —
//     prominently disclosed instead
// Metric conventions follow the cross-tool consensus (Portfolio Visualizer /
// quantstats / Morningstar), verified 2026-07: Sortino uses the full-sample
// denominator, capture ratios use monthly geometric means, VaR/CVaR are
// historical daily, the bootstrap is Politis–Romano stationary with L=10.

const MOM_SKIP = 21 // momentum 12-1: skip most recent month (short-term reversal)
const MOM_LOOKBACK = 252
const DUAL_LOOKBACK = 252 // GEM uses the plain 12-month return, no skip
const CASH_PROXY = 'BIL' // T-bill ETF: total-return bars make its yield real
const DUAL_DEFAULTS = ['SPY', 'EFA', 'AGG'] // risk1, risk2 (intl), defensive
const SYMBOL_RE = /^[A-Z.]{1,6}$/

interface Series {
  dates: string[]
  closes: number[]
  index: Map<string, number>
}

// Adjusted (total-return) series preferred; falls back to split-only bars so
// an offline run still works — the caller records which symbols fell back.
function loadSeries(symbol: string, fellBack?: Set<string>): Series | null {
  const db = getDb()
  let rows = db
    .prepare('SELECT date, close FROM daily_bars_adj WHERE symbol = ? ORDER BY date ASC')
    .all(symbol) as { date: string; close: number }[]
  if (rows.length === 0) {
    rows = db
      .prepare('SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date ASC')
      .all(symbol) as { date: string; close: number }[]
    if (rows.length > 0) fellBack?.add(symbol)
  }
  if (rows.length === 0) return null
  const dates = rows.map((r) => r.date)
  const closes = rows.map((r) => r.close)
  const index = new Map(dates.map((d, i) => [d, i]))
  return { dates, closes, index }
}

// --- shared stats (one module so PSR, Sortino and VaR agree) ---

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

function normInv(p: number): number {
  // Acklam's rational approximation, |relative error| < 1.15e-9.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  let q: number
  let r: number
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - pl) {
    q = p - 0.5
    r = q * q
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

// Population moments (n denominators). At T ≈ 1400 the sample corrections are
// negligible; using one estimator keeps PSR, Sortino and the displayed
// skew/kurtosis consistent with each other.
function moments(r: number[]): { mean: number; std: number; skew: number; kurt: number } {
  const n = r.length
  if (n === 0) return { mean: 0, std: 0, skew: 0, kurt: 3 }
  const mean = r.reduce((a, b) => a + b, 0) / n
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (const x of r) {
    const d = x - mean
    m2 += d * d
    m3 += d * d * d
    m4 += d * d * d * d
  }
  m2 /= n
  m3 /= n
  m4 /= n
  const std = Math.sqrt(m2)
  return { mean, std, skew: std > 0 ? m3 / std ** 3 : 0, kurt: std > 0 ? m4 / std ** 4 : 3 }
}

// Type-7 (linear interpolation) quantile of a pre-sorted ascending array.
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const h = (sorted.length - 1) * q
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo)
}

// Bailey & López de Prado: PSR = P[true SR > SR*] given the observed SR's
// sampling distribution (adjusted for skew/kurtosis of the returns).
function psrAt(srDaily: number, srStar: number, T: number, skew: number, kurt: number): number {
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * srDaily + ((kurt - 1) / 4) * srDaily * srDaily))
  return normCdf(((srDaily - srStar) * Math.sqrt(T - 1)) / denom)
}

function registerTrial(config: BacktestConfig): number {
  const db = getDb()
  const hash = configHash(config)
  db.prepare('INSERT OR IGNORE INTO backtest_trials(config_hash) VALUES (?)').run(hash)
  return (db.prepare('SELECT COUNT(*) AS c FROM backtest_trials').get() as { c: number }).c
}

// Hash ONLY the strategy-defining fields, in the exact key order normalizeConfig
// emits them (existing anchors/trials were hashed with this shape). Cashflow
// fields (initialCapital/contribMonthly) are deliberately excluded — the same
// strategy with a different contribution schedule is not a new "trial".
export function configHash(config: BacktestConfig): string {
  const strategyOnly = {
    strategy: config.strategy,
    topN: config.topN,
    costBps: config.costBps,
    start: config.start,
    end: config.end,
    symbols: config.symbols,
    weights: config.weights,
    benchmark: config.benchmark,
    rebalance: config.rebalance
  }
  return createHash('sha256').update(JSON.stringify(strategyOnly)).digest('hex').slice(0, 24)
}

// Annualized money-weighted return: the rate that discounts every cashflow
// (negative = money in, positive final value) to zero NPV. Sign pattern is
// all-negative-then-one-positive → single root; bisection is safe.
function annualizedIrr(flows: { date: string; amount: number }[]): number | null {
  if (flows.length < 2) return null
  const t0 = Date.parse(flows[0].date)
  const yearsOf = (d: string): number => (Date.parse(d) - t0) / (365.25 * 86_400_000)
  const npv = (r: number): number => flows.reduce((a, f) => a + f.amount / Math.pow(1 + r, yearsOf(f.date)), 0)
  let lo = -0.95
  let hi = 10
  let fLo = npv(lo)
  let fHi = npv(hi)
  // npv is monotone-decreasing for this flow pattern — widen the bracket
  // before giving up (short windows on hot strategies can exceed 1000%/yr).
  while (fHi > 0 && hi < 1e6) {
    hi = (1 + hi) * 4 - 1
    fHi = npv(hi)
  }
  if (fLo * fHi > 0) return null // no root (degenerate window, e.g. total loss)
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid)
    if (fMid === 0) return mid
    if (fLo * fMid < 0) hi = mid
    else {
      lo = mid
      fLo = fMid
    }
  }
  return (lo + hi) / 2
}

const EULER = 0.5772156649015329

const STRATEGY_KINDS: StrategyKind[] = ['momentum-12-1', 'ma-timing', 'buy-hold', 'fixed-allocation', 'dual-momentum']
const REBALANCE_ALLOWED: Record<StrategyKind, RebalanceFreq[]> = {
  'momentum-12-1': ['monthly', 'quarterly'],
  'ma-timing': ['monthly'], // signal is daily; the field is canonicalized
  'buy-hold': ['monthly'],
  'fixed-allocation': ['monthly', 'quarterly', 'yearly', 'none', 'bands'],
  'dual-momentum': ['monthly'] // Antonacci's published rule
}

// --- config normalization: every raw field clamped/validated BEFORE anything
// registers a trial or touches the network. Returns an error string for input
// that should be rejected rather than silently corrected. ---

function parseDate(raw: unknown, kind: 'start' | 'end'): { value: string } | { error: string } {
  const s = String(raw ?? '').trim()
  if (s === '') return { value: '' }
  if (/^\d{4}$/.test(s)) return { value: kind === 'start' ? `${s}-01-01` : `${s}-12-31` }
  if (/^\d{4}-\d{2}$/.test(s)) return { value: kind === 'start' ? `${s}-01` : `${s}-31` }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s }
  return { error: `Bad ${kind} date "${s}" — use YYYY, YYYY-MM or YYYY-MM-DD.` }
}

export function normalizeConfig(rawConfig: BacktestConfig): { config: BacktestConfig; error?: string } {
  const strategy = rawConfig?.strategy
  const bad = (error: string): { config: BacktestConfig; error: string } => ({ config: rawConfig, error })

  if (!STRATEGY_KINDS.includes(strategy)) {
    return bad(`Unknown strategy "${String(strategy)}" — valid: ${STRATEGY_KINDS.join(', ')}.`)
  }

  const rawSymbols = Array.isArray(rawConfig?.symbols) ? rawConfig.symbols : []
  const symbols = [...new Set(rawSymbols.map((s) => String(s ?? '').trim().toUpperCase()).filter((s) => s !== ''))]
  const invalid = symbols.filter((s) => !SYMBOL_RE.test(s))
  if (invalid.length > 0) return bad(`Invalid ticker${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}.`)
  if (strategy === 'momentum-12-1' && symbols.length > 60) return bad('Momentum universe capped at 60 symbols.')
  if ((strategy === 'buy-hold' || strategy === 'ma-timing') && symbols.length > 1) {
    return bad(`${strategy} takes a single symbol.`)
  }
  if (strategy === 'fixed-allocation' && (symbols.length === 0 || symbols.length > 12)) {
    return bad('Fixed allocation needs 1–12 legs (e.g. "VOO 60, QQQ 20, GLD 20").')
  }
  if (strategy === 'dual-momentum' && symbols.length !== 0 && symbols.length !== 3) {
    return bad('Dual momentum takes exactly 3 symbols (risk1, risk2, defensive) — or none for SPY/EFA/AGG.')
  }

  let weights: number[] = []
  if (strategy === 'fixed-allocation') {
    const rawW = Array.isArray(rawConfig?.weights) ? rawConfig.weights.map(Number) : []
    if (rawW.length === 0) {
      weights = symbols.map(() => 1 / symbols.length)
    } else {
      if (rawW.length !== symbols.length) return bad('Weights must match the symbol list one-for-one.')
      if (rawW.some((w) => !Number.isFinite(w) || w <= 0)) return bad('Weights must be positive numbers.')
      const sum = rawW.reduce((a, b) => a + b, 0)
      weights = rawW.map((w) => w / sum)
    }
  }

  const benchmark = String(rawConfig?.benchmark ?? '').trim().toUpperCase() || 'SPY'
  if (!SYMBOL_RE.test(benchmark)) return bad(`Invalid benchmark ticker "${benchmark}".`)

  const start = parseDate(rawConfig?.start, 'start')
  if ('error' in start) return bad(start.error)
  const end = parseDate(rawConfig?.end, 'end')
  if ('error' in end) return bad(end.error)
  if (start.value && end.value && end.value <= start.value) return bad('End date must be after the start date.')

  const allowed = REBALANCE_ALLOWED[strategy]
  let rebalance = rawConfig?.rebalance as RebalanceFreq
  if (!allowed.includes(rebalance)) {
    // Canonicalize silently only where the field doesn't apply — a WRONG
    // explicit choice for a strategy that does use it is rejected.
    if (strategy === 'ma-timing' || strategy === 'buy-hold' || strategy === 'dual-momentum') rebalance = 'monthly'
    else if (rebalance == null || (rebalance as string) === '') rebalance = strategy === 'fixed-allocation' ? 'quarterly' : 'monthly'
    else return bad(`Rebalance "${String(rebalance)}" not valid for ${strategy} (allowed: ${allowed.join(', ')}).`)
  }

  const rawN = Number(rawConfig?.topN)
  // NO falsy-defaulting: a 0 in the UI must clamp to 1, not silently run 5.
  let topN = Number.isFinite(rawN) ? Math.min(20, Math.max(1, Math.round(rawN))) : 5
  if (strategy === 'momentum-12-1' && symbols.length > 0) topN = Math.min(topN, symbols.length)

  const rawCapital = Number(rawConfig?.initialCapital)
  const rawContrib = Number(rawConfig?.contribMonthly)
  const config: BacktestConfig = {
    strategy,
    topN,
    costBps: Math.min(100, Math.max(0, Number.isFinite(Number(rawConfig?.costBps)) ? Number(rawConfig?.costBps) : 5)),
    start: start.value,
    end: end.value,
    symbols,
    weights,
    benchmark,
    rebalance,
    initialCapital: Number.isFinite(rawCapital) ? Math.min(10_000_000, Math.max(100, rawCapital)) : 10_000,
    contribMonthly: Number.isFinite(rawContrib) ? Math.min(1_000_000, Math.max(0, rawContrib)) : 0
  }
  return { config }
}

export function strategyUniverse(config: BacktestConfig): { universe: string[]; fetchList: string[] } {
  if (config.strategy === 'momentum-12-1') {
    const universe =
      config.symbols.length > 0
        ? config.symbols
        : [
            ...new Set([
              ...DISCOVERY_UNIVERSE.map((d) => d.symbol),
              ...(getDb().prepare('SELECT symbol FROM watchlist').all() as { symbol: string }[]).map((r) => r.symbol)
            ])
          ]
    return { universe, fetchList: [...new Set([...universe, config.benchmark])] }
  }
  if (config.strategy === 'dual-momentum') {
    const universe = config.symbols.length === 3 ? config.symbols : DUAL_DEFAULTS
    return { universe, fetchList: [...new Set([...universe, CASH_PROXY, config.benchmark])] }
  }
  if (config.strategy === 'fixed-allocation') {
    return { universe: config.symbols, fetchList: [...new Set([...config.symbols, config.benchmark])] }
  }
  const sym = config.symbols[0] ?? 'SPY'
  return { universe: [sym], fetchList: [...new Set([sym, config.benchmark])] }
}

export function strategyLabel(config: BacktestConfig): string {
  const { universe } = strategyUniverse(config)
  switch (config.strategy) {
    case 'momentum-12-1':
      return `Momentum 12-1 top ${config.topN}${
        config.symbols.length === 0 ? '' : config.symbols.length > 6 ? ` of ${config.symbols.length} pinned symbols` : ` of ${config.symbols.join('/')}`
      }`
    case 'ma-timing':
      return `${universe[0]} 200-day MA timing`
    case 'buy-hold':
      return `Buy & hold ${universe[0]}`
    case 'fixed-allocation':
      return universe.map((s, i) => `${s} ${Math.round((config.weights[i] ?? 0) * 100)}%`).join(' / ')
    case 'dual-momentum':
      return `Dual momentum (${universe.join('/')})`
  }
}

// --- simulation ---

interface SimOutput {
  result: BacktestResult
  dailyReturns: number[]
  benchDaily: number[]
}

async function simulate(rawConfig: BacktestConfig, register: boolean): Promise<SimOutput> {
  const norm = normalizeConfig(rawConfig)
  const config = norm.config
  const asOf = new Date().toISOString()
  const base: BacktestResult = {
    config,
    asOf,
    available: false,
    effectiveStart: null,
    effectiveEnd: null,
    points: [],
    metrics: null,
    rebalances: [],
    drawdowns: [],
    coverage: { eligibleAtStart: 0, eligibleAtEnd: 0, universeSize: 0 },
    fellBack: [],
    contrib: null,
    warnings: []
  }
  const fail = (message: string): SimOutput => ({ result: { ...base, message }, dailyReturns: [], benchDaily: [] })

  // Validate BEFORE registering a trial or fetching: bad input must not
  // pollute the DSR trial count or burn API calls.
  if (norm.error) return fail(norm.error)

  const { universe, fetchList } = strategyUniverse(config)
  const adj = await ensureAdjBars(fetchList)

  const fellBack = new Set<string>()
  const bench = loadSeries(config.benchmark, fellBack)
  if (!bench || bench.dates.length < 120) {
    return fail(`Not enough history for benchmark ${config.benchmark}${adj.missing.includes(config.benchmark) ? ' (Alpaca has no data for it)' : ''} — check the ticker or retry once keys/network are available.`)
  }
  const calendar = bench.dates // the benchmark's trading calendar anchors everything
  const benchIdx = bench.index

  const series = new Map<string, Series>()
  for (const sym of fetchList) {
    if (sym === config.benchmark) {
      series.set(sym, bench)
      continue
    }
    const s = loadSeries(sym, fellBack)
    if (s && s.dates.length >= 30) series.set(sym, s)
  }
  const missing = universe.filter((s) => !series.has(s))
  if (config.strategy !== 'momentum-12-1' && missing.length > 0) {
    return fail(`No usable price history for: ${missing.join(', ')} — check the ticker${missing.length > 1 ? 's' : ''}.`)
  }
  if (config.strategy === 'momentum-12-1' && universe.length - missing.length < Math.max(2, config.topN)) {
    return fail(`Only ${universe.length - missing.length} of ${universe.length} universe symbols have data — not enough to rank top ${config.topN}.`)
  }

  // --- date range ---
  let startPos = 0
  if (config.start) {
    startPos = calendar.findIndex((d) => d >= config.start)
    if (startPos < 0) return fail('Start date is after the available history.')
  }
  let endPos = calendar.length - 1
  if (config.end) {
    for (let p = calendar.length - 1; p >= 0; p--) {
      if (calendar[p] <= config.end) {
        endPos = p
        break
      }
    }
    if (calendar[endPos] > config.end) return fail('End date is before the available history.')
  }

  // Month-end calendar positions (last trading day of each month).
  const monthEnds: number[] = []
  for (let p = 0; p < calendar.length - 1; p++) {
    if (calendar[p].slice(0, 7) !== calendar[p + 1].slice(0, 7)) monthEnds.push(p)
  }
  const monthEndSet = new Set(monthEnds)
  const isQuarterEnd = (p: number): boolean => monthEndSet.has(p) && ['03', '06', '09', '12'].includes(calendar[p].slice(5, 7))
  const isYearEnd = (p: number): boolean => monthEndSet.has(p) && calendar[p].slice(5, 7) === '12'

  // SIGNAL lookups are gap-tolerant: a symbol with no print on the signal
  // date (IEX omits zero-trade days even post-2020) is evaluated on its most
  // recent close — mirroring the P&L loop's lastCloseOf bridging. Without
  // this, one missing bar liquidates positions and pays phantom costs.
  // Staleness bound: a price >10 calendar days old is no longer a signal.
  const barIndexNear = (sym: string, pos: number): number | null => {
    const s = series.get(sym)
    if (!s) return null
    const date = calendar[pos]
    const exact = s.index.get(date)
    if (exact != null) return exact
    // binary search: largest i with dates[i] <= date
    let lo = 0
    let hi = s.dates.length - 1
    if (s.dates[0] > date) return null
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s.dates[mid] <= date) lo = mid
      else hi = mid - 1
    }
    return calDays(s.dates[lo], date) > 10 ? null : lo
  }

  const eligibleMomentum = (sym: string, pos: number): boolean => {
    const i = barIndexNear(sym, pos)
    return i != null && i >= MOM_LOOKBACK
  }

  const momentumAt = (sym: string, pos: number): number | null => {
    const i = barIndexNear(sym, pos)
    const s = series.get(sym)
    if (s == null || i == null || i < MOM_LOOKBACK) return null
    const end = s.closes[i - MOM_SKIP]
    const start = s.closes[i - MOM_LOOKBACK]
    return start > 0 ? end / start - 1 : null
  }

  // GEM 12-month total return (no skip).
  const ret12 = (sym: string, pos: number): number | null => {
    const i = barIndexNear(sym, pos)
    const s = series.get(sym)
    if (s == null || i == null || i < DUAL_LOOKBACK) return null
    const start = s.closes[i - DUAL_LOOKBACK]
    return start > 0 ? s.closes[i] / start - 1 : null
  }

  const hasHistoryBy = (sym: string, pos: number): boolean => {
    const s = series.get(sym)
    return s != null && s.dates[0] <= calendar[pos]
  }

  // Target weights the strategy wants, decided with data through `pos`.
  // Returns NULL when the signal inputs are unavailable (stale beyond the
  // barIndexNear bound) — meaning "hold what you have", never "liquidate".
  const timedSymbol = universe[0]
  const cashHurdleAvailable = config.strategy !== 'dual-momentum' || series.has(CASH_PROXY)
  const targetWeights = (pos: number): Map<string, number> | null => {
    const w = new Map<string, number>()
    if (config.strategy === 'buy-hold') {
      w.set(timedSymbol, 1)
      return w
    }
    if (config.strategy === 'ma-timing') {
      const s = series.get(timedSymbol)
      const i = barIndexNear(timedSymbol, pos)
      if (!s || i == null || i < 199) return null // no usable signal — keep
      let sum = 0
      for (let k = i - 199; k <= i; k++) sum += s.closes[k]
      if (s.closes[i] > sum / 200) w.set(timedSymbol, 1) // else: cash (0%)
      return w
    }
    if (config.strategy === 'fixed-allocation') {
      universe.forEach((sym, i) => w.set(sym, config.weights[i]))
      return w
    }
    if (config.strategy === 'dual-momentum') {
      const [risk1, risk2, defensive] = universe
      const r1 = ret12(risk1, pos)
      if (r1 == null) return null // signal unavailable — keep positions
      // Antonacci's published rule: the absolute-momentum gate is ALWAYS
      // evaluated on risk1 (US equities) vs the T-bill return, regardless of
      // which equity leg wins relative momentum.
      const hurdle = ret12(CASH_PROXY, pos) ?? 0
      if (r1 > hurdle) {
        const r2 = ret12(risk2, pos)
        w.set(r2 != null && r2 > r1 ? risk2 : risk1, 1)
      } else if (hasHistoryBy(defensive, pos)) {
        w.set(defensive, 1)
      }
      return w
    }
    // momentum-12-1: long the top-N by 12-1 return, equal weight.
    const ranked = universe
      .map((sym) => ({ sym, m: momentumAt(sym, pos) }))
      .filter((x): x is { sym: string; m: number } => x.m != null)
      .sort((a, b) => b.m - a.m)
      .slice(0, config.topN)
    if (ranked.length === 0) return null
    for (const { sym } of ranked) w.set(sym, 1 / Math.max(1, ranked.length))
    return w
  }

  // --- readiness: earliest position where the strategy can actually invest ---
  const eligibleCount = (p: number): number => universe.filter((s) => eligibleMomentum(s, p)).length
  const readyAt = (p: number): boolean => {
    switch (config.strategy) {
      case 'momentum-12-1':
        return eligibleCount(p) >= Math.min(config.topN, universe.length)
      case 'ma-timing': {
        const i = barIndexNear(timedSymbol, p)
        return i != null && i >= 199
      }
      case 'buy-hold':
        return hasHistoryBy(timedSymbol, p)
      case 'fixed-allocation':
        return universe.every((s) => hasHistoryBy(s, p))
      case 'dual-momentum':
        return ret12(universe[0], p) != null && ret12(universe[1], p) != null && hasHistoryBy(universe[2], p)
    }
  }

  // Invest at the month-end on/before startPos (signals only use data ≤ that
  // day), pushed forward until the strategy is ready.
  let firstRebalance = [...monthEnds].reverse().find((p) => p <= startPos) ?? startPos
  let clampedBy: string | null = null
  while (firstRebalance < endPos && !readyAt(firstRebalance)) {
    const next = monthEnds.find((p) => p > firstRebalance)
    if (next == null || next >= endPos) break
    firstRebalance = next
    clampedBy = 'readiness'
  }
  if (!readyAt(firstRebalance)) {
    return fail(
      config.strategy === 'momentum-12-1'
        ? 'No date in the range has enough symbols with a full 12-month lookback — extend the range or shrink the universe.'
        : 'The selected symbols do not have enough history inside the chosen date range.'
    )
  }
  if (endPos - firstRebalance < 61) {
    return fail('Fewer than ~3 months of simulated days in the range — widen the dates.')
  }

  // Which symbol pushed the start later? (named in the clamp warning)
  let constraining: string | null = null
  if (clampedBy) {
    let latest = ''
    for (const sym of universe) {
      const s = series.get(sym)
      if (!s) continue
      const needIdx = config.strategy === 'momentum-12-1' ? MOM_LOOKBACK : config.strategy === 'dual-momentum' ? DUAL_LOOKBACK : 0
      const d = s.dates[Math.min(needIdx, s.dates.length - 1)]
      if (d > latest) {
        latest = d
        constraining = sym
      }
    }
  }

  // --- position-based accounting: each holding's value drifts with its own
  // price between rebalances; unwinding drift is real, costed turnover. ---
  const costRate = config.costBps / 10_000
  const posVal = new Map<string, number>()
  const lastCloseOf = new Map<string, number>() // last SEEN close — survives gaps of any length
  let cash = 1
  let equity = 1
  let benchEquity = 1 - costRate // benchmark pays its initial buy too
  let totalCost = 0
  const points: BacktestPoint[] = []
  const dailyReturns: number[] = []
  const benchDaily: number[] = []
  const rebalances: RebalanceRecord[] = []
  let turnoverSum = 0
  const monthlyEq: number[] = []
  const monthlyBenchEq: number[] = []

  const applyRebalance = (pos: number): void => {
    const target = targetWeights(pos)
    if (!target) return // signal unavailable — hold, never liquidate
    // Turnover measured against DRIFTED weights (posVal/equity), so unwinding
    // a winner's overweight is counted and costed like any other trade.
    let traded = 0
    const keys = new Set([...posVal.keys(), ...target.keys()])
    for (const k of keys) traded += Math.abs((target.get(k) ?? 0) - (posVal.get(k) ?? 0) / equity)
    const oneWay = traded / 2
    const cost = traded * costRate
    totalCost += cost
    equity *= 1 - cost
    posVal.clear()
    // Reference closes: drop symbols leaving the portfolio (a re-add must not
    // inherit a pre-drop price), refresh symbols that printed today, and
    // RETAIN the stale entry for a kept holding with no print — so its full
    // gap move still lands on the day it prints again.
    for (const k of [...lastCloseOf.keys()]) if (!target.has(k)) lastCloseOf.delete(k)
    for (const [k, w] of target) {
      posVal.set(k, w * equity)
      const s = series.get(k)
      const i = s?.index.get(calendar[pos])
      if (s && i != null) lastCloseOf.set(k, s.closes[i])
    }
    cash = equity - [...posVal.values()].reduce((a, b) => a + b, 0)
    if (traded > 1e-9 || rebalances.length === 0) {
      rebalances.push({ date: calendar[pos], holdings: [...target.keys()], turnover: oneWay })
      turnoverSum += oneWay
    }
  }

  // Swedroe 5/25 band check (fixed-allocation 'bands' mode, at month-ends).
  const bandsBreached = (): boolean => {
    for (let i = 0; i < universe.length; i++) {
      const t = config.weights[i]
      const cur = (posVal.get(universe[i]) ?? 0) / equity
      if (Math.abs(cur - t) > 0.05) return true
      if (t > 0 && Math.abs(cur - t) / t > 0.25) return true
    }
    return false
  }

  const wantsRebalance = (pos: number): boolean => {
    switch (config.strategy) {
      case 'momentum-12-1':
        return config.rebalance === 'quarterly' ? isQuarterEnd(pos) : monthEndSet.has(pos)
      case 'ma-timing':
        return true // daily signal; costs only on flips
      case 'buy-hold':
        return false
      case 'dual-momentum':
        return monthEndSet.has(pos)
      case 'fixed-allocation':
        switch (config.rebalance) {
          case 'monthly':
            return monthEndSet.has(pos)
          case 'quarterly':
            return isQuarterEnd(pos)
          case 'yearly':
            return isYearEnd(pos)
          case 'bands':
            return monthEndSet.has(pos) && bandsBreached()
          case 'none':
            return false
        }
    }
  }

  applyRebalance(firstRebalance)
  monthlyEq.push(equity) // seed: the FIRST invested month must count in the hit rate
  monthlyBenchEq.push(benchEquity)
  const effectiveStart = calendar[firstRebalance]
  const effectiveEnd = calendar[endPos]
  // Dollar (cashflow) tracking, parallel to growth-of-$1: TWR metrics are
  // unaffected by contributions — this answers "what would MY account be
  // worth". Contributions land at the close of each month's first trading
  // day, buy the current holdings pro-rata, and pay the same per-side cost.
  const contribNet = config.contribMonthly * (1 - costRate)
  // Dollar sim also runs for a lump sum with a non-default Start $ — the
  // card then shows the lump-sum outcome instead of silently ignoring it.
  const wantDollarSim = config.contribMonthly > 0 || config.initialCapital !== 10_000
  let dollarEq = config.initialCapital * equity
  let benchDollar = config.initialCapital * benchEquity
  const cashflows: { date: string; amount: number }[] = [{ date: effectiveStart, amount: -config.initialCapital }]
  let contribCount = 0
  // Inception point: the charts (underwater peak, heatmap month anchor,
  // growth origin) must describe the SAME series as the metrics, which seed
  // their peaks/months at post-initial-cost equity.
  points.push({ date: effectiveStart, equity, benchmark: benchEquity })
  // Drawdown peaks include the inception point — a slide that starts on day
  // one must measure from starting equity, not from the end of day one.
  let peak = equity
  let maxDrawdown = 0
  let bPeak = benchEquity
  let benchMaxDrawdown = 0
  // Drawdown-episode tracking (drives the table + Ulcer + underwater stats).
  let peakDate = effectiveStart
  let ddSumSq = 0
  let underwaterDays = 0
  const episodes: DrawdownEpisode[] = []
  let ep: { peakDate: string; troughDate: string; depth: number } | null = null

  for (let pos = firstRebalance + 1; pos <= endPos; pos++) {
    const dayStart = equity
    // Market move: positions decided at pos-1 or earlier earn day pos (no
    // lookahead). A holding with no print today stays frozen; its FULL move
    // is applied on the day it prints again (lastCloseOf bridges any gap).
    let posSum = 0
    for (const [sym, v] of posVal) {
      let nv = v
      const s = series.get(sym)
      const i = s?.index.get(calendar[pos])
      if (s && i != null) {
        const prev = lastCloseOf.get(sym)
        const cNow = s.closes[i]
        if (prev != null && prev > 0) nv = v * (cNow / prev)
        lastCloseOf.set(sym, cNow)
      }
      if (nv !== v) posVal.set(sym, nv)
      posSum += nv
    }
    equity = cash + posSum

    // Rebalance AFTER the day's return with data through today's close —
    // but never on the final bar: a trade with no next day would charge a
    // cost invisible to the (already final) equity curve.
    if (pos < endPos && wantsRebalance(pos)) applyRebalance(pos)

    // Day return is NET of any rebalance cost charged today — Sharpe/PSR/DSR
    // must describe the same after-cost strategy the equity curve shows.
    dailyReturns.push(equity / dayStart - 1)
    benchDaily.push(bench.closes[pos] / bench.closes[pos - 1] - 1)
    benchEquity *= bench.closes[pos] / bench.closes[pos - 1]
    points.push({ date: calendar[pos], equity, benchmark: benchEquity })

    if (wantDollarSim) {
      dollarEq *= 1 + (equity / dayStart - 1)
      benchDollar *= bench.closes[pos] / bench.closes[pos - 1]
      // First trading day of a new month → contribution at the close.
      if (config.contribMonthly > 0 && calendar[pos].slice(0, 7) !== calendar[pos - 1].slice(0, 7)) {
        dollarEq += contribNet
        benchDollar += contribNet
        cashflows.push({ date: calendar[pos], amount: -config.contribMonthly })
        contribCount++
      }
    }

    if (equity >= peak) {
      if (ep) {
        episodes.push({
          peakDate: ep.peakDate,
          troughDate: ep.troughDate,
          recoveryDate: calendar[pos],
          depth: ep.depth,
          daysToTrough: calDays(ep.peakDate, ep.troughDate),
          daysToRecover: calDays(ep.troughDate, calendar[pos])
        })
        ep = null
      }
      peak = equity
      peakDate = calendar[pos]
    } else {
      const dd = equity / peak - 1
      maxDrawdown = Math.min(maxDrawdown, dd)
      underwaterDays++
      if (!ep) ep = { peakDate, troughDate: calendar[pos], depth: dd }
      else if (dd < ep.depth) {
        ep.depth = dd
        ep.troughDate = calendar[pos]
      }
    }
    const ddNow = Math.min(0, equity / peak - 1)
    ddSumSq += (ddNow * 100) ** 2

    bPeak = Math.max(bPeak, benchEquity)
    benchMaxDrawdown = Math.min(benchMaxDrawdown, benchEquity / bPeak - 1)

    const nextMonth = pos < endPos ? calendar[pos + 1].slice(0, 7) : '9999-99'
    if (calendar[pos].slice(0, 7) !== nextMonth) {
      monthlyEq.push(equity)
      monthlyBenchEq.push(benchEquity)
    }
  }
  if (ep) {
    episodes.push({
      peakDate: ep.peakDate,
      troughDate: ep.troughDate,
      recoveryDate: null,
      depth: ep.depth,
      daysToTrough: calDays(ep.peakDate, ep.troughDate),
      daysToRecover: null
    })
  }

  if (dailyReturns.length < 60) return fail('Too few simulated days — widen the date range.')

  // --- metrics ---
  const T = dailyReturns.length
  const { mean, std, skew, kurt } = moments(dailyReturns)
  const bm = moments(benchDaily)
  const srDaily = std > 0 ? mean / std : 0
  // CAGR on a CALENDAR basis (365.25-day years): with the gappy pre-2020 IEX
  // era, trading-day counting (T/252) undercounts elapsed time across the
  // gaps and silently inflates annualized returns.
  const years = Math.max(calDays(effectiveStart, effectiveEnd), 30) / 365.25
  const cagr = Math.pow(equity, 1 / years) - 1
  const benchCagr = Math.pow(benchEquity, 1 / years) - 1

  // Sortino: MAR = 0, FULL-SAMPLE denominator (the downside-only-count variant
  // is a known ratio-inflating implementation bug).
  let downSq = 0
  for (const r of dailyReturns) if (r < 0) downSq += r * r
  const downsideDev = Math.sqrt(downSq / T)
  const sortino = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(252) : 0

  // vs benchmark: OLS beta/alpha, tracking error, information ratio (sample
  // covariances; series are aligned by construction — same calendar loop).
  let beta: number | null = null
  let alphaAnnual: number | null = null
  let r2: number | null = null
  let trackingError: number | null = null
  let informationRatio: number | null = null
  {
    let cov = 0
    for (let i = 0; i < T; i++) cov += (dailyReturns[i] - mean) * (benchDaily[i] - bm.mean)
    cov /= T - 1
    const varB = (bm.std * bm.std * T) / (T - 1)
    const varS = (std * std * T) / (T - 1)
    if (varB > 0) {
      beta = cov / varB
      alphaAnnual = (mean - beta * bm.mean) * 252
      if (varS > 0) r2 = (cov * cov) / (varB * varS)
    }
    const active = dailyReturns.map((r, i) => r - benchDaily[i])
    const am = moments(active)
    const teDaily = am.std * Math.sqrt(T / (T - 1))
    if (teDaily > 0) {
      trackingError = teDaily * Math.sqrt(252)
      informationRatio = (am.mean / teDaily) * Math.sqrt(252)
    }
  }

  // Monthly series → hit rate, best/worst month, Morningstar capture ratios.
  const monthlyRet: number[] = []
  const monthlyBenchRet: number[] = []
  for (let i = 1; i < monthlyEq.length; i++) {
    monthlyRet.push(monthlyEq[i] / monthlyEq[i - 1] - 1)
    monthlyBenchRet.push(monthlyBenchEq[i] / monthlyBenchEq[i - 1] - 1)
  }
  const posMonths = monthlyRet.filter((r) => r > 0).length
  let upCapture: number | null = null
  let downCapture: number | null = null
  {
    const geo = (rs: number[]): number => Math.pow(rs.reduce((a, r) => a * (1 + r), 1), 1 / rs.length) - 1
    const upIdx = monthlyBenchRet.map((r, i) => (r > 0 ? i : -1)).filter((i) => i >= 0)
    const dnIdx = monthlyBenchRet.map((r, i) => (r < 0 ? i : -1)).filter((i) => i >= 0)
    if (upIdx.length > 0) {
      const gb = geo(upIdx.map((i) => monthlyBenchRet[i]))
      if (gb !== 0) upCapture = geo(upIdx.map((i) => monthlyRet[i])) / gb
    }
    if (dnIdx.length > 0) {
      const gb = geo(dnIdx.map((i) => monthlyBenchRet[i]))
      if (gb !== 0) downCapture = geo(dnIdx.map((i) => monthlyRet[i])) / gb
    }
  }

  // Historical daily VaR/CVaR (95%).
  const sortedDaily = [...dailyReturns].sort((a, b) => a - b)
  const var95 = quantileSorted(sortedDaily, 0.05)
  const worstK = Math.max(1, Math.floor(0.05 * T))
  const cvar95 = sortedDaily.slice(0, worstK).reduce((a, b) => a + b, 0) / worstK

  const trials = register
    ? registerTrial(config)
    : (getDb().prepare('SELECT COUNT(*) AS c FROM backtest_trials').get() as { c: number }).c
  const psr = psrAt(srDaily, 0, T, skew, kurt)
  const srVar = (1 - skew * srDaily + ((kurt - 1) / 4) * srDaily * srDaily) / Math.max(1, T - 1)
  const srStar =
    trials > 1 ? Math.sqrt(Math.max(0, srVar)) * ((1 - EULER) * normInv(1 - 1 / trials) + EULER * normInv(1 - 1 / (trials * Math.E))) : 0
  const dsr = psrAt(srDaily, srStar, T, skew, kurt)

  episodes.sort((a, b) => a.depth - b.depth)
  const longestUnderwaterDays = episodes.reduce((mx, e) => Math.max(mx, calDays(e.peakDate, e.recoveryDate ?? effectiveEnd)), 0)

  // Money-weighted outcome of the modeled cashflows (TWR = cagr is what the
  // tearsheet reports; MWR is what a brokerage statement would report).
  let contrib: ContributionResult | null = null
  if (wantDollarSim) {
    cashflows.push({ date: effectiveEnd, amount: dollarEq })
    contrib = {
      initialCapital: config.initialCapital,
      monthly: config.contribMonthly,
      months: contribCount,
      totalContributed: config.initialCapital + contribCount * config.contribMonthly,
      finalValue: dollarEq,
      benchFinalValue: benchDollar,
      // null = IRR outside the solvable range — shown as n/a, never silently
      // substituted with the time-weighted number.
      mwr: annualizedIrr(cashflows),
      twr: cagr
    }
  }

  const eligibleAtStart =
    config.strategy === 'momentum-12-1' ? eligibleCount(firstRebalance) : universe.filter((s) => hasHistoryBy(s, firstRebalance)).length
  const eligibleAtEnd = config.strategy === 'momentum-12-1' ? eligibleCount(endPos) : universe.filter((s) => hasHistoryBy(s, endPos)).length

  const metrics: BacktestMetrics = {
    cagr,
    vol: std * Math.sqrt(252),
    sharpe: srDaily * Math.sqrt(252),
    sortino,
    calmar: maxDrawdown < 0 ? cagr / Math.abs(maxDrawdown) : null,
    ulcer: Math.sqrt(ddSumSq / T),
    psr,
    dsr,
    trials,
    maxDrawdown,
    hitRateMonthly: monthlyRet.length > 0 ? posMonths / monthlyRet.length : 0,
    avgTurnover: rebalances.length > 0 ? turnoverSum / rebalances.length : 0,
    costDragAnnual: totalCost / years,
    tradingDays: T,
    skew,
    kurtExcess: kurt - 3,
    var95,
    cvar95,
    bestMonth: monthlyRet.length ? Math.max(...monthlyRet) : 0,
    worstMonth: monthlyRet.length ? Math.min(...monthlyRet) : 0,
    longestUnderwaterDays,
    timeUnderwaterPct: underwaterDays / T,
    beta,
    alphaAnnual,
    r2,
    trackingError,
    informationRatio,
    upCapture,
    downCapture,
    benchCagr,
    benchMaxDrawdown,
    benchSharpe: bm.std > 0 ? (bm.mean / bm.std) * Math.sqrt(252) : 0,
    benchVol: bm.std * Math.sqrt(252)
  }

  // --- warnings ---
  const isEtfOnly =
    config.strategy !== 'momentum-12-1' &&
    universe.every((s) => DISCOVERY_UNIVERSE.find((d) => d.symbol === s)?.etf === true)
  const warnings: string[] = []
  if (!isEtfOnly) {
    warnings.push(
      `SURVIVORSHIP BIAS: the universe is TODAY'S ${universe.length} symbols — companies that failed or delisted along the way are absent, which inflates historical returns for stock-picking strategies (the classic backtest sin; RESEARCH.md §4). Broad ETFs are much less affected.`
    )
  } else {
    warnings.push(
      'ETF-only portfolio: survivorship bias is mild here (index funds carry their losers), but the sample window still matters — see the other caveats.'
    )
  }
  warnings.push(
    fellBack.size > 0
      ? `PRICE-ONLY data used for ${[...fellBack].join(', ')} (dividend-adjusted history unavailable this run) — their returns understate total return.`
      : `Returns are TOTAL RETURN: bars are dividend- and split-adjusted (adjustment=all), so dividends are effectively reinvested — including the benchmark's.`
  )
  warnings.push(
    `Costs modeled at ${config.costBps} bps per side on every weight change; real spreads and slippage vary. Signals computed at a close are executed at that same close — a standard simplification that slightly flatters fast strategies.`
  )
  warnings.push(
    `Deflated Sharpe accounts for ${trials} strategy variant${trials === 1 ? '' : 's'} tried in this app so far — every new config you run raises the bar, as it should.`
  )
  if (config.strategy === 'ma-timing') {
    warnings.push(
      'This timing rule is included as a demonstration: Zakamulin (2014) showed MA-timing backtests are systematically overstated out-of-sample. Judge it with that lens.'
    )
  } else if (config.strategy === 'dual-momentum') {
    warnings.push(
      `Dual momentum (Antonacci GEM): 12-month absolute momentum gate on ${universe[0]} vs the ${CASH_PROXY} T-bill return${cashHurdleAvailable ? '' : ' (UNAVAILABLE this run — 0% hurdle used, which overstates time in equities)'}, then relative momentum between the two risk legs; defensive leg when the gate fails. Published GEM results use decades of data — this window is far too short to confirm or refute them.`
    )
  } else {
    warnings.push(
      'A backtest is a description of one past, not a forecast — expect live results materially worse than any backtest (RESEARCH.md §4).'
    )
  }
  if (clampedBy && constraining) {
    warnings.push(
      `Start clamped to ${effectiveStart}: ${constraining} is the binding constraint (inception or lookback warmup). Portfolio Visualizer silently does the same; here it's labeled.`
    )
  }
  if (adj.missing.length > 0) {
    warnings.push(`No Alpaca data for: ${adj.missing.join(', ')} — excluded from this run.`)
  }
  if (config.contribMonthly > 0) {
    warnings.push(
      `Contributions: $${config.contribMonthly.toLocaleString('en-US')} lands at the close of each month's first trading day, buys the current holdings pro-rata (no rebalancing effect), and pays the same ${config.costBps} bps. All tearsheet metrics above are TIME-WEIGHTED (cashflow-independent) — the DCA card is where contributions show up.`
    )
  }
  const lookbackNeeded = config.strategy === 'momentum-12-1' || config.strategy === 'dual-momentum'
  if (lookbackNeeded) {
    const lookbackSpanDays =
      (Date.parse(calendar[firstRebalance]) - Date.parse(calendar[Math.max(0, firstRebalance - MOM_LOOKBACK)])) / 86_400_000
    if (lookbackSpanDays > 500) {
      warnings.push(
        `Free IEX history is sparse before ~2020-07 (cache starts ${calendar[0]}) — the earliest rankings stretch their 12-month lookback across ~${Math.round(lookbackSpanDays)} calendar days, so treat the first year of the curve as approximate.`
      )
    }
  }
  // Bars-per-year sanity: pre-2020 IEX history has holes. CAGR uses calendar
  // time (immune), but daily-stat metrics treat the series as consecutive.
  const density = T / (years * 252)
  if (density < 0.9) {
    warnings.push(
      `Only ${Math.round(density * 100)}% of expected trading days have bars (pre-2020 IEX gaps) — volatility/Sharpe/VaR are computed over the days that exist. For clean numbers, start the backtest at 2021 or later.`
    )
  }

  const result: BacktestResult = {
    ...base,
    available: true,
    effectiveStart,
    effectiveEnd,
    points,
    metrics,
    rebalances: rebalances.slice(-13).reverse(),
    drawdowns: episodes.slice(0, 5),
    coverage: { eligibleAtStart, eligibleAtEnd, universeSize: universe.length },
    fellBack: [...fellBack],
    contrib,
    warnings
  }
  return { result, dailyReturns, benchDaily }
}

function calDays(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000))
}

export async function runBacktest(rawConfig: BacktestConfig): Promise<BacktestResult> {
  return (await simulate(rawConfig, true)).result
}

// --- stationary block bootstrap (Politis–Romano 1994) of the DAILY RETURNS:
// same returns, resampled order → how much did this particular ordering
// matter? Deterministic seed so re-runs reproduce. ---

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const BOOT_RESAMPLES = 1000
const BOOT_BLOCK = 10 // expected block length (days) — the standard rule of thumb for daily equity returns

export async function runBootstrap(rawConfig: BacktestConfig): Promise<BootstrapResult> {
  const { result, dailyReturns } = await simulate(rawConfig, false)
  const empty: BootstrapResult = {
    available: false,
    resamples: BOOT_RESAMPLES,
    blockLen: BOOT_BLOCK,
    tradingDays: dailyReturns.length,
    cagr: zeroPct(),
    maxDrawdown: zeroPct(),
    sharpe: zeroPct(),
    probNegative: 0,
    probWorseDD: 0,
    realized: { cagr: 0, maxDrawdown: 0, sharpe: 0 },
    notes: []
  }
  if (!result.available || !result.metrics) return { ...empty, message: result.message ?? 'Backtest unavailable.' }

  const n = dailyReturns.length
  // Same calendar-basis annualization as the realized CAGR — a resample is a
  // re-ordering of the same period, not a different span of time.
  const years = Math.max(calDays(result.effectiveStart ?? '', result.effectiveEnd ?? ''), 30) / 365.25
  const rnd = mulberry32(0xbf1e57ee ^ n)
  const p = 1 / BOOT_BLOCK
  const cagrs: number[] = []
  const dds: number[] = []
  const sharpes: number[] = []
  for (let b = 0; b < BOOT_RESAMPLES; b++) {
    let idx = Math.floor(rnd() * n)
    let eq = 1
    let pk = 1
    let dd = 0
    let sum = 0
    let sumSq = 0
    for (let t = 0; t < n; t++) {
      const r = dailyReturns[idx]
      eq *= 1 + r
      if (eq > pk) pk = eq
      else dd = Math.min(dd, eq / pk - 1)
      sum += r
      sumSq += r * r
      // Stationary bootstrap: with prob 1/L restart a block, else continue
      // consecutively with circular wraparound.
      idx = rnd() < p ? Math.floor(rnd() * n) : (idx + 1) % n
    }
    const m = sum / n
    const sd = Math.sqrt(Math.max(0, sumSq / n - m * m))
    cagrs.push(Math.pow(eq, 1 / years) - 1)
    dds.push(dd)
    sharpes.push(sd > 0 ? (m / sd) * Math.sqrt(252) : 0)
  }
  cagrs.sort((a, b) => a - b)
  dds.sort((a, b) => a - b)
  sharpes.sort((a, b) => a - b)
  const pct = (arr: number[]): BootstrapPercentiles => ({
    p5: quantileSorted(arr, 0.05),
    p25: quantileSorted(arr, 0.25),
    p50: quantileSorted(arr, 0.5),
    p75: quantileSorted(arr, 0.75),
    p95: quantileSorted(arr, 0.95)
  })
  const m = result.metrics
  return {
    available: true,
    resamples: BOOT_RESAMPLES,
    blockLen: BOOT_BLOCK,
    tradingDays: n,
    cagr: pct(cagrs),
    maxDrawdown: pct(dds),
    sharpe: pct(sharpes),
    probNegative: cagrs.filter((c) => c < 0).length / BOOT_RESAMPLES,
    probWorseDD: dds.filter((d) => d < m.maxDrawdown).length / BOOT_RESAMPLES,
    realized: { cagr: m.cagr, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe },
    notes: [
      `Stationary block bootstrap (Politis–Romano), ${BOOT_RESAMPLES} resamples of the strategy's own daily net returns, expected block ${BOOT_BLOCK} trading days (blocks preserve volatility clustering — IID shuffling would understate drawdown tails).`,
      'This measures PATH LUCK within the observed history: how different the outcome could look if the same returns had arrived in a different order. It is NOT an out-of-sample forecast — the resamples only ever contain days this backtest actually lived through.',
      'Max drawdown is the most path-dependent number in the tearsheet: compare the realized value against the p5–p95 spread before trusting it.',
      'The sample starts ~2020 — no 2008-style regime exists anywhere in these resamples.'
    ]
  }
}

function zeroPct(): BootstrapPercentiles {
  return { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 }
}

// --- current strategy targets (Phase 6 Self-Test / paper diff): what the
// strategy says to hold as of the latest cached bar. No trial registered, no
// simulation — just the weight function evaluated at the last position. ---

export async function currentTargets(rawConfig: BacktestConfig): Promise<{ symbol: string; weight: number }[] | null> {
  const norm = normalizeConfig(rawConfig)
  if (norm.error) return null
  const config = norm.config
  const { universe, fetchList } = strategyUniverse(config)
  await ensureAdjBars(fetchList)
  const bench = loadSeries(config.benchmark)
  if (!bench || bench.dates.length < 260) return null
  const series = new Map<string, Series>()
  for (const sym of fetchList) {
    const s = sym === config.benchmark ? bench : loadSeries(sym)
    if (s && s.dates.length >= 30) series.set(sym, s)
  }
  const calendar = bench.dates
  const pos = calendar.length - 1
  // Same gap tolerance as the engine: a symbol whose cache is a day or two
  // behind the benchmark's tip must not silently vanish from the targets.
  const nearIdx = (sym: string): number | null => {
    const s = series.get(sym)
    if (!s) return null
    const date = calendar[pos]
    const exact = s.index.get(date)
    if (exact != null) return exact
    if (s.dates[0] > date) return null
    let lo = 0
    let hi = s.dates.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s.dates[mid] <= date) lo = mid
      else hi = mid - 1
    }
    return calDays(s.dates[lo], date) > 10 ? null : lo
  }

  const w = new Map<string, number>()
  if (config.strategy === 'buy-hold') {
    w.set(universe[0], 1)
  } else if (config.strategy === 'fixed-allocation') {
    universe.forEach((sym, i) => w.set(sym, config.weights[i]))
  } else if (config.strategy === 'ma-timing') {
    const s = series.get(universe[0])
    const i = nearIdx(universe[0])
    if (s && i != null && i >= 199) {
      let sum = 0
      for (let k = i - 199; k <= i; k++) sum += s.closes[k]
      if (s.closes[i] > sum / 200) w.set(universe[0], 1)
    }
  } else {
    const retN = (sym: string, lookback: number, skip: number): number | null => {
      const s = series.get(sym)
      const i = nearIdx(sym)
      if (s == null || i == null || i < lookback) return null
      const start = s.closes[i - lookback]
      return start > 0 ? s.closes[i - skip] / start - 1 : null
    }
    if (config.strategy === 'dual-momentum') {
      const [risk1, risk2, defensive] = config.symbols.length === 3 ? config.symbols : DUAL_DEFAULTS
      const r1 = retN(risk1, DUAL_LOOKBACK, 0)
      if (r1 != null) {
        const hurdle = retN(CASH_PROXY, DUAL_LOOKBACK, 0) ?? 0
        if (r1 > hurdle) {
          const r2 = retN(risk2, DUAL_LOOKBACK, 0)
          w.set(r2 != null && r2 > r1 ? risk2 : risk1, 1)
        } else {
          w.set(defensive, 1)
        }
      }
    } else {
      const ranked = universe
        .map((sym) => ({ sym, m: retN(sym, MOM_LOOKBACK, MOM_SKIP) }))
        .filter((x): x is { sym: string; m: number } => x.m != null)
        .sort((a, b) => b.m - a.m)
        .slice(0, config.topN)
      for (const { sym } of ranked) w.set(sym, 1 / Math.max(1, ranked.length))
    }
  }
  return [...w.entries()].map(([symbol, weight]) => ({ symbol, weight }))
}
