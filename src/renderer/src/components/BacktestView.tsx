import { useEffect, useMemo, useRef, useState } from 'react'
import { ColorType, createChart, type IChartApi, type Time } from 'lightweight-charts'
import type { BacktestConfig, BacktestResult, BootstrapResult, RebalanceFreq, StrategyKind } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T } from '../theme'

// Backtester v2 UI: custom tickers/weights/dates/benchmark plus the analytics
// pro tools agree on (Portfolio Visualizer / quantstats consensus, researched
// 2026-07): underwater chart, monthly-returns heatmap, drawdown table,
// rolling 12-month returns, Sortino/Calmar/Ulcer, beta/alpha/IR/capture,
// VaR/CVaR, and a path-luck bootstrap. Everything keeps the house rule:
// biases labeled, deflated Sharpe front and center.

const STRATEGIES: { key: StrategyKind; label: string; blurb: string }[] = [
  {
    key: 'momentum-12-1',
    label: 'Momentum 12-1 rotation',
    blurb:
      'Each rebalance, rank the universe by 12-month return skipping the last month (the Signals tab\'s own signal) and hold the top N equal-weight. Leave the universe box empty to use the app\'s ~55 tracked symbols, or type your own list. Survivor-biased by construction — read the banner.'
  },
  {
    key: 'dual-momentum',
    label: 'Dual momentum (Antonacci GEM)',
    blurb:
      'Month-end: if the first leg (US equities) beat T-bills (BIL, total return) over 12 months, hold whichever risk leg is stronger; otherwise retreat to the defensive leg. The most-cited retail tactical strategy ("Dual Momentum Investing", 2013). Published results use decades — this window can only teach the mechanics.'
  },
  {
    key: 'fixed-allocation',
    label: 'Fixed allocation (rebalanced portfolio)',
    blurb:
      'The Portfolio Visualizer classic: your ETFs, your weights, rebalanced on a schedule — or only when Swedroe\'s 5/25 bands are breached (5 pct-pts absolute or 25% relative drift), or never ("none": buy once and drift). The right baseline for judging any tactical idea, and for designing the boring portfolio you actually hold.'
  },
  {
    key: 'ma-timing',
    label: '200-day MA timing (demo)',
    blurb:
      'Hold the symbol while it closes above its 200-day average, cash otherwise. Included deliberately as a teaching example: Zakamulin (2014) showed this class of backtest systematically overstates out-of-sample results.'
  },
  { key: 'buy-hold', label: 'Buy & hold', blurb: 'One purchase of a single symbol, then nothing. The benchmark everything must beat after costs.' }
]

const REBAL_OPTIONS: Record<string, { key: RebalanceFreq; label: string }[]> = {
  'momentum-12-1': [
    { key: 'monthly', label: 'monthly' },
    { key: 'quarterly', label: 'quarterly' }
  ],
  'fixed-allocation': [
    { key: 'quarterly', label: 'quarterly' },
    { key: 'monthly', label: 'monthly' },
    { key: 'yearly', label: 'yearly' },
    { key: 'bands', label: '5/25 bands' },
    { key: 'none', label: 'never (drift)' }
  ]
}

function pctFmt(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}

// Probabilities, volatility, hit rates: a "+" sign reads wrong on these.
function pctPlain(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

function numFmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function usdFmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function Metric({ label, value, color, tip }: { label: string; value: string; color?: string; tip: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ minWidth: 112 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
        <InfoTip width={340}>{tip}</InfoTip>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: color ?? T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

// One row of the tearsheet stat table.
function StatRow({ label, value, tip, color }: { label: string; value: string; tip: React.ReactNode; color?: string }): React.JSX.Element {
  return (
    <tr>
      <td style={{ padding: '3px 10px 3px 0', color: T.muted, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {label}
          <InfoTip width={330}>{tip}</InfoTip>
        </span>
      </td>
      <td style={{ padding: '3px 0', color: color ?? T.text, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</td>
    </tr>
  )
}

// --- charts (each its own lightweight-charts instance) ---

const CHART_BASE = {
  layout: { background: { type: ColorType.Solid, color: T.bg }, textColor: T.muted, fontSize: 11 },
  grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
  timeScale: { borderColor: T.border, fixLeftEdge: true, fixRightEdge: true }
} as const

function useResize(chartRef: React.MutableRefObject<IChartApi | null>, el: HTMLDivElement | null): void {
  useEffect(() => {
    if (!el) return
    const resize = (): void => chartRef.current?.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [chartRef, el])
}

// Growth of $1, log scale, strategy vs benchmark.
function EquityChart({ result }: { result: BacktestResult }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!el) return
    const chart = createChart(el, { ...CHART_BASE, rightPriceScale: { borderColor: T.border, mode: 1 } })
    chartRef.current = chart
    const strat = chart.addLineSeries({ color: T.accent, lineWidth: 2, title: 'strategy' })
    strat.setData(result.points.map((p) => ({ time: p.date as Time, value: p.equity })))
    const bench = chart.addLineSeries({ color: T.muted, lineWidth: 1, title: result.config.benchmark })
    bench.setData(result.points.map((p) => ({ time: p.date as Time, value: p.benchmark })))
    chart.timeScale().fitContent()
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [el, result])
  useResize(chartRef, el)

  return (
    <div
      ref={(node) => {
        ref.current = node
        setEl(node)
      }}
      style={{ width: '100%', height: 240 }}
    />
  )
}

// Underwater (drawdown) chart — % below the running peak, strategy + benchmark.
function UnderwaterChart({ result }: { result: BacktestResult }): React.JSX.Element {
  const chartRef = useRef<IChartApi | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  const data = useMemo(() => {
    let pk = -Infinity
    let bpk = -Infinity
    return result.points.map((p) => {
      pk = Math.max(pk, p.equity)
      bpk = Math.max(bpk, p.benchmark)
      return { date: p.date, dd: p.equity / pk - 1, bdd: p.benchmark / bpk - 1 }
    })
  }, [result])

  useEffect(() => {
    if (!el) return
    const chart = createChart(el, {
      ...CHART_BASE,
      rightPriceScale: { borderColor: T.border },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` }
    })
    chartRef.current = chart
    const strat = chart.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: 'transparent',
      topFillColor1: 'transparent',
      topFillColor2: 'transparent',
      bottomLineColor: T.down,
      bottomFillColor1: hexToRgba(T.down, 0.05),
      bottomFillColor2: hexToRgba(T.down, 0.3),
      lineWidth: 1,
      title: 'strategy dd'
    })
    strat.setData(data.map((d) => ({ time: d.date as Time, value: d.dd })))
    const bench = chart.addLineSeries({ color: T.muted, lineWidth: 1, title: `${result.config.benchmark} dd` })
    bench.setData(data.map((d) => ({ time: d.date as Time, value: d.bdd })))
    chart.timeScale().fitContent()
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [el, data, result.config.benchmark])
  useResize(chartRef, el)

  return <div ref={setEl} style={{ width: '100%', height: 120 }} />
}

// Rolling 12-month total return, strategy vs benchmark. Windowed by CALENDAR
// date, not bar count — pre-2020 IEX gaps would stretch a 252-bar window far
// past a year and mislabel multi-year returns as "12-month".
function RollingChart({ result }: { result: BacktestResult }): React.JSX.Element {
  const chartRef = useRef<IChartApi | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  const data = useMemo(() => {
    const pts = result.points
    const out: { date: string; r: number; br: number }[] = []
    let j = 0
    for (let i = 0; i < pts.length; i++) {
      const cutoff = Date.parse(pts[i].date) - 365 * 86_400_000
      if (Date.parse(pts[0].date) > cutoff) continue // no full year behind yet
      while (j + 1 < i && Date.parse(pts[j + 1].date) <= cutoff) j++
      out.push({ date: pts[i].date, r: pts[i].equity / pts[j].equity - 1, br: pts[i].benchmark / pts[j].benchmark - 1 })
    }
    return out
  }, [result])

  useEffect(() => {
    if (!el || data.length === 0) return
    const chart = createChart(el, {
      ...CHART_BASE,
      rightPriceScale: { borderColor: T.border },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` }
    })
    chartRef.current = chart
    const strat = chart.addLineSeries({ color: T.accent, lineWidth: 2, title: 'strategy 12m' })
    strat.setData(data.map((d) => ({ time: d.date as Time, value: d.r })))
    const bench = chart.addLineSeries({ color: T.muted, lineWidth: 1, title: `${result.config.benchmark} 12m` })
    bench.setData(data.map((d) => ({ time: d.date as Time, value: d.br })))
    const zero = chart.addLineSeries({ color: T.faint, lineWidth: 1, lineStyle: 3, priceLineVisible: false, lastValueVisible: false })
    zero.setData(data.map((d) => ({ time: d.date as Time, value: 0 })))
    chart.timeScale().fitContent()
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [el, data, result.config.benchmark])
  useResize(chartRef, el)

  if (data.length === 0) {
    return <div style={{ color: T.faint, fontSize: 11.5, padding: '8px 0' }}>Needs at least a year of simulated days.</div>
  }
  return <div ref={setEl} style={{ width: '100%', height: 140 }} />
}

// Monthly returns heatmap: year rows × Jan..Dec, plus strategy & benchmark
// yearly columns. Values printed in every cell (color is reinforcement, not
// the only encoding); diverging tint = up/down hue, alpha ∝ |return|.
function MonthlyHeatmap({ result }: { result: BacktestResult }): React.JSX.Element {
  const grid = useMemo(() => {
    const pts = result.points
    if (pts.length === 0) return []
    // Last point of each month, keyed YYYY-MM, plus the sim's starting values.
    const monthEnd = new Map<string, { eq: number; bench: number }>()
    for (const p of pts) monthEnd.set(p.date.slice(0, 7), { eq: p.equity, bench: p.benchmark })
    const keys = [...monthEnd.keys()].sort()
    const first = { eq: pts[0].equity, bench: pts[0].benchmark }
    const rows = new Map<string, { months: (number | null)[]; yearEq: [number, number]; yearBench: [number, number] }>()
    const prevMonthKey = (k: string): string => {
      const y = Number(k.slice(0, 4))
      const mo = Number(k.slice(5, 7))
      return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
    }
    let prev = first
    let prevKey = pts[0].date.slice(0, 7)
    for (const k of keys) {
      const year = k.slice(0, 4)
      const m = Number(k.slice(5, 7)) - 1
      const cur = monthEnd.get(k) as { eq: number; bench: number }
      if (!rows.has(year)) rows.set(year, { months: Array(12).fill(null), yearEq: [prev.eq, cur.eq], yearBench: [prev.bench, cur.bench] })
      const row = rows.get(year) as NonNullable<ReturnType<typeof rows.get>>
      // A cell only when the base is the same or immediately preceding month —
      // a pre-2020 data gap must not print a multi-month return as one month.
      // Year totals keep the carry (they explicitly span the whole year).
      row.months[m] = prevKey === k || prevKey === prevMonthKey(k) ? cur.eq / prev.eq - 1 : null
      row.yearEq[1] = cur.eq
      row.yearBench[1] = cur.bench
      prev = cur
      prevKey = k
    }
    return [...rows.entries()].map(([year, r]) => ({
      year,
      months: r.months,
      total: r.yearEq[1] / r.yearEq[0] - 1,
      benchTotal: r.yearBench[1] / r.yearBench[0] - 1
    }))
  }, [result])

  const cell = (v: number | null): React.CSSProperties => ({
    padding: '3px 7px',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    color: v == null ? T.faint : T.text,
    background: v == null ? 'transparent' : hexToRgba(v >= 0 ? T.up : T.down, Math.min(1, Math.abs(v) / 0.1) * 0.45),
    borderRadius: 3
  })

  return (
    <table style={{ borderCollapse: 'separate', borderSpacing: 2, fontSize: 11 }}>
      <thead>
        <tr>
          <th />
          {['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m) => (
            <th key={m} style={{ color: T.muted, fontWeight: 400, padding: '2px 7px', textAlign: 'right' }}>
              {m}
            </th>
          ))}
          <th style={{ color: T.muted, fontWeight: 600, padding: '2px 7px', textAlign: 'right' }}>Year</th>
          <th style={{ color: T.muted, fontWeight: 400, padding: '2px 7px', textAlign: 'right' }}>{result.config.benchmark}</th>
        </tr>
      </thead>
      <tbody>
        {grid.map((row) => (
          <tr key={row.year}>
            <td style={{ color: T.muted, padding: '3px 8px 3px 0', fontVariantNumeric: 'tabular-nums' }}>{row.year}</td>
            {row.months.map((v, i) => (
              <td key={i} style={cell(v)}>
                {v == null ? '·' : (v * 100).toFixed(1)}
              </td>
            ))}
            <td style={{ ...cell(row.total), fontWeight: 700 }}>{(row.total * 100).toFixed(1)}</td>
            <td style={{ ...cell(row.benchTotal), background: 'transparent', color: T.muted }}>{(row.benchTotal * 100).toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// --- input parsing (engine re-validates everything; this is UX shaping) ---

function parseSymbolList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

// Parses "VOO 60, QQQ 20, GLD 20" (weights optional → equal weight). Returns
// the RAW parse — mismatched/invalid input becomes an error here or in the
// engine, never a silent equal-weight reinterpretation of what was typed.
function parseAllocation(raw: string): { symbols: string[]; weights: number[]; error?: string } {
  const symbols: string[] = []
  const weights: number[] = []
  for (const part of raw.split(',')) {
    const bits = part.trim().split(/\s+/).filter(Boolean)
    if (bits.length === 0) continue
    if (bits.length > 2) return { symbols, weights, error: `Each leg is "SYMBOL WEIGHT" separated by commas — couldn't read "${part.trim()}".` }
    symbols.push(bits[0].toUpperCase())
    if (bits.length === 2) {
      const w = Number(bits[1])
      if (!Number.isFinite(w) || w <= 0) return { symbols, weights, error: `Weight for ${bits[0].toUpperCase()} must be a positive number.` }
      weights.push(w)
    }
  }
  if (weights.length > 0 && weights.length !== symbols.length) {
    return { symbols, weights, error: 'Give a weight for every leg or for none (none = equal weight).' }
  }
  return { symbols, weights }
}

export default function BacktestView(): React.JSX.Element {
  const [strategy, setStrategy] = useState<StrategyKind>('momentum-12-1')
  const [topN, setTopN] = useState(5)
  const [costBps, setCostBps] = useState(5)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [universeText, setUniverseText] = useState('')
  const [symbolText, setSymbolText] = useState('SPY')
  const [allocText, setAllocText] = useState('VOO 60, QQQ 20, GLD 20')
  const [dualText, setDualText] = useState('SPY, EFA, AGG')
  const [benchmark, setBenchmark] = useState('SPY')
  const [rebalance, setRebalance] = useState<RebalanceFreq>('monthly')
  // Text state: a live Math.max(100, …) clamp would mangle typing ("5" of
  // "5000" → 100). Clamped in buildConfig (and again engine-side).
  const [startCapText, setStartCapText] = useState('10000')
  const [monthlyText, setMonthlyText] = useState('0')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [boot, setBoot] = useState<BootstrapResult | null>(null)
  const [bootRunning, setBootRunning] = useState(false)
  const reqRef = useRef(0)
  const lastConfigRef = useRef<BacktestConfig | null>(null)

  const buildConfig = (): BacktestConfig => {
    let symbols: string[] = []
    let weights: number[] = []
    if (strategy === 'momentum-12-1') symbols = parseSymbolList(universeText)
    else if (strategy === 'buy-hold' || strategy === 'ma-timing') symbols = parseSymbolList(symbolText).slice(0, 1)
    else if (strategy === 'dual-momentum') symbols = parseSymbolList(dualText)
    else if (strategy === 'fixed-allocation') {
      const alloc = parseAllocation(allocText)
      symbols = alloc.symbols
      weights = alloc.weights
    }
    const reb = REBAL_OPTIONS[strategy]?.some((o) => o.key === rebalance)
      ? rebalance
      : strategy === 'fixed-allocation'
        ? 'quarterly'
        : 'monthly'
    return {
      strategy,
      topN,
      costBps,
      start: start.trim(),
      end: end.trim(),
      symbols,
      weights,
      benchmark: benchmark.trim().toUpperCase() || 'SPY',
      rebalance: reb,
      initialCapital: Math.min(10_000_000, Math.max(100, Number(startCapText) || 10_000)),
      contribMonthly: Math.min(1_000_000, Math.max(0, Number(monthlyText) || 0))
    }
  }

  const run = (): void => {
    // Parse errors surface HERE, before the IPC round-trip — the engine's
    // validation would otherwise never see what the user actually typed.
    if (strategy === 'fixed-allocation') {
      const alloc = parseAllocation(allocText)
      if (alloc.error) {
        setError(alloc.error)
        setResult(null)
        setBoot(null)
        return
      }
    }
    const req = ++reqRef.current
    setRunning(true)
    setError(null)
    setBoot(null)
    const config = buildConfig()
    lastConfigRef.current = config
    window.api
      .runBacktest(config)
      .then((r) => {
        if (req === reqRef.current) setResult(r)
      })
      .catch((e: unknown) => {
        if (req === reqRef.current) {
          setError(e instanceof Error ? e.message : String(e))
          // A stale result under the error banner reads as the NEW config's
          // output — clear it.
          setResult(null)
        }
      })
      .finally(() => {
        if (req === reqRef.current) setRunning(false)
      })
  }

  const runBoot = (): void => {
    const cfg = lastConfigRef.current
    if (!cfg || bootRunning) return
    const req = reqRef.current
    setBootRunning(true)
    window.api
      .runBootstrap(cfg)
      .then((b) => {
        if (req === reqRef.current) setBoot(b)
      })
      .catch(() => {
        if (req === reqRef.current) setBoot(null)
      })
      .finally(() => setBootRunning(false))
  }

  // UI-test harness: `--uitest "view=backtest&btrun=1"` auto-runs once;
  // `&btboot=1` also runs the bootstrap when the result lands.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('uitest')
    if (raw && new URLSearchParams(raw).get('btrun') === '1') run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const bootArmedRef = useRef(false)
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('uitest')
    if (!raw || new URLSearchParams(raw).get('btboot') !== '1') return
    if (result?.available && !boot && !bootRunning && !bootArmedRef.current) {
      bootArmedRef.current = true
      runBoot()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  const stratMeta = STRATEGIES.find((s) => s.key === strategy) as (typeof STRATEGIES)[number]
  const m = result?.metrics ?? null
  const inputStyle: React.CSSProperties = {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    padding: '5px 8px',
    fontSize: 12,
    width: 64
  }
  const labelStyle: React.CSSProperties = { color: T.muted, fontSize: 12, whiteSpace: 'nowrap' }
  const rebalOptions = REBAL_OPTIONS[strategy]

  return (
    <div data-scroll-container style={{ padding: '12px 16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Backtester</span>
        <span style={{ fontSize: 11.5, color: T.muted }}>total-return bars (dividends in) · calibration, not a strategy store</span>
        <InfoTip width={380}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>How to read anything on this page</div>
          <div style={{ color: T.muted }}>
            Backtests describe one past, with modeled costs, on dividend-adjusted (total-return) prices. The deflated
            Sharpe ratio raises its bar every time you try another variant — if a result only looks good before
            deflation, it was luck, not signal. Expect live results materially worse than any backtest.
          </div>
        </InfoTip>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0 6px', flexWrap: 'wrap' }}>
        <select
          value={strategy}
          onChange={(e) => {
            const k = e.target.value as StrategyKind
            setStrategy(k)
            setRebalance(k === 'fixed-allocation' ? 'quarterly' : 'monthly')
          }}
          style={{ ...inputStyle, width: 250 }}
        >
          {STRATEGIES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        {strategy === 'momentum-12-1' && (
          <>
            <label style={labelStyle}>
              Top&nbsp;
              <input
                type="number"
                min={1}
                max={20}
                value={topN}
                onChange={(e) => setTopN(Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))))}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Universe&nbsp;
              <input
                type="text"
                value={universeText}
                onChange={(e) => setUniverseText(e.target.value)}
                placeholder="empty = tracked ~55"
                style={{ ...inputStyle, width: 240 }}
                spellCheck={false}
              />
            </label>
          </>
        )}
        {(strategy === 'buy-hold' || strategy === 'ma-timing') && (
          <label style={labelStyle}>
            Symbol&nbsp;
            <input type="text" value={symbolText} onChange={(e) => setSymbolText(e.target.value)} style={{ ...inputStyle, width: 90 }} spellCheck={false} />
          </label>
        )}
        {strategy === 'fixed-allocation' && (
          <label style={labelStyle}>
            Legs&nbsp;
            <input
              type="text"
              value={allocText}
              onChange={(e) => setAllocText(e.target.value)}
              placeholder="VOO 60, QQQ 20, GLD 20"
              style={{ ...inputStyle, width: 280 }}
              spellCheck={false}
            />
          </label>
        )}
        {strategy === 'dual-momentum' && (
          <label style={labelStyle}>
            Legs&nbsp;
            <input
              type="text"
              value={dualText}
              onChange={(e) => setDualText(e.target.value)}
              placeholder="SPY, EFA, AGG"
              style={{ ...inputStyle, width: 180 }}
              spellCheck={false}
            />
            <span style={{ color: T.faint, fontSize: 11 }}>&nbsp;risk1, risk2, defensive</span>
          </label>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={labelStyle}>
          Cost bps/side&nbsp;
          <input
            type="number"
            min={0}
            max={100}
            value={costBps}
            onChange={(e) => setCostBps(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          From&nbsp;
          <input type="text" value={start} onChange={(e) => setStart(e.target.value)} placeholder="earliest" style={{ ...inputStyle, width: 86 }} spellCheck={false} />
        </label>
        <label style={labelStyle}>
          To&nbsp;
          <input type="text" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="today" style={{ ...inputStyle, width: 86 }} spellCheck={false} />
        </label>
        <label style={labelStyle}>
          Benchmark&nbsp;
          <input type="text" value={benchmark} onChange={(e) => setBenchmark(e.target.value)} style={{ ...inputStyle, width: 70 }} spellCheck={false} />
        </label>
        {rebalOptions && (
          <label style={labelStyle}>
            Rebalance&nbsp;
            <select value={rebalance} onChange={(e) => setRebalance(e.target.value as RebalanceFreq)} style={{ ...inputStyle, width: 110 }}>
              {rebalOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label style={labelStyle}>
          Start $&nbsp;
          <input
            type="number"
            min={100}
            step={1000}
            value={startCapText}
            onChange={(e) => setStartCapText(e.target.value)}
            style={{ ...inputStyle, width: 84 }}
          />
        </label>
        <label style={labelStyle}>
          Monthly $&nbsp;
          <input
            type="number"
            min={0}
            step={100}
            value={monthlyText}
            onChange={(e) => setMonthlyText(e.target.value)}
            style={{ ...inputStyle, width: 76 }}
          />
        </label>
        <button
          onClick={run}
          disabled={running}
          style={{
            background: running ? 'transparent' : T.accent,
            border: `1px solid ${T.accent}`,
            borderRadius: 6,
            color: running ? T.muted : '#fff',
            padding: '6px 18px',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: running ? 'default' : 'pointer'
          }}
        >
          {running ? 'Running… (new symbols backfill first)' : '▶ Run backtest'}
        </button>
      </div>
      <div style={{ color: T.faint, fontSize: 11.5, maxWidth: 950, marginBottom: 12 }}>{stratMeta.blurb}</div>

      {error && <div style={{ color: T.down, fontSize: 12.5, marginBottom: 10 }}>Backtest failed: {error}</div>}
      {result && !result.available && <div style={{ color: T.warn, fontSize: 12.5, marginBottom: 10 }}>{result.message}</div>}

      {result?.available && m && (
        <>
          <div
            style={{
              border: `1px solid ${T.warn}`,
              borderRadius: 8,
              padding: '8px 12px',
              color: T.warn,
              fontSize: 11.5,
              lineHeight: 1.5,
              marginBottom: 12,
              maxWidth: 1100
            }}
          >
            ⚠ {result.warnings[0]}
          </div>

          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 14 }}>
            <Metric
              label="CAGR (net)"
              value={pctFmt(m.cagr)}
              color={m.cagr >= m.benchCagr ? T.up : T.down}
              tip={<span>Compound annual growth rate net of modeled costs, total-return. {result.config.benchmark} over the same window: {pctFmt(m.benchCagr)}.</span>}
            />
            <Metric
              label="Sharpe"
              value={numFmt(m.sharpe)}
              tip={<span>Annualized mean ÷ volatility of daily returns, rf = 0. {result.config.benchmark}: {numFmt(m.benchSharpe)}. Raw and easily flattered — see Sortino and DSR.</span>}
            />
            <Metric
              label="Sortino"
              value={numFmt(m.sortino)}
              tip={
                <span>
                  Return per unit of DOWNSIDE volatility only (MAR 0, full-sample denominator — the downside-only-count
                  variant found in sloppy implementations inflates this). A big Sortino−Sharpe gap means the volatility
                  is mostly upside — common for momentum.
                </span>
              }
            />
            <Metric
              label="Deflated SR"
              value={pctPlain(m.dsr, 0)}
              color={m.dsr >= 0.95 ? T.up : m.dsr >= 0.5 ? T.text : T.down}
              tip={
                <span>
                  <b>Deflated Sharpe</b>: PSR measured against the best Sharpe expected from {m.trials} SKILL-LESS
                  variants (every config ever run in this app counts). This is the number that punishes backtest
                  shopping — trust it over everything to its left.
                </span>
              }
            />
            <Metric
              label="Max drawdown"
              value={pctFmt(m.maxDrawdown)}
              color={T.down}
              tip={<span>Worst peak-to-trough loss. {result.config.benchmark}: {pctFmt(m.benchMaxDrawdown)}. Ask honestly whether you'd have held through it — see the drawdown table below for how LONG it lasted.</span>}
            />
            <Metric
              label="Calmar"
              value={numFmt(m.calmar)}
              tip={<span>CAGR ÷ |max drawdown| over the full period — growth per unit of worst pain. The CTA industry's favorite. Above ~1 is historically strong; below ~0.5 means the pain outweighed the growth.</span>}
            />
          </div>

          {result.contrib && (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, maxWidth: 1100 }}>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Contributions (DCA) — what YOUR account would look like
                <InfoTip width={400}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>Two different "returns" — a pro distinction</div>
                  <div style={{ color: T.muted }}>
                    Every metric above is TIME-WEIGHTED (TWR): the strategy's skill, independent of when money arrived —
                    the GIPS standard for judging managers. The MONEY-WEIGHTED return (MWR/IRR) here is what your dollars
                    actually earned given the contribution timing — it's what a brokerage statement reports. MWR beats TWR
                    when contributions happened to land before rallies; trails it when they landed before drawdowns.
                    Neither is "wrong" — they answer different questions.
                  </div>
                </InfoTip>
              </div>
              <div style={{ fontSize: 12.5, color: T.text, lineHeight: 1.7 }}>
                Contributed <b>{usdFmt(result.contrib.totalContributed)}</b>{' '}
                <span style={{ color: T.muted }}>
                  {result.contrib.months > 0
                    ? `(${usdFmt(result.contrib.initialCapital)} start + ${result.contrib.months} × ${usdFmt(result.contrib.monthly)}/mo)`
                    : '(lump sum at inception)'}
                </span>{' '}
                → strategy ended at{' '}
                <b style={{ color: result.contrib.finalValue >= result.contrib.totalContributed ? T.up : T.down }}>
                  {usdFmt(result.contrib.finalValue)}
                </b>{' '}
                vs <b>{usdFmt(result.contrib.benchFinalValue)}</b>{' '}
                {result.contrib.months > 0 ? "DCA'ing the same dollars into" : 'in'} {result.config.benchmark}.
                <br />
                Money-weighted return{' '}
                <b>{result.contrib.mwr != null ? `${pctFmt(result.contrib.mwr)}/yr` : 'n/a (outside solvable range)'}</b> (your
                dollars, brokerage-statement style) vs time-weighted <b>{pctFmt(result.contrib.twr)}</b>/yr (the strategy,
                tearsheet style).
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 14, maxWidth: 1100 }}>
            <div>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Risk</div>
              <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                <tbody>
                  <StatRow label="Volatility (ann.)" value={pctPlain(m.vol)} tip={<span>Annualized standard deviation of daily returns. {result.config.benchmark}: {pctPlain(m.benchVol)}.</span>} />
                  <StatRow
                    label="VaR 95% (daily)"
                    value={pctFmt(m.var95)}
                    tip={<span>Historical Value-at-Risk: about 1 day in 20 loses at least this much. Non-parametric — read directly off this backtest's worst days.</span>}
                  />
                  <StatRow
                    label="CVaR 95% (daily)"
                    value={pctFmt(m.cvar95)}
                    color={T.down}
                    tip={<span>Expected shortfall: the AVERAGE loss across the worst 5% of days — the honest tail number (VaR says where the tail starts; CVaR says how bad it is inside). Risk desks moved to this after 2008.</span>}
                  />
                  <StatRow
                    label="Skew / excess kurt"
                    value={`${numFmt(m.skew)} / ${numFmt(m.kurtExcess, 1)}`}
                    tip={
                      <span>
                        Shape of the daily return distribution. Negative skew + high excess kurtosis (normal = 0) is the
                        signature of "picking up pennies in front of a steamroller" — frequent small gains, rare big
                        losses. These two numbers feed the PSR/DSR machinery directly.
                      </span>
                    }
                  />
                  <StatRow label="Best / worst month" value={`${pctFmt(m.bestMonth)} / ${pctFmt(m.worstMonth)}`} tip={<span>Calendar-month extremes — calibrate what a normal bad month feels like before living through one.</span>} />
                  <StatRow label="Hit rate (monthly)" value={pctPlain(m.hitRateMonthly, 0)} tip={<span>Fraction of positive months. Momentum lives near ~60% with occasional deep crashes.</span>} />
                </tbody>
              </table>
            </div>
            <div>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Drawdown texture</div>
              <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                <tbody>
                  <StatRow
                    label="Ulcer index"
                    value={numFmt(m.ulcer, 1)}
                    tip={<span>Root-mean-square of the daily drawdown series (in %). Unlike max drawdown (one bad moment), this measures depth × duration of being underwater — closer to what actually makes investors quit. Lower is calmer; SPY historically ~5–10.</span>}
                  />
                  <StatRow
                    label="Time underwater"
                    value={pctPlain(m.timeUnderwaterPct, 0)}
                    tip={<span>Fraction of all days spent below a prior equity peak. Even great strategies spend most days underwater — knowing that beforehand is the defense against abandoning them.</span>}
                  />
                  <StatRow
                    label="Longest underwater"
                    value={`${m.longestUnderwaterDays} days`}
                    tip={<span>Longest peak-to-recovery stretch, in calendar days. Behavioral research says investors abandon strategies during long flat spells, not at the drawdown low.</span>}
                  />
                  <StatRow label="PSR" value={pctPlain(m.psr, 0)} tip={<span><b>Probabilistic Sharpe Ratio</b> (Bailey/López de Prado): probability the TRUE Sharpe exceeds 0 given {m.tradingDays} days of returns and their skew/fat-tails. 95%+ is the conventional bar.</span>} />
                  <StatRow label="Avg turnover" value={pctPlain(m.avgTurnover, 0)} tip={<span>One-way turnover per rebalance event, measured against drifted weights.</span>} />
                  <StatRow label="Cost drag" value={`${pctPlain(m.costDragAnnual, 2)}/yr`} tip={<span>Modeled transaction costs as a fraction of equity per year, at {result.config.costBps} bps per side.</span>} />
                </tbody>
              </table>
            </div>
            <div>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                vs {result.config.benchmark}
              </div>
              <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                <tbody>
                  <StatRow
                    label="Beta"
                    value={numFmt(m.beta)}
                    tip={<span>Sensitivity to benchmark moves (OLS on daily returns). 1 = moves with it; 1.3 = a leveraged version of it. Outperformance with beta &gt; 1 in a bull market is mostly borrowed market risk, not skill.</span>}
                  />
                  <StatRow
                    label="Alpha (ann.)"
                    value={pctFmt(m.alphaAnnual)}
                    color={m.alphaAnnual != null && m.alphaAnnual > 0 ? T.up : T.down}
                    tip={<span>Return NOT explained by benchmark exposure (regression intercept × 252). The professional's first question: is there anything left after beta?</span>}
                  />
                  <StatRow label="R²" value={numFmt(m.r2)} tip={<span>How much of the strategy's daily variance the benchmark explains. Near 1 = you mostly own the benchmark with extra steps.</span>} />
                  <StatRow
                    label="Tracking error"
                    value={pctPlain(m.trackingError)}
                    tip={<span>Annualized volatility of the DIFFERENCE between strategy and benchmark returns — how differently it behaves, regardless of direction.</span>}
                  />
                  <StatRow
                    label="Information ratio"
                    value={numFmt(m.informationRatio)}
                    tip={<span>Mean active return ÷ tracking error, annualized (Grinold/Kahn). The metric active managers are judged by: is deviating from the index paying for its risk? Sustained &gt; 0.5 is rare and good.</span>}
                  />
                  <StatRow
                    label="Up / down capture"
                    value={`${m.upCapture == null ? '—' : (m.upCapture * 100).toFixed(0)} / ${m.downCapture == null ? '—' : (m.downCapture * 100).toFixed(0)}`}
                    tip={
                      <span>
                        Morningstar convention (monthly): % of the benchmark's gains captured in its up months / % of
                        its losses suffered in its down months. The dream is &gt;100 up with &lt;100 down; a timing
                        overlay that only delivers 80/95 is diluting, not defending.
                      </span>
                    }
                  />
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 12, maxWidth: 1100 }}>
            <div style={{ padding: '6px 12px', borderBottom: `1px solid ${T.border}`, color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Growth of $1 (log) — {STRATEGIES.find((s) => s.key === result.config.strategy)?.label ?? result.config.strategy}
              {result.config.strategy === 'momentum-12-1' ? ` · top ${result.config.topN}` : ''} · {result.config.costBps} bps/side ·{' '}
              {result.effectiveStart} → {result.effectiveEnd} · vs {result.config.benchmark} · {result.coverage.eligibleAtStart}/
              {result.coverage.universeSize} symbols eligible at start, {result.coverage.eligibleAtEnd} by the end
            </div>
            <EquityChart result={result} />
            <div style={{ padding: '4px 12px', borderTop: `1px solid ${T.border}`, color: T.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Underwater — % below the running peak (the lived experience of the same curve)
            </div>
            <UnderwaterChart result={result} />
          </div>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12, maxWidth: 1100 }}>
            <div>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Monthly returns (%)
                <InfoTip width={320}>
                  <span>
                    The tearsheet staple: every month you'd have lived through, tinted by size. Look for the ugly
                    stretches, not the average — consistency here is what makes a strategy holdable. Partial first/last
                    months included. Year column compounds the months; {result.config.benchmark} column for reference.
                  </span>
                </InfoTip>
              </div>
              <MonthlyHeatmap result={result} />
            </div>
          </div>

          {result.drawdowns.length > 0 && (
            <div style={{ marginBottom: 12, maxWidth: 1100 }}>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Worst drawdowns
                <InfoTip width={320}>
                  <span>
                    Depth is only half a drawdown — the other half is TIME. Pros quote "how long underwater" alongside
                    "how deep". An episode ends only when equity makes a new high.
                  </span>
                </InfoTip>
              </div>
              <table style={{ borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    {['Depth', 'Peak', 'Trough', 'Recovered', 'Fall (days)', 'Recovery (days)'].map((h) => (
                      <th key={h} style={{ color: T.muted, fontWeight: 400, textAlign: h === 'Depth' ? 'right' : 'left', padding: '2px 16px 4px 0' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.drawdowns.map((d) => (
                    <tr key={d.peakDate}>
                      <td style={{ color: T.down, textAlign: 'right', padding: '3px 16px 3px 0', fontWeight: 600 }}>{pctFmt(d.depth)}</td>
                      <td style={{ color: T.text, padding: '3px 16px 3px 0' }}>{d.peakDate}</td>
                      <td style={{ color: T.text, padding: '3px 16px 3px 0' }}>{d.troughDate}</td>
                      <td style={{ color: d.recoveryDate ? T.text : T.warn, padding: '3px 16px 3px 0' }}>{d.recoveryDate ?? 'still underwater'}</td>
                      <td style={{ color: T.muted, padding: '3px 16px 3px 0' }}>{d.daysToTrough}</td>
                      <td style={{ color: T.muted, padding: '3px 16px 3px 0' }}>{d.daysToRecover ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 12, maxWidth: 1100 }}>
            <div style={{ padding: '6px 12px', borderBottom: `1px solid ${T.border}`, color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              Rolling 12-month return
              <InfoTip width={320}>
                <span>
                  The antidote to one lucky average: every 1-year window an investor could have started in. If
                  outperformance only exists in one stretch, this chart says so; the full-sample CAGR won't.
                </span>
              </InfoTip>
            </div>
            <RollingChart result={result} />
          </div>

          {result.rebalances.length > 0 && result.config.strategy !== 'buy-hold' && (
            <div style={{ marginBottom: 12, maxWidth: 1100 }}>
              <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Recent rebalances (what the strategy held)
              </div>
              <table style={{ borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                <tbody>
                  {result.rebalances.map((r) => (
                    <tr key={r.date}>
                      <td style={{ padding: '3px 14px 3px 0', color: T.muted, whiteSpace: 'nowrap' }}>{r.date}</td>
                      <td style={{ padding: '3px 14px 3px 0', color: T.text }}>{r.holdings.join(' · ') || '(cash)'}</td>
                      <td style={{ padding: '3px 0', color: T.faint, whiteSpace: 'nowrap' }}>turnover {pctPlain(r.turnover, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginBottom: 12, maxWidth: 1100 }}>
            {!boot && (
              <button
                onClick={runBoot}
                disabled={bootRunning}
                style={{
                  background: 'transparent',
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  color: bootRunning ? T.faint : T.muted,
                  padding: '6px 14px',
                  fontSize: 12,
                  cursor: bootRunning ? 'default' : 'pointer'
                }}
              >
                {bootRunning ? 'Resampling…' : '⚄ Path-luck bootstrap (1,000 resamples)'}
              </button>
            )}
            {boot?.available && (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Path-luck bootstrap — same daily returns, {boot.resamples} resampled orderings
                  <InfoTip width={360}>
                    <span>
                      Stationary block bootstrap (Politis–Romano, expected block {boot.blockLen} days — blocks preserve
                      volatility clustering). If the realized number sits near an extreme percentile, the headline
                      result owed a lot to the ORDER the returns arrived in.
                    </span>
                  </InfoTip>
                </div>
                <table style={{ borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr>
                      {['', 'p5', 'p25', 'median', 'p75', 'p95', 'realized'].map((h, i) => (
                        <th key={i} style={{ color: T.muted, fontWeight: h === 'realized' ? 600 : 400, textAlign: 'right', padding: '2px 0 4px 18px' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        { label: 'CAGR', p: boot.cagr, real: boot.realized.cagr, fmt: (v: number) => pctFmt(v) },
                        { label: 'Max drawdown', p: boot.maxDrawdown, real: boot.realized.maxDrawdown, fmt: (v: number) => pctFmt(v) },
                        { label: 'Sharpe', p: boot.sharpe, real: boot.realized.sharpe, fmt: (v: number) => v.toFixed(2) }
                      ] as const
                    ).map((row) => (
                      <tr key={row.label}>
                        <td style={{ color: T.muted, padding: '3px 0', textAlign: 'left' }}>{row.label}</td>
                        {[row.p.p5, row.p.p25, row.p.p50, row.p.p75, row.p.p95].map((v, i) => (
                          <td key={i} style={{ color: T.text, textAlign: 'right', padding: '3px 0 3px 18px' }}>
                            {row.fmt(v)}
                          </td>
                        ))}
                        <td style={{ color: T.accent, fontWeight: 600, textAlign: 'right', padding: '3px 0 3px 18px' }}>{row.fmt(row.real)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ color: T.muted, fontSize: 11.5, marginTop: 8 }}>
                  {pctPlain(boot.probNegative, 1)} of resamples ended below $1 · {pctPlain(boot.probWorseDD, 0)} drew down deeper than the
                  realized {pctFmt(boot.realized.maxDrawdown)}.
                </div>
                <div style={{ color: T.faint, fontSize: 10.5, lineHeight: 1.55, marginTop: 6 }}>
                  {boot.notes.map((n, i) => (
                    <div key={i}>• {n}</div>
                  ))}
                </div>
              </div>
            )}
            {boot && !boot.available && <div style={{ color: T.warn, fontSize: 12 }}>{boot.message}</div>}
          </div>

          <div style={{ color: T.faint, fontSize: 10.5, lineHeight: 1.55, maxWidth: 1000 }}>
            {result.warnings.slice(1).map((w, i) => (
              <div key={i}>• {w}</div>
            ))}
          </div>
        </>
      )}

      {!result && !error && (
        <div style={{ color: T.muted, fontSize: 12.5 }}>
          Pick a strategy and hit Run. Any ticker works — new symbols fetch their full dividend-adjusted history on
          first use (~1 API call each). Free-data reality: IEX history is dense from ~mid-2020, so that's where most
          backtests effectively start.
        </div>
      )}
    </div>
  )
}
