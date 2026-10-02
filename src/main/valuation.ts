import { metricsForSymbol } from './scoring'
import type { ReverseDcf } from '../shared/types'

// Reverse DCF — the absolute-valuation anchor the percentile scores can't be.
// Instead of forecasting cash flows (a guess dressed as math), it INVERTS the
// price: given the TTM FCF yield, what 10-year growth rate makes a two-stage
// DCF equal today's market cap? The output is an assumption to judge against
// what the business has actually done, not a price target.
//
// Math: P = FCF × [ Σ_{t=1..10} ((1+g)/(1+r))^t + (1+g)^10 (1+gT) / ((r−gT)(1+r)^10) ]
// Dividing by P leaves 1 = y × f(g, r) with y = FCF/P — only the YIELD is
// needed, no market cap. f is strictly increasing in g → bisection is safe.

const TERMINAL_GROWTH = 0.025 // ≈ long-run nominal GDP; every DCF hides one of these
const G_LO = -0.9
const G_HI = 1.0

function dcfFactor(g: number, r: number): number {
  let pv = 0
  for (let t = 1; t <= 10; t++) pv += Math.pow(1 + g, t) / Math.pow(1 + r, t)
  pv += (Math.pow(1 + g, 10) * (1 + TERMINAL_GROWTH)) / ((r - TERMINAL_GROWTH) * Math.pow(1 + r, 10))
  return pv
}

// g such that y × f(g, r) = 1. Clamps at the domain edges: below G_LO the
// price implies faster-than-90%/decade decline; above G_HI (>100%/yr for a
// decade) no sane growth justifies the price via this model.
function solveImpliedGrowth(y: number, r: number): number | null {
  if (y <= 0 || r <= TERMINAL_GROWTH) return null
  if (y * dcfFactor(G_LO, r) >= 1) return G_LO
  if (y * dcfFactor(G_HI, r) <= 1) return null
  let lo = G_LO
  let hi = G_HI
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (y * dcfFactor(mid, r) < 1) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

export function getReverseDcf(symbol: string): ReverseDcf {
  const sym = symbol.toUpperCase()
  const asOf = new Date().toISOString()
  const base: Omit<ReverseDcf, 'message'> = {
    symbol: sym,
    asOf,
    available: false,
    basis: 'fcf',
    yieldUsed: 0,
    impliedGrowth: null,
    sensitivity: [],
    histRevenueCagr: null,
    histEpsCagr: null,
    explanation: [],
    caveats: []
  }

  const m = metricsForSymbol(sym)
  if (!m) {
    return {
      ...base,
      message: 'No fundamentals for this symbol (ETF, or not yet reached by the rolling crawl). A fund is priced as its holdings — reverse DCF applies to single companies.'
    }
  }

  // FCF is the honest basis; fall back to earnings yield when FCF is missing
  // (EDGAR-only symbols sometimes lack the capex detail), disclosed as such.
  let basis: ReverseDcf['basis'] = 'fcf'
  let y = m.fcfYield
  if (y == null || y === 0) {
    basis = 'earnings'
    y = m.earningsYield
  }
  if (y == null) {
    return { ...base, dataSource: m.dataSource, message: 'Neither FCF yield nor earnings yield is available yet for this symbol — the crawl fills these in over days.' }
  }
  if (y <= 0) {
    return {
      ...base,
      basis,
      yieldUsed: y,
      dataSource: m.dataSource,
      message: `Negative ${basis === 'fcf' ? 'free cash flow' : 'earnings'} (TTM) — a DCF cannot price a loss-maker. Today's price rests entirely on a turnaround/scale story this model can't see; that isn't a verdict, but it IS a fact worth knowing.`
    }
  }

  const rates = [0.08, 0.1, 0.12]
  const sensitivity = rates.map((r) => ({ requiredReturn: r, impliedGrowth: solveImpliedGrowth(y as number, r) }))
  const implied = sensitivity[1].impliedGrowth

  const explanation: string[] = [
    `Model — 10 years of ${basis === 'fcf' ? 'free-cash-flow' : 'earnings'} growth at a solved rate, then a terminal value growing ${pct(TERMINAL_GROWTH)}/yr forever, discounted at your required return. Input: TTM ${basis === 'fcf' ? 'FCF' : 'earnings'} yield ${pct(y)}.`,
    implied != null
      ? `Solved — today's price is exactly justified by ${pct(implied)}/yr growth for a decade at a 10% required return${sensitivity[0].impliedGrowth != null && sensitivity[2].impliedGrowth != null ? ` (8% return → ${pct(sensitivity[0].impliedGrowth)}, 12% → ${pct(sensitivity[2].impliedGrowth)})` : ''}.`
      : 'Solved — no growth rate under 100%/yr justifies today\'s price at a 10% required return. The market is paying for something this model cannot express.',
    `Judge it, don't obey it — trailing ~5y revenue CAGR ${m.revenueCagr != null ? pct(m.revenueCagr) : 'n/a'}, EPS CAGR ${m.epsCagr != null ? pct(m.epsCagr) : 'n/a'}. Implied growth far ABOVE the trailing record means the price demands acceleration; far below means the market prices decline (or the TTM input is distorted this year).`
  ]

  return {
    ...base,
    available: true,
    basis,
    yieldUsed: y,
    impliedGrowth: implied,
    sensitivity,
    histRevenueCagr: m.revenueCagr,
    histEpsCagr: m.epsCagr,
    dataSource: m.dataSource,
    explanation,
    caveats: [
      'TTM cash flow is ONE noisy year — capex cycles, working capital swings, and stock-comp treatment all distort it. Treat ±3 pts of implied growth as noise.',
      'A two-stage model with a fixed terminal rate is a toy, deliberately: its job is to translate price into one legible assumption, not to value the business.',
      'Not meaningful for financials (FCF is ill-defined for banks/insurers) or businesses at a capital-cycle peak or trough.',
      basis === 'earnings' ? 'FCF yield was unavailable — earnings-yield basis overstates cash generation for capex-heavy businesses.' : ''
    ].filter(Boolean)
  }
}
