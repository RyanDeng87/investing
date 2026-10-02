// Candlestick pattern detection — ANNOTATIONS AND EDUCATION ONLY, never trade
// signals. The evidence (RESEARCH.md §2.2): Marshall/Young/Rose 2006 tested 28
// candlestick strategies on DJIA stocks and found no value for investors. This
// is how thinkorswim and TradingView treat patterns too: labels on the chart.
//
// Each hit carries the data classical candlestick analysis actually uses
// (Nison's Japanese Candlestick Charting Techniques; Bulkowski's Encyclopedia
// of Candlestick Charts):
//   - prior trend — reversal patterns only "count" against a preceding trend
//   - the measured shape criteria that triggered detection (wick/body ratios)
//   - volume vs its recent average (classical confirmation weight)
//   - whether the NEXT candle confirmed (Nison: act only after confirmation)
// so the chart inspector can show exactly where an annotation came from.
//
// Granularity-agnostic: works on daily bars (string date keys) and intraday
// bars (unix-second keys) alike, so detection matches the selected timeframe.

export interface PatternBar {
  t: string | number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface PatternStat {
  label: string
  value: string
}

export interface PatternTrend {
  dir: 'up' | 'down' | 'flat'
  pct: number // % change over the prior `bars` bars
  bars: number
}

export interface PatternHit {
  key: string | number // the signal (last) bar — marker anchor
  keys: (string | number)[] // every bar forming the pattern, oldest first
  name: string
  direction: 'bull' | 'bear' | 'neutral'
  explanation: string
  classic: string // the classical "estimate" plus the evidence caveat
  trend: PatternTrend | null // trend context the detection was gated on
  stats: PatternStat[] // measured shape criteria vs their thresholds
  confirmed: boolean | null // next close in pattern direction; null = awaiting next candle (or n/a for neutral)
}

const EXPLANATIONS: Record<string, string> = {
  Doji: 'Open and close nearly equal — indecision. Traditionally read as a potential pause or turn, but tested poorly as a standalone signal.',
  Hammer: 'Long lower shadow after a decline — sellers pushed price down, buyers pushed it back. Traditionally bullish-reversal lore; evidence says annotation, not action.',
  'Shooting star': 'Long upper shadow after an advance — buyers pushed up, sellers took it back. Traditional bearish-reversal lore; same evidence caveat.',
  'Bullish engulfing': 'A green body that fully engulfs the prior red body after a decline. One of the better-known reversal patterns — still no documented net-of-cost edge.',
  'Bearish engulfing': 'A red body that fully engulfs the prior green body after an advance. Mirror of the bullish version, same caveats.'
}

const CLASSICS: Record<string, string> = {
  Doji: 'Classical reading: equilibrium — after a strong run it warns momentum may be stalling. Bulkowski’s large-sample tests put doji outcomes near a coin flip, so treat it as context only.',
  Hammer: 'Classical estimate: bullish reversal of the preceding decline — valid only in downtrend context and, per Nison, only once the next candle closes higher (confirmation). Tested reversal rates are barely better than chance.',
  'Shooting star': 'Classical estimate: bearish reversal of the preceding advance, requiring a lower close on the next candle as confirmation. Same evidence caveat: tested edges are near zero after costs.',
  'Bullish engulfing': 'Classical estimate: buyers overwhelmed sellers — a candidate bottom, considered stronger on elevated volume and after next-candle confirmation. Marshall/Young/Rose found no net-of-cost edge.',
  'Bearish engulfing': 'Classical estimate: sellers overwhelmed buyers — a candidate top, same volume and confirmation logic, same evidence caveat.'
}

function smaAt(bars: PatternBar[], idx: number, window: number): number | null {
  if (idx + 1 < window) return null
  let sum = 0
  for (let i = idx - window + 1; i <= idx; i++) sum += bars[i].close
  return sum / window
}

// Trend context ending at bar i-1 (the bars BEFORE the signal candle) — the
// same 10-bar SMA comparison the detectors gate on, exposed for the inspector.
function trendAt(bars: PatternBar[], i: number): PatternTrend | null {
  const window = 10
  if (i < window) return null
  const sma = smaAt(bars, i - 1, window)
  if (sma == null) return null
  const prevClose = bars[i - 1].close
  const base = bars[i - window].close
  const pct = base !== 0 ? ((prevClose - base) / base) * 100 : 0
  const dir: PatternTrend['dir'] = prevClose < sma ? 'down' : prevClose > sma ? 'up' : 'flat'
  return { dir, pct, bars: window }
}

function volumeStat(bars: PatternBar[], i: number): PatternStat | null {
  const v = bars[i].volume
  if (v == null || v <= 0) return null
  let sum = 0
  let n = 0
  for (let j = Math.max(0, i - 20); j < i; j++) {
    const w = bars[j].volume
    if (w != null && w > 0) {
      sum += w
      n++
    }
  }
  if (n < 5) return null
  const ratio = v / (sum / n)
  return {
    label: 'Volume',
    value: `${ratio.toFixed(1)}× its ${n}-bar average${ratio >= 1.5 ? ' (classically adds weight)' : ''}`
  }
}

// Nison's confirmation rule: a reversal pattern "counts" only once the next
// candle closes in the pattern's direction. Null while the signal bar is the
// newest bar (confirmation pending) or for neutral patterns.
function confirmedBy(bars: PatternBar[], i: number, direction: PatternHit['direction']): boolean | null {
  if (direction === 'neutral') return null
  const next = bars[i + 1]
  if (!next) return null
  return direction === 'bull' ? next.close > bars[i].close : next.close < bars[i].close
}

const pc = (x: number): string => `${Math.round(x * 100)}%`

export function detectPatterns(bars: PatternBar[], lookback = 180): PatternHit[] {
  const hits: PatternHit[] = []
  const start = Math.max(10, bars.length - lookback)
  for (let i = start; i < bars.length; i++) {
    const b = bars[i]
    const range = b.high - b.low
    if (range <= 0) continue
    const body = Math.abs(b.close - b.open)
    const upper = b.high - Math.max(b.open, b.close)
    const lower = Math.min(b.open, b.close) - b.low
    const trendSma = smaAt(bars, i - 1, 10)
    const inDowntrend = trendSma != null && bars[i - 1].close < trendSma
    const inUptrend = trendSma != null && bars[i - 1].close > trendSma
    const trend = trendAt(bars, i)
    const vol = volumeStat(bars, i)
    const withVol = (stats: PatternStat[]): PatternStat[] => (vol ? [...stats, vol] : stats)

    if (body <= range * 0.08) {
      hits.push({
        key: b.t,
        keys: [b.t],
        name: 'Doji',
        direction: 'neutral',
        explanation: EXPLANATIONS.Doji,
        classic: CLASSICS.Doji,
        trend,
        stats: withVol([
          { label: 'Body', value: `${pc(body / range)} of the high–low range (doji threshold ≤ 8%)` },
          { label: 'Wicks', value: `upper ${pc(upper / range)} · lower ${pc(lower / range)} of the range` }
        ]),
        confirmed: confirmedBy(bars, i, 'neutral')
      })
      continue
    }
    if (inDowntrend && lower >= body * 2 && upper <= body * 0.5) {
      hits.push({
        key: b.t,
        keys: [b.t],
        name: 'Hammer',
        direction: 'bull',
        explanation: EXPLANATIONS.Hammer,
        classic: CLASSICS.Hammer,
        trend,
        stats: withVol([
          { label: 'Lower wick', value: `${(lower / body).toFixed(1)}× the body (needs ≥ 2×)` },
          { label: 'Upper wick', value: `${(upper / body).toFixed(1)}× the body (needs ≤ 0.5×)` }
        ]),
        confirmed: confirmedBy(bars, i, 'bull')
      })
      continue
    }
    if (inUptrend && upper >= body * 2 && lower <= body * 0.5) {
      hits.push({
        key: b.t,
        keys: [b.t],
        name: 'Shooting star',
        direction: 'bear',
        explanation: EXPLANATIONS['Shooting star'],
        classic: CLASSICS['Shooting star'],
        trend,
        stats: withVol([
          { label: 'Upper wick', value: `${(upper / body).toFixed(1)}× the body (needs ≥ 2×)` },
          { label: 'Lower wick', value: `${(lower / body).toFixed(1)}× the body (needs ≤ 0.5×)` }
        ]),
        confirmed: confirmedBy(bars, i, 'bear')
      })
      continue
    }
    const prev = bars[i - 1]
    const prevBody = Math.abs(prev.close - prev.open)
    if (prevBody > 0) {
      const prevRed = prev.close < prev.open
      const curGreen = b.close > b.open
      const engulfStats = (): PatternStat[] =>
        withVol([
          { label: 'Body', value: `${(body / prevBody).toFixed(1)}× the prior candle’s body (needs > 1×)` },
          {
            label: 'Coverage',
            value: `this open/close (${b.open.toFixed(2)} → ${b.close.toFixed(2)}) fully wraps the prior body (${prev.open.toFixed(2)} → ${prev.close.toFixed(2)})`
          }
        ])
      if (inDowntrend && prevRed && curGreen && b.close >= prev.open && b.open <= prev.close && body > prevBody) {
        hits.push({
          key: b.t,
          keys: [prev.t, b.t],
          name: 'Bullish engulfing',
          direction: 'bull',
          explanation: EXPLANATIONS['Bullish engulfing'],
          classic: CLASSICS['Bullish engulfing'],
          trend,
          stats: engulfStats(),
          confirmed: confirmedBy(bars, i, 'bull')
        })
        continue
      }
      if (inUptrend && !prevRed && !curGreen && b.open >= prev.close && b.close <= prev.open && body > prevBody) {
        hits.push({
          key: b.t,
          keys: [prev.t, b.t],
          name: 'Bearish engulfing',
          direction: 'bear',
          explanation: EXPLANATIONS['Bearish engulfing'],
          classic: CLASSICS['Bearish engulfing'],
          trend,
          stats: engulfStats(),
          confirmed: confirmedBy(bars, i, 'bear')
        })
      }
    }
  }
  return hits
}

export function formatPatternKey(key: string | number): string {
  if (typeof key === 'number') {
    return new Date(key * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }
  return key
}
