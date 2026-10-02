import { getDb } from './db'
import type { EdgarDerived } from './edgar'
import type { BuffettScore, LynchCheck, MetricScore, PillarScore } from '../shared/types'

// Buffett Engine v1 (RESEARCH.md §1): pillar scores as PERCENTILES within the
// scoring universe — never absolute claims. Evidence basis: Buffett's Alpha
// (cheap + safe + high-quality), QMJ pillar structure, QARP composite
// (~65% quality / 35% value), AAII's Lynch codification.
//
// FMP's stable API renames fields over time, so every metric is extracted with
// a fallback key list and computed defensively. Symbols without crawled
// fundamentals score null and are reported as "not yet crawled".

interface RawFundamentals {
  profile: Record<string, unknown> | null
  ratios: Record<string, unknown> | null
  keyMetrics: Record<string, unknown> | null
  income: Record<string, unknown>[] | null
}

interface SymbolMetrics {
  symbol: string
  dataSource: 'fmp' | 'fallback'
  [k: string]: number | string | null
}

const METRIC_DEFS: {
  key: string
  label: string
  pillar: 'value' | 'quality' | 'growth' | 'safety'
  higherIsBetter: boolean
}[] = [
  { key: 'earningsYield', label: 'Earnings yield (TTM)', pillar: 'value', higherIsBetter: true },
  { key: 'fcfYield', label: 'FCF yield (TTM)', pillar: 'value', higherIsBetter: true },
  { key: 'bookYield', label: 'Book/price', pillar: 'value', higherIsBetter: true },
  { key: 'roe', label: 'Return on equity', pillar: 'quality', higherIsBetter: true },
  { key: 'roic', label: 'Return on invested capital', pillar: 'quality', higherIsBetter: true },
  { key: 'grossMargin', label: 'Gross margin', pillar: 'quality', higherIsBetter: true },
  { key: 'netMargin', label: 'Net margin', pillar: 'quality', higherIsBetter: true },
  { key: 'marginStability', label: 'Margin stability (5y)', pillar: 'quality', higherIsBetter: true },
  { key: 'revenueCagr', label: 'Revenue CAGR (5y)', pillar: 'growth', higherIsBetter: true },
  { key: 'epsCagr', label: 'EPS CAGR (5y)', pillar: 'growth', higherIsBetter: true },
  { key: 'beta', label: 'Beta (low = safe)', pillar: 'safety', higherIsBetter: false },
  { key: 'volatility', label: 'Volatility 1y (low = safe)', pillar: 'safety', higherIsBetter: false },
  { key: 'debtToEquity', label: 'Debt/equity (low = safe)', pillar: 'safety', higherIsBetter: false }
]

function num(obj: Record<string, unknown> | null, keys: string[]): number | null {
  if (!obj) return null
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function firstRecord(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) return (payload[0] as Record<string, unknown>) ?? null
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>
  return null
}

function latestPayload(symbol: string, source: string): unknown {
  const row = getDb()
    .prepare('SELECT payload FROM fundamentals_snapshots WHERE symbol = ? AND source = ? ORDER BY fetched_at DESC, id DESC LIMIT 1')
    .get(symbol, source) as { payload: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.payload)
  } catch {
    return null
  }
}

function loadFundamentals(symbol: string): RawFundamentals {
  const incomeRaw = latestPayload(symbol, 'fmp:income-annual')
  return {
    profile: firstRecord(latestPayload(symbol, 'fmp:profile')),
    ratios: firstRecord(latestPayload(symbol, 'fmp:ratios-ttm')),
    keyMetrics: firstRecord(latestPayload(symbol, 'fmp:key-metrics-ttm')),
    // Empty arrays are recorded crawl attempts with no data — treat as absent.
    income: Array.isArray(incomeRaw) && incomeRaw.length > 0 ? (incomeRaw as Record<string, unknown>[]) : null
  }
}

function cagr(latest: number | null, oldest: number | null, years: number): number | null {
  if (latest == null || oldest == null || oldest <= 0 || latest <= 0 || years <= 0) return null
  return Math.pow(latest / oldest, 1 / years) - 1
}

function stdev(xs: number[]): number | null {
  if (xs.length < 3) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1))
}

// Beta vs SPY and annualized volatility from cached daily bars (~1 year).
function priceRisk(symbol: string): { beta: number | null; volatility: number | null } {
  const db = getDb()
  const rows = (sym: string): { date: string; close: number }[] =>
    db
      .prepare(
        "SELECT date, close FROM daily_bars WHERE symbol = ? AND date >= date('now', '-380 days') ORDER BY date ASC"
      )
      .all(sym) as { date: string; close: number }[]
  const own = rows(symbol)
  if (own.length < 60) return { beta: null, volatility: null }

  const returns = (list: { date: string; close: number }[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].close > 0) m.set(list[i].date, list[i].close / list[i - 1].close - 1)
    }
    return m
  }
  const ownRet = returns(own)
  const vol = stdev([...ownRet.values()])
  const volatility = vol != null ? vol * Math.sqrt(252) : null

  const spy = rows('SPY')
  if (spy.length < 60) return { beta: null, volatility }
  const spyRet = returns(spy)
  const pairs: [number, number][] = []
  for (const [d, r] of ownRet) {
    const s = spyRet.get(d)
    if (s != null) pairs.push([r, s])
  }
  if (pairs.length < 60) return { beta: null, volatility }
  const meanX = pairs.reduce((a, p) => a + p[1], 0) / pairs.length
  const meanY = pairs.reduce((a, p) => a + p[0], 0) / pairs.length
  let cov = 0
  let varX = 0
  for (const [y, x] of pairs) {
    cov += (x - meanX) * (y - meanY)
    varX += (x - meanX) * (x - meanX)
  }
  return { beta: varX > 0 ? cov / varX : null, volatility }
}

// Latest cached close for EDGAR-based valuation yields (watchlist symbols have bars).
function latestClose(symbol: string): number | null {
  const row = getDb()
    .prepare('SELECT close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT 1')
    .get(symbol) as { close: number } | undefined
  return row?.close ?? null
}

// Fallback metrics for symbols FMP's free tier gates: SEC EDGAR annual (10-K)
// series for as-filed statement history, merged with Finnhub basic financials
// for fresh TTM ratios. EDGAR is fiscal-year rather than TTM and Finnhub uses
// PERCENT units for margins/ROE/growth (converted here) — comparable enough for
// percentile ranking, disclosed via the fallback badge in the UI. Metrics whose
// definition can't be matched faithfully (ROIC) stay null.
function extractFallback(symbol: string): SymbolMetrics | null {
  const raw = latestPayload(symbol, 'edgar:derived') as EdgarDerived | null
  const fh = firstRecord(latestPayload(symbol, 'finnhub:metrics'))
  if ((!raw || !Array.isArray(raw.annual) || raw.annual.length === 0) && !fh) return null

  // Finnhub values (percent → ratio where applicable).
  const fhPct = (keys: string[]): number | null => {
    const v = num(fh, keys)
    return v != null ? v / 100 : null
  }
  const fhPe = num(fh, ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM', 'peAnnual'])
  const fhPb = num(fh, ['pbQuarterly', 'pbAnnual', 'pb'])
  const fhDeRaw = num(fh, ['totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual'])
  const fhRoe = fhPct(['roeTTM', 'roeRfy'])
  const fhGrossMargin = fhPct(['grossMarginTTM', 'grossMarginAnnual'])
  const fhNetMargin = fhPct(['netProfitMarginTTM', 'netProfitMarginAnnual'])
  const fhRevGrowth = fhPct(['revenueGrowth5Y'])
  const fhEpsGrowth = fhPct(['epsGrowth5Y'])
  const fhDivYield = fhPct(['currentDividendYieldTTM', 'dividendYieldIndicatedAnnual'])
  const fhBeta = num(fh, ['beta'])

  // EDGAR annual series values.
  let eRevenueCagr: number | null = null
  let eEpsCagr: number | null = null
  let eMarginStability: number | null = null
  let eNetMargin: number | null = null
  let eGrossMargin: number | null = null
  let eRoe: number | null = null
  let eEarningsYield: number | null = null
  let eBookYield: number | null = null
  let eFcfYield: number | null = null
  if (raw && Array.isArray(raw.annual) && raw.annual.length > 0) {
    const annual = [...raw.annual].sort((a, b) => a.end.localeCompare(b.end))
    const latest = annual[annual.length - 1]
    const oldest = annual[0]
    const years = annual.length - 1
    eRevenueCagr = cagr(latest.revenue, oldest.revenue, years)
    eEpsCagr = cagr(latest.epsDiluted, oldest.epsDiluted, years)
    const margins: number[] = []
    for (const yr of annual) {
      if (yr.revenue && yr.revenue > 0 && yr.netIncome != null) margins.push(yr.netIncome / yr.revenue)
    }
    const s = stdev(margins)
    eMarginStability = s != null ? -s : null
    eNetMargin = latest.revenue && latest.revenue > 0 && latest.netIncome != null ? latest.netIncome / latest.revenue : null
    eGrossMargin = latest.revenue && latest.revenue > 0 && latest.grossProfit != null ? latest.grossProfit / latest.revenue : null
    eRoe = latest.equity && latest.equity > 0 && latest.netIncome != null ? latest.netIncome / latest.equity : null
    const price = latestClose(symbol)
    const marketCap = price != null && raw.sharesOutstanding ? price * raw.sharesOutstanding : null
    eEarningsYield = price != null && price > 0 && latest.epsDiluted != null ? latest.epsDiluted / price : null
    eBookYield = marketCap && marketCap > 0 && latest.equity != null && latest.equity > 0 ? latest.equity / marketCap : null
    const fcf = latest.operatingCashFlow != null ? latest.operatingCashFlow - (latest.capex ?? 0) : null
    eFcfYield = marketCap && marketCap > 0 && fcf != null ? fcf / marketCap : null
  }

  const risk = priceRisk(symbol)
  // Prefer Finnhub for TTM ratios (fresher), EDGAR for statement history.
  const earningsYield = (fhPe != null && fhPe > 0 ? 1 / fhPe : null) ?? eEarningsYield
  const pe = fhPe != null && fhPe > 0 ? fhPe : eEarningsYield != null && eEarningsYield > 0 ? 1 / eEarningsYield : null
  const negativeEquity = fhDeRaw != null && fhDeRaw < 0

  return {
    symbol,
    dataSource: 'fallback',
    earningsYield,
    fcfYield: eFcfYield,
    bookYield: (fhPb != null && fhPb > 0 ? 1 / fhPb : null) ?? eBookYield,
    roe: negativeEquity ? null : (fhRoe ?? eRoe),
    roic: null,
    grossMargin: fhGrossMargin ?? eGrossMargin,
    netMargin: fhNetMargin ?? eNetMargin,
    marginStability: eMarginStability,
    revenueCagr: eRevenueCagr ?? fhRevGrowth,
    epsCagr: eEpsCagr ?? fhEpsGrowth,
    beta: fhBeta ?? risk.beta,
    volatility: risk.volatility,
    debtToEquity: negativeEquity ? null : fhDeRaw,
    pe,
    divYield: fhDivYield
  }
}

function extractMetrics(symbol: string): SymbolMetrics | null {
  const f = loadFundamentals(symbol)
  // A profile alone (the state FMP free-tier-gated symbols end up in after the
  // first call 402s) is not scoreable — require real statement/ratio data, and
  // fall back to SEC EDGAR + Finnhub data when FMP has nothing.
  if (!f.ratios && !f.keyMetrics && !f.income) return extractFallback(symbol)

  const pe = num(f.ratios, ['priceToEarningsRatioTTM', 'peRatioTTM', 'priceEarningsRatioTTM'])
  const pb = num(f.ratios, ['priceToBookRatioTTM', 'pbRatioTTM', 'priceToBookValueRatioTTM'])
  const earningsYield =
    num(f.keyMetrics, ['earningsYieldTTM']) ?? (pe != null && pe > 0 ? 1 / pe : null)
  const fcfYield = num(f.keyMetrics, ['freeCashFlowYieldTTM', 'fcfYieldTTM'])
  const bookYield = pb != null && pb > 0 ? 1 / pb : null

  // Negative D/E means negative shareholder equity (e.g. from buybacks) — the
  // MOST leveraged balance sheet, not the least. Without the guard it would rank
  // as the safest (inverted percentile), and ROE flips sign meaninglessly too.
  const deRaw = num(f.ratios, ['debtToEquityRatioTTM', 'debtEquityRatioTTM'])
  const negativeEquity = deRaw != null && deRaw < 0
  const debtToEquity = negativeEquity ? null : deRaw
  const roeRaw = num(f.ratios, ['returnOnEquityTTM']) ?? num(f.keyMetrics, ['returnOnEquityTTM', 'roeTTM'])
  const roe = negativeEquity ? null : roeRaw
  const roic = num(f.keyMetrics, ['returnOnInvestedCapitalTTM', 'roicTTM']) ?? num(f.ratios, ['returnOnCapitalEmployedTTM'])
  const grossMargin = num(f.ratios, ['grossProfitMarginTTM'])
  const netMargin = num(f.ratios, ['netProfitMarginTTM', 'netIncomeMarginTTM'])
  // NOTE: deliberately excludes 'dividendYieldPercentageTTM' — that field is in
  // percent units while these are ratios; mixing them would corrupt the PEG math.
  const divYield = num(f.ratios, ['dividendYieldTTM', 'dividendYielTTM'])

  let revenueCagr: number | null = null
  let epsCagr: number | null = null
  let marginStability: number | null = null
  if (f.income && f.income.length >= 3) {
    // FMP returns newest first.
    const newest = f.income[0]
    const oldest = f.income[f.income.length - 1]
    const years = f.income.length - 1
    revenueCagr = cagr(num(newest, ['revenue']), num(oldest, ['revenue']), years)
    epsCagr = cagr(num(newest, ['epsDiluted', 'epsdiluted', 'eps']), num(oldest, ['epsDiluted', 'epsdiluted', 'eps']), years)
    const margins: number[] = []
    for (const yr of f.income) {
      const rev = num(yr, ['revenue'])
      const ni = num(yr, ['netIncome'])
      if (rev && rev > 0 && ni != null) margins.push(ni / rev)
    }
    const s = stdev(margins)
    marginStability = s != null ? -s : null // less variation = better
  }

  const risk = priceRisk(symbol)
  const beta = num(f.profile, ['beta']) ?? risk.beta

  return {
    symbol,
    dataSource: 'fmp',
    earningsYield,
    fcfYield,
    bookYield,
    roe,
    roic,
    grossMargin,
    netMargin,
    marginStability,
    revenueCagr,
    epsCagr,
    beta,
    volatility: risk.volatility,
    debtToEquity,
    pe,
    divYield
  }
}

// ---- universe cache (rebuilt at most every 10 minutes) ----
let cache: { at: number; metrics: SymbolMetrics[]; universeSize: number } | null = null

function universeMetrics(): { metrics: SymbolMetrics[]; universeSize: number } {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache
  const symbols = (
    getDb()
      .prepare(
        `SELECT DISTINCT symbol FROM fundamentals_snapshots WHERE source != 'fmp:unavailable'`
      )
      .all() as { symbol: string }[]
  ).map((r) => r.symbol)
  const universeSize = (
    getDb().prepare('SELECT COUNT(*) c FROM (SELECT symbol FROM universe UNION SELECT symbol FROM watchlist)').get() as {
      c: number
    }
  ).c
  const metrics = symbols.map(extractMetrics).filter((m): m is SymbolMetrics => m !== null)
  cache = { at: Date.now(), metrics, universeSize }
  return cache
}

export function invalidateScoreCache(): void {
  cache = null
}

// Read-through for the valuation module: one symbol's extracted metrics from
// the shared 10-minute universe cache. null = not crawled/scoreable yet.
export function metricsForSymbol(symbol: string): {
  fcfYield: number | null
  earningsYield: number | null
  revenueCagr: number | null
  epsCagr: number | null
  dataSource: 'fmp' | 'fallback'
} | null {
  const m = universeMetrics().metrics.find((x) => x.symbol === symbol.toUpperCase())
  if (!m) return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    fcfYield: num(m.fcfYield),
    earningsYield: num(m.earningsYield),
    revenueCagr: num(m.revenueCagr),
    epsCagr: num(m.epsCagr),
    dataSource: m.dataSource
  }
}

function percentile(values: { symbol: string; v: number }[], symbol: string, higherIsBetter: boolean): number | null {
  if (values.length < 5) return null // too few peers for a meaningful rank
  const target = values.find((x) => x.symbol === symbol)
  if (!target) return null
  const below = values.filter((x) => x.v < target.v).length
  const equal = values.filter((x) => x.v === target.v).length
  const pct = ((below + equal / 2) / values.length) * 100
  return higherIsBetter ? pct : 100 - pct
}

// QARP leaderboard across every symbol with crawled fundamentals — the
// Phase 8 leftover. Cheap: reuses the 10-minute universe cache, and each
// score is a percentile pass over in-memory metrics.
export function qarpLeaderboard(): import('../shared/types').QarpLeaderboard {
  const { metrics, universeSize } = universeMetrics()
  const rows = metrics
    .map((m) => {
      const s = scoreSymbol(m.symbol)
      return {
        symbol: m.symbol,
        qarp: s.qarp,
        quality: s.pillars.quality.percentile,
        value: s.pillars.value.percentile,
        dataSource: s.dataSource
      }
    })
    .filter((r) => r.qarp != null)
    .sort((a, b) => (b.qarp ?? 0) - (a.qarp ?? 0))
  return {
    available: rows.length >= 5,
    rows: rows.slice(0, 15),
    scoredCount: rows.length,
    universeSize,
    asOf: new Date().toISOString(),
    message:
      rows.length >= 5
        ? undefined
        : `Only ${rows.length} symbols have enough crawled fundamentals to rank — the rolling crawl fills this in over days.`
  }
}

export function scoreSymbol(symbol: string): BuffettScore {
  const sym = symbol.toUpperCase()
  const { metrics, universeSize } = universeMetrics()
  const scoredAt = new Date().toISOString()
  const own = metrics.find((m) => m.symbol === sym)

  const base: Omit<BuffettScore, 'pillars' | 'qarp' | 'lynch'> = {
    symbol: sym,
    scoredAt,
    universeScored: metrics.length,
    universeSize,
    caveats: [
      `Percentiles are relative to the ${metrics.length} of ${universeSize} universe symbols crawled so far — scores firm up as the rolling crawl fills in.`,
      'Evidence shows factor screens explain Buffett-style returns historically; this is a lens, not a prediction (see RESEARCH.md §1).'
    ],
    available: own != null,
    dataSource: own?.dataSource
  }

  if (!own) {
    return {
      ...base,
      pillars: {
        value: { percentile: null, metrics: [] },
        quality: { percentile: null, metrics: [] },
        growth: { percentile: null, metrics: [] },
        safety: { percentile: null, metrics: [] }
      },
      qarp: null,
      lynch: [],
      message:
        'No fundamentals crawled for this symbol yet (ETF, not yet reached by the rolling crawl, or gated on the FMP free tier).'
    }
  }

  const pillars: BuffettScore['pillars'] = {
    value: { percentile: null, metrics: [] },
    quality: { percentile: null, metrics: [] },
    growth: { percentile: null, metrics: [] },
    safety: { percentile: null, metrics: [] }
  }

  for (const def of METRIC_DEFS) {
    const values = metrics
      .map((m) => ({ symbol: m.symbol, v: m[def.key] }))
      .filter((x): x is { symbol: string; v: number } => typeof x.v === 'number' && Number.isFinite(x.v))
    const pct = percentile(values, sym, def.higherIsBetter)
    const entry: MetricScore = {
      key: def.key,
      label: def.label,
      value: typeof own[def.key] === 'number' ? (own[def.key] as number) : null,
      percentile: pct
    }
    pillars[def.pillar].metrics.push(entry)
  }

  for (const p of Object.values(pillars) as PillarScore[]) {
    const pcts = p.metrics.map((m) => m.percentile).filter((v): v is number => v != null)
    p.percentile = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null
  }

  // QARP: majority weight on quality (published optimum ~63-70% — RESEARCH.md §1.2).
  const qarp =
    pillars.quality.percentile != null && pillars.value.percentile != null
      ? 0.65 * pillars.quality.percentile + 0.35 * pillars.value.percentile
      : null

  const lynch = lynchChecks(own)

  return { ...base, pillars, qarp, lynch }
}

function lynchChecks(m: SymbolMetrics): LynchCheck[] {
  const checks: LynchCheck[] = []
  const pe = typeof m.pe === 'number' ? m.pe : null
  const eps = typeof m.epsCagr === 'number' ? m.epsCagr : null
  const div = typeof m.divYield === 'number' ? m.divYield : null

  if (pe != null && pe > 0 && eps != null) {
    const denom = eps * 100 + (div ?? 0) * 100
    if (denom > 0) {
      const peg = pe / denom
      checks.push({
        label: 'Dividend-adjusted PEG ≤ 0.50',
        verdict: peg <= 0.5 ? 'pass' : 'fail',
        detail: `PEG ${peg.toFixed(2)} = P/E ${pe.toFixed(1)} ÷ (EPS growth ${(eps * 100).toFixed(1)}% + div yield ${((div ?? 0) * 100).toFixed(1)}%)${peg > 1 ? ' — Lynch called >1.0 poor' : ''}`
      })
    } else {
      checks.push({ label: 'Dividend-adjusted PEG ≤ 0.50', verdict: 'unknown', detail: 'Negative or zero growth — PEG undefined' })
    }
  } else {
    checks.push({ label: 'Dividend-adjusted PEG ≤ 0.50', verdict: 'unknown', detail: 'Missing P/E or 5y EPS growth' })
  }

  if (eps != null) {
    const g = eps * 100
    checks.push({
      label: 'Growth 20–25% sweet spot, >50% excluded',
      verdict: g > 50 ? 'fail' : g >= 15 && g <= 30 ? 'pass' : 'unknown',
      detail:
        g > 50
          ? `5y EPS growth ${g.toFixed(0)}% — AAII/Lynch exclude >50% as unsustainable (hot-stock risk)`
          : `5y EPS growth ${g.toFixed(1)}% (Lynch's target band is moderate 20–25%)`
    })
  } else {
    checks.push({ label: 'Growth 20–25% sweet spot, >50% excluded', verdict: 'unknown', detail: 'Missing 5y EPS history' })
  }

  checks.push({
    label: 'P/E below own 5y average and industry median',
    verdict: 'unknown',
    detail: 'Needs 5y P/E history and industry medians — planned once enough point-in-time data accumulates'
  })
  return checks
}
