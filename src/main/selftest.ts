import { getDb, logJob } from './db'
import { configHash, currentTargets, normalizeConfig, runBacktest, strategyLabel, strategyUniverse } from './backtest'
import type {
  BacktestConfig,
  BacktestPoint,
  SelfTestEntry,
  SelfTestExpectation,
  SelfTestReport,
  StrategyTarget
} from '../shared/types'

// Phase 6 Self-Test (PLAN.md §3): "the app grades itself." Each canonical
// strategy config is ANCHORED the first time this report runs: the backtest
// expectation (CAGR/Sharpe/DSR/maxDD over history to that day) is frozen in
// selftest_anchors. From then on, the same engine re-runs and the report
// rebases everything to the anchor date — only data that arrived AFTER the
// expectation was formed counts, which is genuine out-of-sample for the
// app's own signal families. The research prediction (RESEARCH.md §4.1):
// forward runs worse. Watching that happen, with numbers, is the point.

// Expectations anchored on the DENSE data era (2021+): pre-2020 IEX history
// has gaps that distort daily-stat metrics, and momentum's lookback clamps it
// there anyway — this keeps all four expectations on comparable footing.
const CANONICAL: BacktestConfig[] = [
  { strategy: 'momentum-12-1', topN: 5, costBps: 5, start: '2021-01-01', end: '', symbols: [], weights: [], benchmark: 'SPY', rebalance: 'monthly', initialCapital: 10_000, contribMonthly: 0 },
  { strategy: 'ma-timing', topN: 5, costBps: 5, start: '2021-01-01', end: '', symbols: [], weights: [], benchmark: 'SPY', rebalance: 'monthly', initialCapital: 10_000, contribMonthly: 0 },
  { strategy: 'dual-momentum', topN: 5, costBps: 5, start: '2021-01-01', end: '', symbols: [], weights: [], benchmark: 'SPY', rebalance: 'monthly', initialCapital: 10_000, contribMonthly: 0 },
  { strategy: 'buy-hold', topN: 5, costBps: 5, start: '2021-01-01', end: '', symbols: [], weights: [], benchmark: 'SPY', rebalance: 'monthly', initialCapital: 10_000, contribMonthly: 0 }
]

interface AnchorRow {
  config_hash: string
  config_json: string
  anchor_date: string
  expectation_json: string
}

async function ensureAnchor(rawConfig: BacktestConfig): Promise<AnchorRow | null> {
  const db = getDb()
  // The anchor LOOKUP key is the CANONICAL config (symbols: []) — it must not
  // depend on the live watchlist, or any watchlist edit would orphan the
  // anchor and silently restart the out-of-sample experiment with a fresh
  // in-sample expectation. The pinned universe lives in config_json only.
  const hash = configHash(normalizeConfig(rawConfig).config)
  const existing = db.prepare('SELECT * FROM selftest_anchors WHERE config_hash = ?').get(hash) as AnchorRow | undefined
  if (existing) return existing
  // FREEZE the universe at anchor time: momentum's empty symbol list resolves
  // against the live watchlist, which drifts — an anchor must pin the exact
  // symbols its expectation was computed over, so every forward run and the
  // targets panel test the same portfolio rule.
  const { universe } = strategyUniverse(normalizeConfig(rawConfig).config)
  const config: BacktestConfig = { ...rawConfig, symbols: universe }
  // Migration: earlier anchor rows were keyed by the pinned-universe hash —
  // if one matches today's resolution, re-key it instead of re-anchoring.
  const legacyHash = configHash(config)
  const legacy = db.prepare('SELECT * FROM selftest_anchors WHERE config_hash = ?').get(legacyHash) as AnchorRow | undefined
  if (legacy) {
    db.prepare('UPDATE selftest_anchors SET config_hash = ? WHERE config_hash = ?').run(hash, legacyHash)
    return { ...legacy, config_hash: hash }
  }
  const result = await runBacktest(config)
  if (!result.available || !result.metrics || !result.effectiveEnd) {
    return null // not enough data yet — try again on a later open
  }
  if (result.fellBack.length > 0) {
    // Price-only fallback data would freeze a distorted expectation forever —
    // wait for a run where the full adjusted history was available.
    logJob('selftest', 'skipped', `${config.strategy}: not anchoring on price-only fallback (${result.fellBack.join(',')})`)
    return null
  }
  const expectation: SelfTestExpectation = {
    cagr: result.metrics.cagr,
    sharpe: result.metrics.sharpe,
    dsr: result.metrics.dsr,
    maxDrawdown: result.metrics.maxDrawdown
  }
  const row: AnchorRow = {
    config_hash: hash,
    config_json: JSON.stringify(config),
    anchor_date: result.effectiveEnd,
    expectation_json: JSON.stringify(expectation)
  }
  db.prepare(
    'INSERT OR IGNORE INTO selftest_anchors(config_hash, config_json, anchor_date, expectation_json) VALUES (?, ?, ?, ?)'
  ).run(row.config_hash, row.config_json, row.anchor_date, row.expectation_json)
  logJob('selftest', 'ok', `anchored ${config.strategy} @ ${row.anchor_date}`)
  return row
}

// Forward stats STRICTLY after the anchor date. The engine invests at the
// month-end on/before its start date (so signals only use data ≤ that day),
// which would leak up to a month of in-sample days into the "forward" window
// — so everything is rebased to the anchor-date point instead.
function rebaseForward(points: BacktestPoint[], anchorDate: string): {
  totalReturn: number
  cagr: number
  sharpe: number
  maxDrawdown: number
  benchTotalReturn: number
  benchMaxDrawdown: number
  forwardDays: number
} | null {
  let a = -1
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= anchorDate) {
      a = i
      break
    }
  }
  if (a < 0 || points.length - 1 - a < 60) return null
  const anchor = points[a]
  const last = points[points.length - 1]
  let peak = anchor.equity
  let bPeak = anchor.benchmark
  let maxDD = 0
  let bMaxDD = 0
  let sum = 0
  let sumSq = 0
  const n = points.length - 1 - a
  for (let i = a + 1; i < points.length; i++) {
    const r = points[i].equity / points[i - 1].equity - 1
    sum += r
    sumSq += r * r
    peak = Math.max(peak, points[i].equity)
    maxDD = Math.min(maxDD, points[i].equity / peak - 1)
    bPeak = Math.max(bPeak, points[i].benchmark)
    bMaxDD = Math.min(bMaxDD, points[i].benchmark / bPeak - 1)
  }
  const mean = sum / n
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  const years = Math.max(1, Math.round((Date.parse(last.date) - Date.parse(anchor.date)) / 86_400_000)) / 365.25
  return {
    totalReturn: last.equity / anchor.equity - 1,
    cagr: Math.pow(last.equity / anchor.equity, 1 / years) - 1,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    maxDrawdown: maxDD,
    benchTotalReturn: last.benchmark / anchor.benchmark - 1,
    benchMaxDrawdown: bMaxDD,
    forwardDays: n
  }
}

async function buildEntry(config: BacktestConfig, anchor: AnchorRow): Promise<SelfTestEntry> {
  const expectation = JSON.parse(anchor.expectation_json) as SelfTestExpectation
  const calendarDaysElapsed = Math.max(0, Math.round((Date.now() - Date.parse(anchor.anchor_date)) / 86_400_000))
  // Forward trading days that exist after the anchor (benchmark calendar).
  const tradingDaysForward = (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM daily_bars_adj WHERE symbol = ? AND date > ?')
      .get(config.benchmark || 'SPY', anchor.anchor_date) as { c: number }
  ).c

  const base: SelfTestEntry = {
    strategy: config.strategy,
    label: strategyLabel(normalizeConfig(config).config),
    anchorDate: anchor.anchor_date,
    calendarDaysElapsed,
    tradingDaysForward,
    expectation,
    forward: null,
    benchForward: null,
    status: 'accruing',
    note: `Forward window: ${tradingDaysForward} trading days. Metrics unlock at 60; under ~1 year they are mostly noise — the comparison gets honest slowly.`
  }
  if (tradingDaysForward < 60) return base

  const fwd = await runBacktest({ ...config, start: anchor.anchor_date })
  if (!fwd.available || fwd.points.length === 0) return base
  const rb = rebaseForward(fwd.points, anchor.anchor_date)
  if (!rb) return base
  return {
    ...base,
    forward: {
      totalReturn: rb.totalReturn,
      cagr: rb.cagr,
      sharpe: rb.sharpe,
      maxDrawdown: rb.maxDrawdown
    },
    benchForward: {
      totalReturn: rb.benchTotalReturn,
      maxDrawdown: rb.benchMaxDrawdown
    },
    status: 'tracking',
    note:
      rb.forwardDays < 252
        ? `Forward window: ${rb.forwardDays} trading days — still short; expect the numbers to swing.`
        : `Forward window: ${rb.forwardDays} trading days.`
  }
}

export async function getSelfTest(): Promise<SelfTestReport> {
  const asOf = new Date().toISOString()
  const entries: SelfTestEntry[] = []
  const targets: StrategyTarget[] = []
  let anyAnchor = false
  for (const canonical of CANONICAL) {
    try {
      const anchor = await ensureAnchor(canonical)
      if (!anchor) continue
      anyAnchor = true
      // Everything downstream uses the FROZEN config (pinned universe).
      const config = JSON.parse(anchor.config_json) as BacktestConfig
      entries.push(await buildEntry(config, anchor))
      const holdings = await currentTargets(config)
      if (holdings) {
        targets.push({
          strategy: config.strategy,
          label: strategyLabel(normalizeConfig(config).config),
          holdings: holdings.sort((a, b) => b.weight - a.weight),
          asOf
        })
      }
    } catch (e) {
      logJob('selftest', 'error', `${canonical.strategy}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!anyAnchor) {
    return {
      available: false,
      message: 'Self-Test needs cached price history first — run a backtest once (or let the collector run), then reopen.',
      asOf,
      entries: [],
      targets: [],
      disclosures: []
    }
  }
  return {
    available: true,
    asOf,
    entries,
    targets,
    disclosures: [
      'Expectations were FROZEN on each strategy\'s anchor date (universe pinned as of that day); forward numbers are rebased to the anchor point and use only data that arrived afterwards — true out-of-sample for the app\'s signals. The research prediction is that forward runs worse than the backtest (RESEARCH.md §4.1); the gap you see here is that prediction being tested.',
      'The backtest expectation is survivor-biased (today\'s universe); the forward window is not. That alone should drag forward results below expectation for stock-picking strategies.',
      'Targets are what each strategy says to hold as of the latest cached close. Following them in the paper account is manual and optional — the Self-Test tracks the MODEL, whether or not any account trades it.'
    ]
  }
}
