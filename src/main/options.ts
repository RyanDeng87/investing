import { getDb } from './db'
import { getSecret } from './keyvault'
import { fetchChain, fetchOpenInterest, fetchSpot, type AlpacaKeys, type OptionContractSnap } from './alpaca'
import { summarizeExpirations } from './collector'
import { latestFearGreed } from './feargreed'
import type { OptionsAnalytics, StrategyIdea } from '../shared/types'

// Phase 4 options analytics (RESEARCH.md §3). Every formula is the documented
// industry standard: tastytrade's IV Rank / IV Percentile, the one-standard-
// deviation expected move, 25Δ risk-reversal skew, and SqueezeMetrics naive GEX.
// Probability-of-profit uses the delta approximation (P(expire OTM) ≈ 1 − |Δ|)
// — a documented retail convention, disclosed as an approximation in the UI.
// Strategy rows are DOCUMENTED PRACTICE (tastytrade mechanics), never advice.

function nyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function mid(c: OptionContractSnap): number | null {
  // bid must be POSITIVE: a 0-bid contract is unsellable — using ask/2 as its
  // "credit" would put unrealizable premium in the screener.
  if (c.bid != null && c.bid > 0 && c.ask != null && c.ask >= c.bid) return (c.bid + c.ask) / 2
  return null
}

// Nearest-delta picks must actually be NEAR the target — on sparse chains a
// 0.62Δ call must not masquerade as "~30Δ".
const DELTA_TOLERANCE = 0.1

function nearestBy<T>(arr: T[], score: (t: T) => number): T | null {
  let best: T | null = null
  let bestScore = Infinity
  for (const t of arr) {
    const s = score(t)
    if (s < bestScore) {
      bestScore = s
      best = t
    }
  }
  return best
}

// IV Rank & Percentile from our own accumulated daily snapshots (Alpaca has no
// historical IV — RESEARCH.md §3.1). Partial history is labeled, never hidden.
function ivHistory(symbol: string): number[] {
  return (
    getDb()
      .prepare(
        "SELECT atm_iv_30d FROM iv_snapshots WHERE symbol = ? AND atm_iv_30d IS NOT NULL AND snapshot_date >= date('now', '-370 days') ORDER BY snapshot_date ASC"
      )
      .all(symbol) as { atm_iv_30d: number }[]
  ).map((r) => r.atm_iv_30d)
}

// Realized (close-to-close) volatility over the trailing n trading days,
// annualized. Total-return bars preferred so ex-dividend days don't register
// as phantom moves. IV minus this is the variance risk premium — the honest
// answer to "is this premium actually rich, or does the thing just move?".
function realizedVol(symbol: string, n: number): number | null {
  const db = getDb()
  for (const table of ['daily_bars_adj', 'daily_bars']) {
    const rows = db
      .prepare(`SELECT close FROM (SELECT close, date FROM ${table} WHERE symbol = ? ORDER BY date DESC LIMIT ?) ORDER BY date ASC`)
      .all(symbol, n + 1) as { close: number }[]
    if (rows.length < n + 1) continue
    const rets: number[] = []
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].close > 0 && rows[i].close > 0) rets.push(Math.log(rows[i].close / rows[i - 1].close))
    }
    if (rets.length < n * 0.8) continue
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const varSum = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1)
    return Math.sqrt(varSum) * Math.sqrt(252)
  }
  return null
}

function buildStrategies(chain: OptionContractSnap[], spot: number, today: string): StrategyIdea[] {
  const ideas: StrategyIdea[] = []
  const dteOf = (expiry: string): number => Math.round((Date.parse(expiry) - Date.parse(today)) / 86_400_000)
  // tastytrade-documented mechanics: ~30-45 DTE entry window.
  const expiries = [...new Set(chain.map((c) => c.expiry))]
    .map((e) => ({ expiry: e, dte: dteOf(e) }))
    .filter((e) => e.dte >= 25 && e.dte <= 60)
    .sort((a, b) => Math.abs(a.dte - 40) - Math.abs(b.dte - 40))
  const target = expiries[0]
  if (!target) return ideas
  const inExp = chain.filter((c) => c.expiry === target.expiry)

  // Shared reasoning steps, with the ACTUAL numbers each decision used — shown
  // when a strategy row is expanded in the Options tab.
  const expiryStep = `Expiry — ${expiries.length} expiration${expiries.length > 1 ? 's' : ''} fall in the 25–60 DTE screen window; picked ${target.expiry} (${target.dte} DTE) as the closest to ~40 DTE. Documented mechanics enter ~45 DTE, where theta (time decay) accelerates but gamma risk is still moderate.`
  const managementStep =
    'Management (documented practice, not advice) — tastytrade mechanics close or roll at 50% of max profit, or at ~21 DTE, whichever comes first, to dodge the gamma-heavy final weeks.'
  const strikeStep = (c: OptionContractSnap, kind: string, candidates: number): string =>
    `Strike — ${c.strike}${c.type} carries delta ${(c.delta as number).toFixed(2)}, the nearest to the ±0.30Δ target among ${candidates} quoted ${c.type === 'C' ? 'calls' : 'puts'} at this expiry (accepted only within ±0.10). ~30Δ ≈ a ~30% risk-neutral chance of finishing in the money — the documented balance of premium vs assignment risk for ${kind}.`
  const creditStep = (c: OptionContractSnap): string =>
    `Credit — mid of bid ${(c.bid as number).toFixed(2)} / ask ${(c.ask as number).toFixed(2)} = ${(mid(c) as number).toFixed(2)}. Fills near mid aren't guaranteed, and the free indicative feed can be stale off-hours; zero-bid contracts are rejected outright.`
  // Bid-ask spread as a fraction of mid — the tax liquidity charges on entry
  // AND exit. A wide spread quietly eats the credit the row advertises.
  const spreadOf = (c: OptionContractSnap): number | null => {
    const m = mid(c)
    return m != null && m > 0 && c.ask != null && c.bid != null ? (c.ask - c.bid) / m : null
  }
  const liquidityStep = (c: OptionContractSnap): string => {
    const sp = spreadOf(c)
    if (sp == null) return 'Liquidity — spread unavailable.'
    return `Liquidity — bid-ask spread ${(sp * 100).toFixed(0)}% of mid on the short leg. Crossing it twice (entry + exit) costs ~${(sp * 100).toFixed(0)}% of the credit${sp > 0.1 ? ' — WIDE; the mid-price return shown is optimistic, consider whether a limit near mid actually fills' : '; tight enough that mid-based math is a fair estimate'}.`
  }
  const popStep = (delta: number): string =>
    `~PoP ${((1 - Math.abs(delta)) * 100).toFixed(0)}% — the delta approximation P(expire OTM) ≈ 1 − |Δ| = 1 − ${Math.abs(delta).toFixed(2)}. Risk-neutral, ignores the premium received and fat tails; treat as a rough gauge, not a probability you can bank.`

  // Covered call: ~30Δ call.
  const ccCands = inExp.filter((c) => c.type === 'C' && c.delta != null && mid(c) != null)
  let cc = nearestBy(ccCands, (c) => Math.abs((c.delta as number) - 0.3))
  if (cc && Math.abs((cc.delta as number) - 0.3) > DELTA_TOLERANCE) cc = null
  if (cc) {
    const credit = mid(cc) as number
    ideas.push({
      kind: 'covered-call',
      label: 'Covered call',
      expiry: target.expiry,
      dte: target.dte,
      strikes: `sell ${cc.strike}C`,
      credit,
      creditPct: credit / spot,
      annualizedPct: (credit / spot) * (365 / target.dte),
      pop: cc.delta != null ? 1 - Math.abs(cc.delta) : null,
      spreadPct: spreadOf(cc),
      detail: `Own 100 shares, sell the ~30Δ call. Keeps premium if ${cc.strike} isn't exceeded at expiry; caps upside above it.`,
      rationale: [
        `Setup — own 100 shares of the underlying, sell 1 call against them. The premium is yours to keep; in exchange, upside above ${cc.strike} is capped until expiry.`,
        expiryStep,
        strikeStep(cc, 'covered calls', ccCands.length),
        creditStep(cc),
        liquidityStep(cc),
        `Return — ${credit.toFixed(2)} ÷ spot ${spot.toFixed(2)} = ${((credit / spot) * 100).toFixed(2)}% over ${target.dte} days (${(((credit / spot) * 365) / target.dte * 100).toFixed(1)}% simple-annualized). Annualization assumes repeatability — real chains won't always offer this.`,
        popStep(cc.delta as number),
        managementStep
      ]
    })
  }

  // Cash-secured put: ~30Δ put.
  const cspCands = inExp.filter((c) => c.type === 'P' && c.delta != null && mid(c) != null)
  let csp = nearestBy(cspCands, (c) => Math.abs((c.delta as number) + 0.3))
  if (csp && Math.abs((csp.delta as number) + 0.3) > DELTA_TOLERANCE) csp = null
  if (csp) {
    const credit = mid(csp) as number
    ideas.push({
      kind: 'csp',
      label: 'Cash-secured put',
      expiry: target.expiry,
      dte: target.dte,
      strikes: `sell ${csp.strike}P`,
      credit,
      creditPct: credit / csp.strike,
      annualizedPct: (credit / csp.strike) * (365 / target.dte),
      pop: csp.delta != null ? 1 - Math.abs(csp.delta) : null,
      spreadPct: spreadOf(csp),
      detail: `Hold $${(csp.strike * 100).toFixed(0)} collateral, sell the ~30Δ put. Keeps premium unless assigned below ${csp.strike}; that's buying the stock at an effective ${(csp.strike - credit).toFixed(2)}.`,
      rationale: [
        `Setup — hold $${(csp.strike * 100).toFixed(0)} in cash, sell 1 put. Below ${csp.strike} at expiry you're assigned 100 shares at an effective ${(csp.strike - credit).toFixed(2)} (strike − credit); otherwise the premium is the whole profit.`,
        expiryStep,
        strikeStep(csp, 'cash-secured puts', cspCands.length),
        creditStep(csp),
        liquidityStep(csp),
        `Return — ${credit.toFixed(2)} ÷ strike ${csp.strike} (the collateral at risk) = ${((credit / csp.strike) * 100).toFixed(2)}% over ${target.dte} days (${(((credit / csp.strike) * 365) / target.dte * 100).toFixed(1)}% simple-annualized).`,
        popStep(csp.delta as number),
        managementStep
      ]
    })
  }

  // Put credit spread: short ~30Δ put + long the next liquid strike below.
  if (csp) {
    const lower = inExp
      .filter((c) => c.type === 'P' && c.strike < csp.strike && mid(c) != null)
      .sort((a, b) => b.strike - a.strike)[0]
    const shortMid = mid(csp)
    const longMid = lower ? mid(lower) : null
    if (lower && shortMid != null && longMid != null && shortMid > longMid) {
      const credit = shortMid - longMid
      const width = csp.strike - lower.strike
      ideas.push({
        kind: 'put-credit-spread',
        label: 'Put credit spread',
        expiry: target.expiry,
        dte: target.dte,
        strikes: `sell ${csp.strike}P / buy ${lower.strike}P`,
        credit,
        creditPct: credit / width,
        annualizedPct: (credit / width) * (365 / target.dte),
        pop: csp.delta != null ? 1 - Math.abs(csp.delta) : null,
        spreadPct: spreadOf(csp),
        detail: `Defined risk: max loss ${(width - credit).toFixed(2)}/share (width ${width.toFixed(2)} − credit). Profits if price stays above ${csp.strike}.`,
        rationale: [
          `Setup — the defined-risk version of the cash-secured put: sell the ${csp.strike}P, buy the ${lower.strike}P as a floor. Max loss is capped at width − credit instead of the full assignment risk.`,
          expiryStep,
          `Strikes — short leg reuses the ~30Δ pick (${csp.strike}P, delta ${(csp.delta as number).toFixed(2)}); long leg is the next liquid strike below (${lower.strike}P, mid ${longMid.toFixed(2)}), giving a ${width.toFixed(2)}-wide spread.`,
          `Credit — short mid ${shortMid.toFixed(2)} − long mid ${longMid.toFixed(2)} = ${credit.toFixed(2)}. Max loss ${(width - credit).toFixed(2)}/share if the underlying closes below ${lower.strike} at expiry.`,
          `${liquidityStep(csp)} A two-leg spread crosses TWO bid-asks each way — liquidity costs roughly double the single-leg figure.`,
          `Return — ${credit.toFixed(2)} ÷ width ${width.toFixed(2)} (the capital at risk) = ${((credit / width) * 100).toFixed(2)}% over ${target.dte} days (${(((credit / width) * 365) / target.dte * 100).toFixed(1)}% simple-annualized).`,
          popStep(csp.delta as number),
          managementStep
        ]
      })
    }
  }
  return ideas
}

interface Cached {
  at: number
  analytics: OptionsAnalytics
}
const cache = new Map<string, Cached>()

export async function getOptionsAnalytics(symbol: string): Promise<OptionsAnalytics> {
  const sym = symbol.toUpperCase()
  const hit = cache.get(sym)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.analytics

  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  const asOf = new Date().toISOString()
  const base: OptionsAnalytics = {
    symbol: sym,
    asOf,
    spot: null,
    iv30: null,
    ivRank: null,
    ivPercentile: null,
    ivDays: 0,
    rv21: null,
    rv63: null,
    vrp: null,
    expectedMove30d: null,
    skew25d: null,
    termStructure: [],
    gexNaive: null,
    strategies: [],
    caveats: [
      'Quotes come from the free indicative options feed — mid prices can be stale, especially outside market hours.',
      'PoP uses the delta approximation P(expire OTM) ≈ 1 − |Δ| — risk-neutral, ignores the premium received and fat tails.',
      'Strategy rows are documented industry practice (tastytrade mechanics: ~30-45 DTE, ~30Δ), not recommendations.',
      'Open interest (feeding GEX) is exchange-reported once daily — it reflects the prior session, not intraday flow.'
    ],
    available: false
  }

  if (!keyId || !secret) {
    return { ...base, message: 'Alpaca keys not configured — set them in Settings.' }
  }
  const keys: AlpacaKeys = { keyId, secret }
  const today = nyDate()

  try {
    const spot = await fetchSpot(sym, keys)
    if (spot == null) return { ...base, message: 'No spot price available for this symbol.' }
    const chain = await fetchChain(sym, keys, today, nyDate2(65))
    if (chain.length === 0) return { ...base, spot, message: 'No listed options found for this symbol.' }

    // Open interest comes from the trading API's contracts endpoint (the data
    // API's snapshots lack it) — it feeds GEX. Degrades silently: OI stays
    // null and GEX shows "—".
    try {
      const oiMap = await fetchOpenInterest(sym, keys, today, nyDate2(65))
      for (const c of chain) {
        const oi = oiMap.get(c.osi)
        if (oi != null) c.oi = oi
      }
    } catch {
      /* trading API unavailable — GEX stays null */
    }

    const summaries = summarizeExpirations(chain, spot, today)
    const near30 = nearestBy(
      summaries.filter((s) => s.atmIv != null && s.dte >= 7),
      (s) => Math.abs(s.dte - 30)
    )
    const iv30 = near30?.atmIv ?? null

    // IV Rank / Percentile vs our accumulated snapshot history (tastytrade formulas).
    const hist = ivHistory(sym)
    let ivRank: number | null = null
    let ivPercentile: number | null = null
    if (iv30 != null && hist.length >= 5) {
      // Include today's live IV in the range — bounds the rank to 0-100 by
      // construction even when live IV exceeds anything yet collected.
      const lo = Math.min(...hist, iv30)
      const hi = Math.max(...hist, iv30)
      ivRank = hi > lo ? ((iv30 - lo) / (hi - lo)) * 100 : null
      ivPercentile = (hist.filter((v) => v < iv30).length / hist.length) * 100
    }

    // Variance risk premium: forward-looking IV vs backward-looking realized.
    // Persistently positive VRP is the documented reason premium selling has
    // an edge at all; a NEGATIVE reading means the market is pricing less
    // movement than has just been happening.
    const rv21 = realizedVol(sym, 21)
    const rv63 = realizedVol(sym, 63)
    const vrp = iv30 != null && rv21 != null ? iv30 - rv21 : null

    const expectedMove30d = iv30 != null ? { abs: spot * iv30 * Math.sqrt(30 / 365), pct: iv30 * Math.sqrt(30 / 365) } : null
    const skewSrc = summaries.filter((s) => s.call25dIv != null && s.put25dIv != null && s.dte >= 20)
    const nearSkew = nearestBy(skewSrc, (s) => Math.abs(s.dte - 30))
    const skew25d = nearSkew ? ((nearSkew.put25dIv as number) - (nearSkew.call25dIv as number)) * 100 : null
    const gexVals = summaries.map((s) => s.gexNaive).filter((v): v is number => v != null)
    const gexNaive = gexVals.length ? gexVals.reduce((a, b) => a + b, 0) : null

    const strategies = buildStrategies(chain, spot, today)
    // Volatility context belongs in every strategy's reasoning: premium selling
    // is classically favored when IV is rich relative to its own history.
    const ivLine =
      ivRank != null
        ? `IV context — IV Rank ${ivRank.toFixed(0)} on ${hist.length} days of locally collected history (matures ~252d). tastytrade's rule of thumb favors premium selling above ~50 rank; low rank means premium is historically cheap.`
        : `IV context — IV Rank unavailable (${hist.length} day${hist.length === 1 ? '' : 's'} of local IV history; needs ≥5). The screener still shows documented mechanics, but you can't yet judge whether this premium is rich or cheap vs its own history.`
    const vrpLine =
      vrp != null && iv30 != null && rv21 != null
        ? `Vol premium — IV30 ${(iv30 * 100).toFixed(1)}% vs 21-day realized ${(rv21 * 100).toFixed(1)}% → ${vrp >= 0 ? '+' : ''}${(vrp * 100).toFixed(1)} pts. ${vrp > 0 ? 'Positive: options are pricing more movement than has been happening — the seller’s classical edge (which is compensation for gap risk, not free money).' : 'NEGATIVE: options are pricing LESS movement than is actually happening — the premium here is thin for the risk; sellers have no statistical tailwind.'}`
        : null
    for (const s of strategies) {
      s.rationale.push(ivLine)
      if (vrpLine) s.rationale.push(vrpLine)
    }

    // Market-stress caution: rich premium at sentiment/vol extremes is rich
    // for a reason — documented practice cuts SIZE at extremes, not adds.
    const fg = latestFearGreed(4)
    const stressed = (fg != null && fg.score <= 25) || (ivRank != null && ivRank >= 90)
    if (stressed) {
      const why = [
        fg != null && fg.score <= 25 ? `Fear & Greed ${fg.score.toFixed(0)} (extreme fear)` : null,
        ivRank != null && ivRank >= 90 ? `IV Rank ${ivRank.toFixed(0)}` : null
      ].filter(Boolean).join(' and ')
      const stressLine = `⚠ Market stress — ${why}. Premiums are inflated because crash risk is elevated RIGHT NOW: assignment and gap-through-strike odds are worst exactly when credits look juiciest. Documented practice at extremes is smaller size and defined risk, never "more because it pays more".`
      for (const s of strategies) s.rationale.push(stressLine)
      base.caveats.push(stressLine)
    }

    const analytics: OptionsAnalytics = {
      ...base,
      available: true,
      spot,
      iv30,
      ivRank,
      ivPercentile,
      ivDays: hist.length,
      rv21,
      rv63,
      vrp,
      expectedMove30d,
      skew25d,
      termStructure: summaries.map((s) => ({ expiry: s.expiry, dte: s.dte, atmIv: s.atmIv })),
      gexNaive,
      strategies
    }
    cache.set(sym, { at: Date.now(), analytics })
    return analytics
  } catch (e) {
    return { ...base, message: `Options data unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function nyDate2(offsetDays: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date(Date.now() + offsetDays * 86_400_000)
  )
}
