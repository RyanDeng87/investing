import { getDb, logJob } from './db'
import { getSignals } from './signals'
import { scoreSymbol } from './scoring'
import { ivRank370 } from './predictions'
import { getNextEarnings } from './earnings'
import { latestFearGreed } from './feargreed'
import type { StanceAction, StanceReason, StanceReport } from '../shared/types'

// Stance engine: a rule-based buy/hold/sell synthesis of the app's OWN
// engines — nothing here is new information, it is the Buffett score, the
// signal tilt, the MA regime, and market-level Fear & Greed folded into one
// legible verdict with the arithmetic shown. Two design rules keep it honest:
//   1. Every input's actual value appears in the reasons list — the (i) popup
//      IS the calculation, not a rationalization of it.
//   2. Buy/sell stances on ★ starred symbols are recorded daily into
//      prediction_snapshots and graded against SPY in the Journal's track
//      record. The stance must live with its own scoreboard.

// Component weights. Quality/valuation and momentum carry the engine; trend
// regime and market sentiment are deliberately small (regime timing is
// systematically overstated — Zakamulin 2014; F&G contrarianism has weak
// evidence outside extremes). Weights renormalize over available components.
const W = { quality: 0.35, momentum: 0.35, trend: 0.15, sentiment: 0.15 } as const

const BUY_THRESHOLD = 15
const SELL_THRESHOLD = -15

const DISCLOSURES = [
  'A rule-based synthesis of the same engines shown on the other tabs — agreement here is NOT independent confirmation, it is the same data folded once more.',
  'Not financial advice. The rules cannot see your cost basis, taxes, allocation, or cash needs. "Sell" means the tracked data no longer supports holding — not a top call, and not a reason to override a plan you made calmly.',
  'Buy/sell stances on ★ starred symbols are timestamped daily and graded against SPY in the Journal’s track record. Judge the rules by that scoreboard, not by how confident they sound.'
]

interface Component {
  key: 'quality' | 'momentum' | 'trend' | 'sentiment'
  value: number // -1..+1
  weight: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function timeframeFor(components: Component[]): { label: string; horizonDays: number } {
  const q = components.find((c) => c.key === 'quality')
  const m = components.find((c) => c.key === 'momentum')
  // Quality/valuation theses play out over years; momentum's documented
  // horizon is months. The dominant contributor sets the clock.
  if (q && (!m || Math.abs(q.value) * W.quality >= Math.abs(m.value) * W.momentum)) {
    return { label: '6–18 months', horizonDays: 252 }
  }
  return { label: '3–12 months', horizonDays: 126 }
}

export async function getStance(symbol: string): Promise<StanceReport> {
  const sym = symbol.toUpperCase()
  const asOf = new Date().toISOString()
  const db = getDb()
  const starred =
    (db.prepare('SELECT favorite FROM watchlist WHERE symbol = ?').get(sym) as { favorite: number } | undefined)?.favorite === 1

  const components: Component[] = []
  const reasons: StanceReason[] = []
  const cautions: string[] = []
  let isEtf = false

  // --- Quality / valuation: the Buffett engine's QARP percentile ---
  try {
    const score = scoreSymbol(sym)
    if (score.available && score.qarp != null) {
      const v = clamp((score.qarp - 50) / 50, -1, 1)
      components.push({ key: 'quality', value: v, weight: W.quality })
      reasons.push({
        text: `QARP ${score.qarp.toFixed(0)}th percentile of ${score.universeScored} scored names (65% quality / 35% value) — ${score.qarp >= 70 ? 'quality at a reasonable price' : score.qarp <= 30 ? 'ranks poorly on quality-and-price combined' : 'middling on quality-and-price combined'}`,
        direction: v > 0.1 ? 'for' : v < -0.1 ? 'against' : 'neutral'
      })
      if (score.universeScored < 30) {
        cautions.push(`QARP percentile ranks against only ${score.universeScored} crawled names so far — it firms up as the rolling crawl fills in.`)
      }
    } else {
      isEtf = true // no single-company fundamentals: ETF or not-yet-crawled
      reasons.push({
        text: 'No fundamentals pillar (ETF or not yet crawled) — judged on momentum, trend, and market sentiment only',
        direction: 'neutral'
      })
    }
  } catch {
    cautions.push('Buffett score unavailable right now — stance computed without the quality pillar.')
  }

  // --- Momentum: the Signals tab's evidence-based tilt ---
  let regimeNote: { above: boolean; golden: boolean | null } | null = null
  try {
    const sig = await getSignals(sym)
    if (sig.tilt != null && sig.confidence !== 'none') {
      const v = clamp(sig.tilt / 100, -1, 1)
      components.push({ key: 'momentum', value: v, weight: W.momentum })
      reasons.push({
        text: `Signal tilt ${sig.tilt >= 0 ? '+' : ''}${sig.tilt.toFixed(0)} (${sig.label}; momentum / earnings drift / analyst revisions)`,
        direction: v > 0.1 ? 'for' : v < -0.1 ? 'against' : 'neutral'
      })
    }
    if (sig.regime) {
      regimeNote = { above: sig.regime.aboveSma200, golden: sig.regime.goldenCross }
      const above = sig.regime.aboveSma200
      const golden = sig.regime.goldenCross
      const v = (above ? 0.2 : -0.2) + (golden == null ? 0 : golden ? 0.2 : -0.2)
      components.push({ key: 'trend', value: v, weight: W.trend })
      reasons.push({
        text: `Price ${above ? 'above' : 'below'} its 200-day MA${golden != null ? `, 50-day ${golden ? 'above' : 'below'} 200-day` : ''} — regime description, weighted small on purpose`,
        direction: v > 0.1 ? 'for' : v < -0.1 ? 'against' : 'neutral'
      })
    }
  } catch {
    cautions.push('Signals unavailable right now — stance computed without the momentum pillar.')
  }

  // --- Market sentiment: CNN Fear & Greed, contrarian, extremes only ---
  const fg = latestFearGreed(4)
  if (fg) {
    const extreme = fg.score <= 25 ? 0.5 : fg.score >= 75 ? -0.5 : 0
    components.push({ key: 'sentiment', value: extreme, weight: W.sentiment })
    reasons.push({
      text: `Fear & Greed ${fg.score.toFixed(0)} (${fg.rating || 'n/a'}, ${fg.date}) — ${
        extreme > 0
          ? 'extreme fear; the contrarian read is a mild tailwind for adding to quality'
          : extreme < 0
            ? 'extreme greed; the contrarian read is caution on new buys'
            : 'mid-range, treated as no information'
      }`,
      direction: extreme > 0 ? 'for' : extreme < 0 ? 'against' : 'neutral'
    })
  }

  if (components.length === 0) {
    return {
      symbol: sym,
      asOf,
      available: false,
      action: 'hold',
      timeframe: '—',
      horizonDays: 0,
      confidence: 'low',
      confidenceDetail: 'no inputs available',
      composite: 0,
      reasons,
      cautions,
      isEtf,
      tracked: false,
      disclosures: DISCLOSURES,
      message: 'Not enough data to form a stance — needs at least price history (view the symbol to backfill) or crawled fundamentals.'
    }
  }

  // --- Composite: weighted mean over available components, -100..+100 ---
  let acc = 0
  let wSum = 0
  for (const c of components) {
    acc += c.value * c.weight
    wSum += c.weight
  }
  const composite = (acc / wSum) * 100
  const action: StanceAction = composite >= BUY_THRESHOLD ? 'buy' : composite <= SELL_THRESHOLD ? 'sell' : 'hold'

  // --- Confidence: agreement among non-neutral components, honestly capped ---
  const directional = components.filter((c) => Math.abs(c.value) >= 0.1)
  const agreeing = directional.filter((c) => Math.sign(c.value) === Math.sign(composite)).length
  let confidence: StanceReport['confidence']
  let confidenceDetail: string
  if (action === 'hold') {
    const conflicted = directional.length >= 2 && agreeing < directional.length
    confidence = conflicted ? 'low' : 'medium'
    confidenceDetail = conflicted
      ? `hold by disagreement — ${directional.length} inputs point in conflicting directions`
      : 'hold by genuine neutrality — no input leans hard either way'
  } else if (directional.length >= 3 && agreeing === directional.length && Math.abs(composite) >= 35) {
    confidence = 'high'
    confidenceDetail = `all ${directional.length} directional inputs agree and the composite is strong (${composite.toFixed(0)})`
  } else if (agreeing >= 2 && agreeing > directional.length - agreeing) {
    confidence = 'medium'
    confidenceDetail = `${agreeing} of ${directional.length} directional inputs agree`
  } else {
    confidence = 'low'
    confidenceDetail = `only ${agreeing} of ${directional.length} directional inputs agree`
  }

  // --- Timing context (never part of the composite) ---
  try {
    const iv = ivRank370(sym)
    if (iv && (iv.rank >= 70 || iv.rank <= 30)) {
      cautions.push(
        iv.rank >= 70
          ? `IV Rank ${iv.rank.toFixed(0)} — options rich; if entering, limit orders beat market chases, and option sellers get paid more than usual.`
          : `IV Rank ${iv.rank.toFixed(0)} — options cheap; protective or speculative options cost less than usual.`
      )
    }
  } catch {
    /* IV context is optional */
  }
  try {
    const ev = await getNextEarnings(sym)
    if (ev && ev.daysUntil <= 10) {
      cautions.push(`Earnings in ${ev.daysUntil} day${ev.daysUntil === 1 ? '' : 's'} (${ev.date}) — event risk; the stance can flip on one report.`)
    }
  } catch {
    /* earnings context is optional */
  }
  if (isEtf && regimeNote == null && components.length <= 1) {
    cautions.push('Thin inputs for this symbol — treat the stance as barely better than a coin flip.')
  }

  const tf = timeframeFor(components)
  return {
    symbol: sym,
    asOf,
    available: true,
    action,
    timeframe: tf.label,
    horizonDays: tf.horizonDays,
    confidence,
    confidenceDetail,
    composite,
    reasons,
    cautions,
    isEtf,
    tracked: starred,
    disclosures: DISCLOSURES
  }
}

// Daily accountability sweep: record buy/sell stances for ★ starred symbols
// (holds make no claim, so they are not graded) plus a market-level Fear &
// Greed contrarian call when the index is at an extreme. Idempotent per day.
// Called from the collector chain after bars/fundamentals/F&G are fresh.
export async function recordStanceSnapshots(): Promise<{ recorded: number }> {
  const db = getDb()
  const today = new Date().toLocaleDateString('sv')
  const insert = db.prepare(
    'INSERT OR IGNORE INTO prediction_snapshots(snapshot_date, symbol, kind, value, horizon_days, meta) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const starred = (db.prepare('SELECT symbol FROM watchlist WHERE favorite = 1 ORDER BY symbol').all() as { symbol: string }[]).map(
    (r) => r.symbol
  )
  let recorded = 0
  for (const symbol of starred) {
    try {
      const s = await getStance(symbol)
      if (s.available && s.action !== 'hold') {
        recorded += insert.run(
          today,
          symbol,
          'stance',
          s.composite,
          s.horizonDays,
          JSON.stringify({ action: s.action, timeframe: s.timeframe, confidence: s.confidence })
        ).changes
      }
    } catch {
      /* per-symbol failure must not stop the sweep */
    }
  }
  // Fear & Greed extremes: a contrarian claim about SPY over the next month.
  // Only same-day readings count — recording a stale extreme would timestamp
  // a prediction the market has already had days to answer.
  const fg = latestFearGreed(1.5)
  if (fg && (fg.score <= 25 || fg.score >= 75)) {
    recorded += insert.run(today, 'SPY', 'fear_greed', fg.score, 21, fg.rating).changes
  }
  if (recorded > 0) logJob('stance', 'ok', `${recorded} stance/sentiment snapshots (${starred.length} starred)`)
  return { recorded }
}
