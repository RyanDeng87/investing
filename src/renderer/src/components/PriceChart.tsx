import { useEffect, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Logical,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import type { BarRow, IntradayBar } from '../../../shared/types'
import type { PatternHit } from '../patterns'
import { T, fmtPrice } from '../theme'

export type ChartMode = 'candles' | 'line'
export type ChartRange = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y' | 'MAX'

// A pattern the user clicked in the bottom panel: the chart centers on it and
// pins its highlight + inspector until the user interacts with the chart.
// `nonce` re-triggers the jump when the same pattern is clicked twice.
export interface PatternFocus {
  hit: PatternHit
  nonce: number
}

export function isIntradayRange(r: ChartRange): boolean {
  return r === '1D' || r === '1W'
}

const RANGE_DAYS: Record<Exclude<ChartRange, '1D' | '1W' | 'MAX'>, number> = {
  '1M': 31,
  '3M': 92,
  '6M': 183,
  '1Y': 366,
  '2Y': 731
}

interface WorkingBar {
  time: Time
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Props {
  dailyBars: BarRow[]
  intradayBars: IntradayBar[]
  range: ChartRange
  mode: ChartMode
  symbol: string
  patterns?: PatternHit[] // always the full detected set — hover inspection works regardless of the toggle
  showPatternMarks?: boolean // Patterns toggle: arrows + always-on light boxes
  focus?: PatternFocus | null
}

interface HoverInfo {
  label: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  changePct: number | null
  pattern?: PatternHit | null
}

// Screen-space rectangle over the candles that form a detected pattern. All
// patterns get a light tint (so it's visible they can be inspected); the
// hovered or pinned one gets a stronger tint and solid border.
interface HighlightRect {
  id: string
  left: number
  top: number
  width: number
  height: number
  rgb: string
  active: boolean
}

function dirRgb(dir: PatternHit['direction']): string {
  return dir === 'bull' ? '38,166,154' : dir === 'bear' ? '239,83,80' : '120,123,134'
}

function dirColor(dir: PatternHit['direction']): string {
  return dir === 'bull' ? T.up : dir === 'bear' ? T.down : T.muted
}

function nyDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso))
}

function toWorking(dailyBars: BarRow[], intradayBars: IntradayBar[], range: ChartRange): WorkingBar[] {
  if (isIntradayRange(range)) {
    return intradayBars.map((b) => ({
      time: b.time as UTCTimestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume
    }))
  }
  return dailyBars.map((b) => ({
    time: b.date as Time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume
  }))
}

// All displayed times use the computer's local timezone, 12-hour clock.
function timeLabel(t: Time): string {
  if (typeof t === 'number') {
    return new Date(t * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }
  const d = new Date(`${t}T12:00:00`)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function tickLabel(time: Time, tickMarkType: TickMarkType): string {
  if (typeof time === 'number') {
    const d = new Date(time * 1000)
    if (tickMarkType === TickMarkType.Time || tickMarkType === TickMarkType.TimeWithSeconds) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  const s = String(time)
  if (tickMarkType === TickMarkType.Year) return s.slice(0, 4)
  const d = new Date(`${s}T12:00:00`)
  if (tickMarkType === TickMarkType.Month) return d.toLocaleDateString(undefined, { month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric' })
}

// New York session boundaries for open/close marks, robust to local timezone.
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit'
})

function etDayMin(tsSec: number): { day: string; min: number } {
  const parts = ET_PARTS.formatToParts(new Date(tsSec * 1000))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00'
  const hour = Number(get('hour')) % 24
  return { day: `${get('month')}-${get('day')}`, min: hour * 60 + Number(get('minute')) }
}

const OPEN_MIN = 9 * 60 + 30 // 9:30am ET
const CLOSE_MIN = 16 * 60 // 4:00pm ET

export default function PriceChart({
  dailyBars,
  intradayBars,
  range,
  mode,
  symbol,
  patterns,
  showPatternMarks = true,
  focus
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceSeriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const dataRef = useRef<WorkingBar[]>([])
  // Symbol/range the data in dataRef actually belongs to — assigned only when a
  // series is (re)built. Stream handlers must check THIS, not the props: on a
  // symbol switch the new symbol's ticks would otherwise be merged into the old
  // symbol's still-displayed bars.
  const dataTagRef = useRef<{ symbol: string; range: ChartRange } | null>(null)
  const priceLineRef = useRef<IPriceLine | null>(null)
  const modeRef = useRef<ChartMode>(mode)
  const patternsRef = useRef<PatternHit[] | undefined>(patterns)
  const showMarksRef = useRef(showPatternMarks)
  const hoverHitRef = useRef<PatternHit | null>(null)
  const pinnedRef = useRef<PatternHit | null>(null)
  const rectsRafRef = useRef(0)
  const rectsRetryRef = useRef(0)
  const lastRectsJsonRef = useRef('')
  const lastLegendRenderRef = useRef(0)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [pinned, setPinned] = useState<PatternHit | null>(null)
  const [patternRects, setPatternRects] = useState<HighlightRect[]>([])
  const [, forceRender] = useState(0)

  modeRef.current = mode
  patternsRef.current = patterns
  showMarksRef.current = showPatternMarks

  // Recompute highlight rectangles from chart coordinates. Runs on pan/zoom
  // (per animation frame), rebuilds, pattern/pin/hover changes and resizes —
  // uses only refs so the closure from the first render stays valid.
  const computeRects = (): void => {
    const chart = chartRef.current
    const series = priceSeriesRef.current
    const el = containerRef.current
    const data = dataRef.current
    const setIfChanged = (rects: HighlightRect[]): void => {
      const json = JSON.stringify(rects)
      if (json === lastRectsJsonRef.current) return // live ticks mostly don't move rects — skip re-renders
      lastRectsJsonRef.current = json
      setPatternRects(rects)
    }
    if (!chart || !series || !el || data.length === 0) {
      setIfChanged([])
      return
    }
    const wanted = new Map<string, { hit: PatternHit; active: boolean }>()
    // Always-on light boxes only when the Patterns toggle is on; the hovered or
    // pinned pattern is boxed regardless (added below).
    if (showMarksRef.current) {
      for (const p of patternsRef.current ?? []) wanted.set(`${p.name}@${String(p.key)}`, { hit: p, active: false })
    }
    for (const extra of [pinnedRef.current, hoverHitRef.current]) {
      if (!extra) continue
      const id = `${extra.name}@${String(extra.key)}`
      const existing = wanted.get(id)
      if (existing) existing.active = true
      else wanted.set(id, { hit: extra, active: true }) // pinned works even with the Patterns toggle off
    }
    if (wanted.size === 0) {
      setIfChanged([])
      return
    }

    const idxOf = new Map<string, number>()
    for (let i = 0; i < data.length; i++) idxOf.set(String(data[i].time), i)
    const ts = chart.timeScale()
    const paneW = ts.width() || el.clientWidth
    const paneH = Math.max(0, el.clientHeight - (ts.height() || 28))
    const out: HighlightRect[] = []
    let notReady = false // coordinate APIs return null until the chart's own deferred layout pass runs
    // Bar spacing measured in pixel space from two adjacent INTEGER indices —
    // indexToCoordinate silently returns 0 for any fractional logical, so
    // half-bar padding must be added in pixels, never as index ± 0.5.
    const spacingProbe =
      data.length >= 2 ? [ts.logicalToCoordinate(0 as Logical), ts.logicalToCoordinate(1 as Logical)] : null
    const halfBar =
      spacingProbe && spacingProbe[0] != null && spacingProbe[1] != null
        ? Math.abs(spacingProbe[1] - spacingProbe[0]) / 2
        : 3
    for (const [id, { hit, active }] of wanted) {
      const idxs = hit.keys.map((k) => idxOf.get(String(k))).filter((v): v is number => v != null)
      if (idxs.length === 0) continue
      const first = Math.min(...idxs)
      const last = Math.max(...idxs)
      const x1 = ts.logicalToCoordinate(first as Logical)
      const x2 = ts.logicalToCoordinate(last as Logical)
      if (x1 == null || x2 == null) {
        notReady = true
        continue
      }
      const left = Math.max(0, Math.min(x1, x2) - halfBar)
      const right = Math.min(paneW, Math.max(x1, x2) + halfBar)
      if (right - left < 1) continue // fully offscreen or sub-pixel
      let hi = -Infinity
      let lo = Infinity
      for (let i = first; i <= last; i++) {
        hi = Math.max(hi, data[i].high)
        lo = Math.min(lo, data[i].low)
      }
      const y1 = series.priceToCoordinate(hi)
      const y2 = series.priceToCoordinate(lo)
      if (y1 == null || y2 == null) {
        notReady = true
        continue
      }
      const top = Math.max(0, Math.min(y1, y2) - 3)
      const height = Math.min(paneH - top, Math.abs(y2 - y1) + 6)
      if (height <= 0) continue
      out.push({
        id,
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(height),
        rgb: dirRgb(hit.direction),
        active
      })
    }
    // Ground truth for the --uitest harness: why rects did/didn't compute.
    ;(window as unknown as Record<string, unknown>).__rectsDebug = {
      wanted: wanted.size,
      out: out.length,
      notReady,
      retries: rectsRetryRef.current,
      dataLen: data.length,
      paneW,
      paneH
    }
    setIfChanged(out)
    // Right after a rebuild/jump the chart may not have laid out yet and every
    // coordinate comes back null. Nothing fires an event once it settles, so
    // retry briefly instead of leaving the boxes invisible until the next pan.
    if (notReady && rectsRetryRef.current < 6) {
      rectsRetryRef.current += 1
      setTimeout(scheduleRects, 100)
    } else if (!notReady) {
      rectsRetryRef.current = 0
    }
  }

  const scheduleRects = (): void => {
    if (rectsRafRef.current) return
    rectsRafRef.current = requestAnimationFrame(() => {
      rectsRafRef.current = 0
      computeRects()
    })
  }

  const clearPin = (): void => {
    if (!pinnedRef.current) return
    pinnedRef.current = null
    setPinned(null)
    scheduleRects()
  }

  // Pattern markers are applied OUTSIDE the series-rebuild effect: `patterns` is
  // a freshly-computed array most renders, and having it as a rebuild dependency
  // would tear the chart down every render (resetting zoom and live candles).
  const applyMarkers = (): void => {
    const series = priceSeriesRef.current
    if (!series) return
    const pats = patternsRef.current
    const dt = dataTagRef.current
    const data = dataRef.current
    if (!dt || data.length === 0) {
      series.setMarkers([])
      return
    }
    type Mark = {
      time: Time
      position: 'aboveBar' | 'belowBar'
      color: string
      shape: 'circle' | 'arrowUp' | 'arrowDown'
      text: string
    }
    const marks: Mark[] = []

    // Intraday views: mark market open (9:30 ET) and close (4:00 ET).
    if (isIntradayRange(dt.range)) {
      let prev: { day: string; min: number } | null = null
      for (const b of data) {
        if (typeof b.time !== 'number') continue
        const cur = etDayMin(b.time)
        if (prev) {
          const newDay = prev.day !== cur.day
          if (cur.min >= OPEN_MIN && cur.min < CLOSE_MIN && (newDay || prev.min < OPEN_MIN)) {
            marks.push({ time: b.time, position: 'aboveBar', color: T.muted, shape: 'circle', text: 'Open' })
          } else if (!newDay && prev.min < CLOSE_MIN && cur.min >= CLOSE_MIN) {
            marks.push({ time: b.time, position: 'aboveBar', color: T.muted, shape: 'circle', text: 'Close' })
          }
        }
        prev = cur
      }
    }

    // Pattern annotations for the displayed granularity (keys match bar times).
    if (pats && pats.length > 0 && showMarksRef.current) {
      const inRange = new Set(data.map((b) => String(b.time)))
      for (const p of pats) {
        if (!inRange.has(String(p.key))) continue
        marks.push({
          time: p.key as Time,
          position: p.direction === 'bull' ? 'belowBar' : 'aboveBar',
          color: dirColor(p.direction),
          shape: p.direction === 'bull' ? 'arrowUp' : p.direction === 'bear' ? 'arrowDown' : 'circle',
          text: p.name
        })
      }
    }

    const ts = (t: Time): number => (typeof t === 'number' ? t : Date.parse(String(t)))
    marks.sort((a, b) => ts(a.time) - ts(b.time))
    series.setMarkers(marks)
  }

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: T.bg }, textColor: T.muted, fontSize: 11 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: T.crosshair, labelBackgroundColor: T.panelHover },
        horzLine: { color: T.crosshair, labelBackgroundColor: T.panelHover }
      },
      localization: { timeFormatter: timeLabel },
      // autoScale keeps the price axis fitted to whatever range you pan/zoom to;
      // fixed edges stop the chart from scrolling into blank space (Robinhood-like).
      rightPriceScale: { borderColor: T.border, autoScale: true },
      timeScale: {
        borderColor: T.border,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: tickLabel
      }
    })
    chartRef.current = chart

    const resize = (): void => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
      scheduleRects()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    // Highlight boxes live in screen space — track every pan/zoom frame.
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleRects)

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null)
        if (hoverHitRef.current) {
          hoverHitRef.current = null
          scheduleRects()
        }
        return
      }
      const list = dataRef.current
      const key = typeof param.time === 'number' ? param.time : String(param.time)
      const idx = list.findIndex((b) => (typeof b.time === 'number' ? b.time === key : String(b.time) === key))
      if (idx < 0) {
        setHover(null)
        if (hoverHitRef.current) {
          hoverHitRef.current = null
          scheduleRects()
        }
        return
      }
      const b = list[idx]
      const prev = idx > 0 ? list[idx - 1] : null
      // Hovering ANY candle of a detected pattern (engulfing spans two) opens
      // the inspector, so the analysis source is visible right on the chart.
      // A pinned pattern stays inspectable even with the Patterns toggle off.
      const hit =
        patternsRef.current?.find((p) => p.keys.some((k) => String(k) === String(b.time))) ??
        (pinnedRef.current?.keys.some((k) => String(k) === String(b.time)) ? pinnedRef.current : null)
      if (hoverHitRef.current !== hit) {
        hoverHitRef.current = hit
        scheduleRects()
      }
      setHover({
        label: timeLabel(b.time),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        changePct: prev ? ((b.close - prev.close) / prev.close) * 100 : null,
        pattern: hit
      })
    })

    return () => {
      ro.disconnect()
      cancelAnimationFrame(rectsRafRef.current)
      chart.remove()
      chartRef.current = null
      priceSeriesRef.current = null
      volumeSeriesRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // (Re)build series when inputs change. The chart always holds FULL history;
  // range buttons only set the visible window, so panning reveals more data
  // instead of hitting a cliff.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // A rebuild means new data/granularity — any pinned pattern belongs to the
    // old series. (A focus-driven rebuild re-pins right after, same commit.)
    pinnedRef.current = null
    setPinned(null)
    if (priceSeriesRef.current) {
      chart.removeSeries(priceSeriesRef.current)
      priceSeriesRef.current = null
      priceLineRef.current = null // removed together with its series
    }
    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current)
      volumeSeriesRef.current = null
    }
    const data = toWorking(dailyBars, intradayBars, range)
    dataRef.current = data
    // Tag with the symbol the bars ACTUALLY belong to, not the prop: on a
    // symbol switch this effect runs while dailyBars still hold the previous
    // symbol (the fetch hasn't resolved). Tagging them with the new symbol
    // would let the new symbol's live ticks mutate the old symbol's candles —
    // a fake price jump on screen. BarRow carries its symbol; intraday bars
    // don't, but App clears them synchronously in the same commit, so the
    // prop is safe for intraday ranges.
    const dataSymbol = !isIntradayRange(range) && dailyBars.length > 0 ? dailyBars[0].symbol : symbol
    dataTagRef.current = { symbol: dataSymbol, range }
    rectsRetryRef.current = 0 // fresh layout — re-arm the not-ready retries
    if (data.length === 0) {
      scheduleRects()
      forceRender((n) => n + 1)
      return
    }

    // The built-in last-value line/label is replaced by an explicit price line we
    // update on every live tick — it spans the full chart width, so the current
    // price stays visible (line + right-axis label) wherever you pan or zoom.
    if (mode === 'candles') {
      const s = chart.addCandlestickSeries({
        upColor: T.up,
        downColor: T.down,
        borderUpColor: T.up,
        borderDownColor: T.down,
        wickUpColor: T.up,
        wickDownColor: T.down,
        lastValueVisible: false,
        priceLineVisible: false
      })
      s.setData(data.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })))
      s.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 }, autoScale: true })
      priceSeriesRef.current = s
    } else {
      const s = chart.addLineSeries({ color: T.accent, lineWidth: 2, lastValueVisible: false, priceLineVisible: false })
      s.setData(data.map((b) => ({ time: b.time, value: b.close })))
      s.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 }, autoScale: true })
      priceSeriesRef.current = s
    }
    priceLineRef.current = priceSeriesRef.current.createPriceLine({
      price: data[data.length - 1].close,
      color: T.accent,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: ''
    })

    const vol = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false
    })
    vol.setData(
      data.map((b, i) => ({
        time: b.time,
        value: b.volume,
        color:
          (i > 0 ? b.close >= data[i - 1].close : b.close >= b.open)
            ? 'rgba(38,166,154,0.35)'
            : 'rgba(239,83,80,0.35)'
      }))
    )
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } })
    volumeSeriesRef.current = vol

    applyMarkers()

    chart.applyOptions({ timeScale: { timeVisible: isIntradayRange(range) } })
    const lastBar = data[data.length - 1]
    if (range === '1D' && data.length >= 2 && typeof lastBar.time === 'number') {
      // Default the 1D view to the LATEST session only — the ~32h of fetched
      // history stays reachable by panning left through overnight/after-hours.
      const lastDay = etDayMin(lastBar.time).day
      let fromIdx = data.findIndex((b) => typeof b.time === 'number' && etDayMin(b.time).day === lastDay)
      if (fromIdx < 0) fromIdx = 0
      // Thin pre-market start of a new day: include the prior session's tail.
      if (data.length - fromIdx < 30) fromIdx = Math.max(0, data.length - 120)
      chart.timeScale().setVisibleRange({ from: data[fromIdx].time, to: lastBar.time })
    } else if (isIntradayRange(range) || range === 'MAX' || data.length < 2) {
      chart.timeScale().fitContent()
    } else {
      // Safe cast: the isIntradayRange/MAX branch above excludes these keys.
      const days = RANGE_DAYS[range as Exclude<ChartRange, '1D' | '1W' | 'MAX'>]
      const cutoffStr = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const firstStr = String(data[0].time)
      const from = (cutoffStr > firstStr ? cutoffStr : firstStr) as Time
      chart.timeScale().setVisibleRange({ from, to: data[data.length - 1].time })
    }
    scheduleRects()
    forceRender((n) => n + 1)
    // `patterns` intentionally NOT a dependency — see applyMarkers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyBars, intradayBars, mode, range, symbol])

  // Re-apply markers when the patterns toggle/content changes, without rebuilding.
  useEffect(() => {
    applyMarkers()
    rectsRetryRef.current = 0
    scheduleRects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patterns, showPatternMarks])

  // Click-to-jump from the bottom panel: center the pattern (keeping the
  // current zoom width), pin its highlight and open the inspector. Declared
  // AFTER the rebuild effect so a range-switch jump sees the new data.
  useEffect(() => {
    if (!focus) return
    const hit = focus.hit
    pinnedRef.current = hit
    setPinned(hit)
    const chart = chartRef.current
    const data = dataRef.current
    const idx = data.findIndex((b) => String(b.time) === String(hit.key))
    if (chart && idx >= 0) {
      // Fixed ±40-bar window: preserving the current zoom width made every
      // recent pattern clamp (fixRightEdge) to the SAME rightmost view. A
      // tight window keeps jumps distinct; the pinned box marks the candle
      // even when the window still clamps at the data edge.
      chart.timeScale().setVisibleLogicalRange({ from: idx - 40, to: idx + 40 })
    }
    rectsRetryRef.current = 0
    scheduleRects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // Live updates: merge streaming trades/minute-bars into the last candle so the
  // chart moves in real time (streaming costs no REST API calls).
  // Invariant: NEVER call series.update() with a time older than the last data
  // point — lightweight-charts throws ('Cannot update oldest data') and the
  // series is then permanently ahead of dataRef. Late/out-of-order messages are
  // merged silently or dropped instead.
  useEffect(() => {
    const applyLast = (bar: WorkingBar): void => {
      const series = priceSeriesRef.current
      if (!series) return
      if (modeRef.current === 'candles') {
        ;(series as ISeriesApi<'Candlestick'>).update({
          time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close
        })
      } else {
        ;(series as ISeriesApi<'Line'>).update({ time: bar.time, value: bar.close })
      }
      // Keep the full-width current-price line and its axis label live.
      priceLineRef.current?.applyOptions({ price: bar.close })
      // Autoscale shifts can move highlight boxes; computeRects no-ops via its
      // JSON guard when nothing actually moved.
      if ((patternsRef.current?.length ?? 0) > 0 || pinnedRef.current || hoverHitRef.current) scheduleRects()
      // The fallback legend reads dataRef at render time; nudge a re-render at
      // most once a second so it tracks the moving candle.
      const now = Date.now()
      if (now - lastLegendRenderRef.current > 1000) {
        lastLegendRenderRef.current = now
        forceRender((n) => n + 1)
      }
    }

    const tag = (): { symbol: string; range: ChartRange } | null => dataTagRef.current

    const offTrade = window.api.onStreamTrade((t) => {
      const dt = tag()
      if (!dt || t.symbol !== dt.symbol) return
      const data = dataRef.current
      if (data.length === 0) return
      const last = data[data.length - 1]
      if (isIntradayRange(dt.range)) {
        // Bucket live trades at the displayed granularity (1min on 1D, 15min on 1W).
        const bucketSec = dt.range === '1W' ? 900 : 60
        const bucket = (Math.floor(Date.parse(t.time) / (bucketSec * 1000)) * bucketSec) as UTCTimestamp
        if (typeof last.time !== 'number') return
        if (bucket > last.time) {
          // Seed 1W buckets with 0 — their volume comes exclusively from official
          // minute bars (which will include this trade); seeding t.size would
          // double-count it for the bucket's lifetime.
          const fresh: WorkingBar = {
            time: bucket,
            open: t.price,
            high: t.price,
            low: t.price,
            close: t.price,
            volume: dt.range === '1D' ? t.size : 0
          }
          data.push(fresh)
          applyLast(fresh)
          volumeSeriesRef.current?.update({ time: fresh.time, value: fresh.volume, color: 'rgba(120,123,134,0.3)' })
        } else if (bucket === last.time) {
          last.close = t.price
          last.high = Math.max(last.high, t.price)
          last.low = Math.min(last.low, t.price)
          // 1W volume comes from official minute bars only (avoids double count).
          if (dt.range === '1D') {
            last.volume += t.size
            volumeSeriesRef.current?.update({ time: last.time, value: last.volume, color: 'rgba(120,123,134,0.3)' })
          }
          applyLast(last)
        }
        // bucket < last.time: late trade for an earlier bar — drop it.
      } else {
        const tradeDay = nyDateOf(t.time)
        if (typeof last.time !== 'string') return
        // Daily-bar volume accumulates from OFFICIAL minute bars only — adding
        // trade sizes here too would double-count every print (the minute bar
        // containing each trade also arrives via the stream).
        if (tradeDay > last.time) {
          const fresh: WorkingBar = { time: tradeDay as Time, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 }
          data.push(fresh)
          applyLast(fresh)
          // New session's volume column must exist in the histogram too.
          volumeSeriesRef.current?.update({ time: fresh.time, value: 0, color: 'rgba(120,123,134,0.3)' })
        } else if (tradeDay === last.time) {
          last.close = t.price
          last.high = Math.max(last.high, t.price)
          last.low = Math.min(last.low, t.price)
          applyLast(last)
        }
      }
    })

    const offBar = window.api.onStreamBar((b) => {
      const dt = tag()
      if (!dt || b.symbol !== dt.symbol) return
      const data = dataRef.current
      if (data.length === 0) return
      const last = data[data.length - 1]
      if (isIntradayRange(dt.range)) {
        if (typeof last.time !== 'number') return
        const bucketSec = dt.range === '1W' ? 900 : 60
        const bucket = (Math.floor(Date.parse(b.time) / (bucketSec * 1000)) * bucketSec) as UTCTimestamp
        if (bucket > last.time) {
          const bar: WorkingBar = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }
          data.push(bar)
          applyLast(bar)
          volumeSeriesRef.current?.update({ time: bar.time, value: bar.volume, color: 'rgba(120,123,134,0.3)' })
        } else if (bucket === last.time) {
          if (dt.range === '1D') {
            // 1-minute buckets: the official minute bar is authoritative — replace.
            data[data.length - 1] = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }
          } else {
            // 15-minute buckets: merge each official minute bar into the bucket.
            last.high = Math.max(last.high, b.high)
            last.low = Math.min(last.low, b.low)
            last.close = b.close
            last.volume += b.volume
          }
          const cur = data[data.length - 1]
          applyLast(cur)
          volumeSeriesRef.current?.update({ time: cur.time, value: cur.volume, color: 'rgba(120,123,134,0.3)' })
        } else {
          // Late official bar for an earlier bucket: correct dataRef only; the
          // chart cannot update history without a full setData, not worth it.
          const idx = data.findIndex((x) => x.time === bucket)
          if (idx >= 0 && dt.range === '1D') data[idx] = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }
        }
      } else {
        const day = nyDateOf(b.time)
        if (typeof last.time === 'string' && last.time === day) {
          last.high = Math.max(last.high, b.high)
          last.low = Math.min(last.low, b.low)
          last.close = b.close
          last.volume += b.volume
          applyLast(last)
          // Keep today's histogram column live too — otherwise it freezes at
          // its fetch-time value while the legend's Vol readout keeps growing.
          volumeSeriesRef.current?.update({ time: last.time, value: last.volume, color: 'rgba(120,123,134,0.3)' })
        }
      }
    })

    return () => {
      offTrade()
      offBar()
    }
  }, [])

  const data = dataRef.current
  const last = data.length ? data[data.length - 1] : null

  // Pinned pattern (clicked in the bottom panel) shows its own bar in the
  // legend while the mouse isn't hovering something else.
  const pinnedInfo: HoverInfo | null = (() => {
    if (!pinned || hover) return null
    const idx = data.findIndex((b) => String(b.time) === String(pinned.key))
    if (idx < 0) return null
    const b = data[idx]
    const prev = idx > 0 ? data[idx - 1] : null
    return {
      label: timeLabel(b.time),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      changePct: prev ? ((b.close - prev.close) / prev.close) * 100 : null,
      pattern: pinned
    }
  })()

  const shown: HoverInfo | null =
    hover ??
    pinnedInfo ??
    (last
      ? {
          label: timeLabel(last.time),
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
          volume: last.volume,
          changePct:
            data.length > 1 ? ((last.close - data[data.length - 2].close) / data[data.length - 2].close) * 100 : null
        }
      : null)

  const p = shown?.pattern ?? null

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} onMouseDown={clearPin} />
      {patternRects.map((r) => (
        <div
          key={r.id}
          data-pattern-rect={r.id}
          style={{
            position: 'absolute',
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            zIndex: 2, // above BOTH chart canvases (pane z1, top z2 — later DOM order wins the tie)
            pointerEvents: 'none',
            background: `rgba(${r.rgb},${r.active ? 0.22 : 0.1})`,
            border: r.active ? `2px solid rgba(${r.rgb},0.9)` : `1px dashed rgba(${r.rgb},0.55)`,
            borderRadius: 3,
            boxSizing: 'border-box'
          }}
        />
      ))}
      {shown && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 10,
            zIndex: 3,
            fontSize: 11.5,
            color: T.muted,
            background: p ? 'rgba(19,23,34,0.9)' : 'rgba(19,23,34,0.75)',
            padding: '3px 8px',
            borderRadius: 4,
            pointerEvents: 'none',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          <span style={{ color: T.text, fontWeight: 600 }}>{symbol}</span> · {shown.label} &nbsp; O{' '}
          <span style={{ color: T.text }}>{fmtPrice(shown.open)}</span> H{' '}
          <span style={{ color: T.text }}>{fmtPrice(shown.high)}</span> L{' '}
          <span style={{ color: T.text }}>{fmtPrice(shown.low)}</span> C{' '}
          <span style={{ color: T.text }}>{fmtPrice(shown.close)}</span>{' '}
          <span style={{ color: shown.changePct != null && shown.changePct < 0 ? T.down : T.up }}>
            {shown.changePct != null ? `${shown.changePct >= 0 ? '+' : ''}${shown.changePct.toFixed(2)}%` : ''}
          </span>
          &nbsp; Vol{' '}
          <span style={{ color: T.text }}>{Intl.NumberFormat('en', { notation: 'compact' }).format(shown.volume)}</span>
          {p && (
            <div style={{ marginTop: 5, maxWidth: 480, whiteSpace: 'normal', lineHeight: 1.5 }}>
              <div>
                <span style={{ color: dirColor(p.direction), fontWeight: 700 }}>{p.name}</span>
                <span style={{ color: T.muted }}>
                  {' '}
                  · {p.direction === 'bull' ? 'bullish' : p.direction === 'bear' ? 'bearish' : 'neutral'} annotation ·{' '}
                  {p.keys.length} candle{p.keys.length > 1 ? 's' : ''} (boxed)
                </span>
                {pinned && p === pinned && <span style={{ color: T.faint }}> · click the chart to dismiss</span>}
              </div>
              <div style={{ color: T.muted }}>{p.explanation}</div>
              {p.trend && (
                <div>
                  <span style={{ color: T.muted }}>Prior trend:</span>{' '}
                  <span style={{ color: T.text }}>
                    {p.trend.dir === 'down' ? 'decline' : p.trend.dir === 'up' ? 'advance' : 'sideways'} —{' '}
                    {p.trend.pct >= 0 ? '+' : ''}
                    {p.trend.pct.toFixed(1)}% over the prior {p.trend.bars} bars, close{' '}
                    {p.trend.dir === 'down' ? 'below' : p.trend.dir === 'up' ? 'above' : 'near'} the {p.trend.bars}-bar
                    average
                  </span>
                </div>
              )}
              {p.stats.map((s) => (
                <div key={s.label}>
                  <span style={{ color: T.muted }}>{s.label}:</span> <span style={{ color: T.text }}>{s.value}</span>
                </div>
              ))}
              {p.direction !== 'neutral' && (
                <div style={{ color: p.confirmed == null ? T.warn : p.confirmed ? T.up : T.down }}>
                  {p.confirmed == null
                    ? 'Confirmation pending — classical practice waits for the next candle to close in the pattern direction.'
                    : p.confirmed
                      ? 'Confirmed: the next candle closed in the pattern direction.'
                      : 'Not confirmed: the next candle closed against the pattern.'}
                </div>
              )}
              <div style={{ color: T.faint }}>{p.classic}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
