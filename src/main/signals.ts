import { getDb } from './db'
import { getSecret } from './keyvault'
import { finnhubBudget } from './budgeter'
import type { SignalInput, SignalReport } from '../shared/types'

// Signal Monitor (RESEARCH.md §2): the PREDICTION side of the app, kept separate
// from the Buffett engine and deliberately humble. Inputs are limited to signal
// families with documented replication evidence:
//   - 12-1 momentum (Hou/Xue/Zhang 2020: momentum replicates ~63%)
//   - Post-earnings-announcement drift (Bernard & Thomas 1989, ~60 trading days)
//   - Analyst revision momentum (1-6 month horizon)
// Moving-average state is reported as a REGIME DESCRIPTION only, never a signal
// (Zakamulin 2014: timing-rule backtests systematically overstated).
// Output is a weak probabilistic tilt with attribution — never a forecast.

const WEIGHTS: Record<string, number> = { momentum: 0.45, pead: 0.3, revisions: 0.25 }

const DISCLOSURES = [
  'Most published return predictors fail out-of-sample (Goyal/Welch/Zafirov 2024; Hou/Xue/Zhang 2020). This tilt uses the few families that replicate, and they are weak — expect base-rate-sized edges, not certainty.',
  'The Buffett engine deliberately ignores everything on this tab: Berkshire loads on value/quality/low-beta factors with NO momentum exposure. Mixing the two would be neither.',
  'Moving-average state is a description of where price is, not advice on where it goes (timing backtests are systematically overstated — Zakamulin 2014).'
]

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function closes(symbol: string): { date: string; close: number }[] {
  return getDb()
    .prepare('SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date ASC')
    .all(symbol) as { date: string; close: number }[]
}

// 12-1 momentum: return from ~12 months ago to ~1 month ago (skip the last month
// to avoid short-term reversal). Needs ~253 trading days of history.
function momentum12_1(symbol: string): number | null {
  const c = closes(symbol)
  const n = c.length
  if (n < 253) return null
  const endPx = c[n - 22].close // lag 21 trading days (~1 month)
  const startPx = c[n - 253].close // lag 252 trading days (~12 months)
  if (startPx <= 0) return null
  return endPx / startPx - 1
}

function sma(values: number[], window: number): number | null {
  if (values.length < window) return null
  let sum = 0
  for (let i = values.length - window; i < values.length; i++) sum += values[i]
  return sum / window
}

async function finnhubGet(path: string): Promise<unknown | null> {
  const token = getSecret('finnhub_key')
  if (!token) return null
  await finnhubBudget.take()
  const res = await fetch(`https://finnhub.io/api/v1${path}`, { headers: { 'X-Finnhub-Token': token } })
  if (!res.ok) return null
  return res.json()
}

interface Cached {
  at: number
  report: SignalReport
}
const cache = new Map<string, Cached>()

export async function getSignals(symbol: string): Promise<SignalReport> {
  const sym = symbol.toUpperCase()
  const hit = cache.get(sym)
  if (hit && Date.now() - hit.at < 6 * 60 * 60_000) return hit.report

  const inputs: SignalInput[] = []

  // --- Momentum (cross-sectional percentile within symbols we have history for) ---
  const own = momentum12_1(sym)
  if (own != null) {
    const peers = (
      getDb().prepare('SELECT DISTINCT symbol FROM daily_bars').all() as { symbol: string }[]
    ).map((r) => r.symbol)
    const peerVals: number[] = []
    for (const p of peers) {
      const v = momentum12_1(p)
      if (v != null) peerVals.push(v)
    }
    let contribution: number
    let detail: string
    if (peerVals.length >= 8) {
      const below = peerVals.filter((v) => v < own).length
      const pct = (below / peerVals.length) * 100
      contribution = clamp((pct - 50) / 50, -1, 1)
      detail = `12-1 month return ${(own * 100).toFixed(1)}% — ${pct.toFixed(0)}th percentile of ${peerVals.length} tracked symbols`
    } else {
      contribution = clamp(own / 0.5, -1, 1)
      detail = `12-1 month return ${(own * 100).toFixed(1)}% (too few tracked peers for a percentile)`
    }
    inputs.push({
      key: 'momentum',
      label: '12-1 momentum',
      value: `${own >= 0 ? '+' : ''}${(own * 100).toFixed(1)}%`,
      contribution,
      horizon: '3–12 months',
      evidence:
        'Price momentum is among the best-replicating anomaly families (63% replicate under value-weighted tests — Hou/Xue/Zhang, RFS 2020). The last month is skipped to avoid short-term reversal.',
      detail
    })
  } else {
    inputs.push({
      key: 'momentum',
      label: '12-1 momentum',
      value: '—',
      contribution: null,
      horizon: '3–12 months',
      evidence: 'Needs ~1 year of daily bars; view the symbol once to backfill its history.',
      detail: 'Insufficient price history cached'
    })
  }

  // --- PEAD: latest earnings surprise, decaying over the ~60-trading-day drift window ---
  try {
    const earnings = (await finnhubGet(`/stock/earnings?symbol=${sym}`)) as
      | { actual?: number; estimate?: number; period?: string }[]
      | null
    // Don't assume API ordering — pick the most recent usable quarter explicitly.
    const latest = Array.isArray(earnings)
      ? earnings
          .filter((e) => e.actual != null && e.estimate != null && e.period)
          .sort((a, b) => String(b.period).localeCompare(String(a.period)))[0] ?? null
      : null
    if (latest && latest.estimate !== 0) {
      const surprise = (Number(latest.actual) - Number(latest.estimate)) / Math.abs(Number(latest.estimate))
      const daysSince = Math.floor((Date.now() - Date.parse(latest.period as string)) / 86_400_000)
      // Reports land ~30-45 days after the quarter ends; drift runs ~60 trading
      // (~90 calendar) days after the report → ~135 calendar days post period-end.
      const fresh = daysSince <= 135
      const decay = fresh ? 1 - Math.max(0, daysSince - 45) / 90 : 0
      // Outside the drift window the input carries NO information — null keeps it
      // out of the weighted tilt and the confidence count (0 would dilute both).
      const contribution = fresh ? clamp(surprise * 5, -1, 1) * clamp(decay, 0, 1) : null
      inputs.push({
        key: 'pead',
        label: 'Earnings surprise drift',
        value: `${surprise >= 0 ? '+' : ''}${(surprise * 100).toFixed(1)}%`,
        contribution,
        horizon: '~60 trading days post-report',
        evidence:
          'Post-earnings-announcement drift: prices keep moving in the surprise direction for ~60 trading days (Bernard & Thomas 1989, ~2%/side per quarter historically).',
        detail: `Last surprise ${(surprise * 100).toFixed(1)}% vs estimate, quarter ended ${latest.period} (${daysSince}d ago)${fresh ? '' : ' — outside the drift window, no contribution'}`
      })
    } else {
      inputs.push({
        key: 'pead',
        label: 'Earnings surprise drift',
        value: '—',
        contribution: null,
        horizon: '~60 trading days post-report',
        evidence: 'Post-earnings-announcement drift (Bernard & Thomas 1989).',
        detail: 'No earnings surprise data (ETF, no coverage, or Finnhub key missing)'
      })
    }
  } catch {
    inputs.push({
      key: 'pead',
      label: 'Earnings surprise drift',
      value: '—',
      contribution: null,
      horizon: '~60 trading days post-report',
      evidence: 'Post-earnings-announcement drift (Bernard & Thomas 1989).',
      detail: 'Earnings data unavailable right now'
    })
  }

  // --- Analyst revision momentum: change in buy-ratio over ~3 months ---
  try {
    const recs = (await finnhubGet(`/stock/recommendation?symbol=${sym}`)) as
      | { period?: string; strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }[]
      | null
    const sorted = Array.isArray(recs) ? [...recs].sort((a, b) => String(b.period).localeCompare(String(a.period))) : null
    if (sorted && sorted.length >= 4) {
      const recsOrdered = sorted
      const ratio = (r: (typeof recsOrdered)[number]): number | null => {
        const total = (r.strongBuy ?? 0) + (r.buy ?? 0) + (r.hold ?? 0) + (r.sell ?? 0) + (r.strongSell ?? 0)
        return total > 0 ? ((r.strongBuy ?? 0) + (r.buy ?? 0)) / total : null
      }
      const now = ratio(recsOrdered[0])
      const past = ratio(recsOrdered[3])
      if (now != null && past != null) {
        const delta = now - past
        inputs.push({
          key: 'revisions',
          label: 'Analyst revision trend',
          value: `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pt buy-ratio (3mo)`,
          contribution: clamp(delta * 4, -1, 1),
          horizon: '1–6 months',
          evidence:
            'Prices drift in the direction of analyst revisions for roughly six months (revision momentum literature; see RESEARCH.md §2.3).',
          detail: `Buy ratio ${(now * 100).toFixed(0)}% (${recsOrdered[0].period}) vs ${(past * 100).toFixed(0)}% three months earlier (${recsOrdered[3].period})`
        })
      }
    }
    if (!inputs.some((i) => i.key === 'revisions')) {
      inputs.push({
        key: 'revisions',
        label: 'Analyst revision trend',
        value: '—',
        contribution: null,
        horizon: '1–6 months',
        evidence: 'Analyst revision momentum (1–6 month drift).',
        detail: 'No recommendation trend data (ETF, no coverage, or Finnhub key missing)'
      })
    }
  } catch {
    inputs.push({
      key: 'revisions',
      label: 'Analyst revision trend',
      value: '—',
      contribution: null,
      horizon: '1–6 months',
      evidence: 'Analyst revision momentum (1–6 month drift).',
      detail: 'Recommendation data unavailable right now'
    })
  }

  // --- MA regime (descriptive only, not part of the tilt) ---
  const series = closes(sym).map((r) => r.close)
  const price = series.length ? series[series.length - 1] : null
  const sma50 = sma(series, 50)
  const sma200 = sma(series, 200)
  const regime =
    price != null && sma200 != null
      ? {
          price,
          sma50,
          sma200,
          aboveSma200: price > sma200,
          goldenCross: sma50 != null ? sma50 > sma200 : null
        }
      : null

  // --- Aggregate tilt over available inputs, weights renormalized ---
  const active = inputs.filter((i) => i.contribution != null)
  let tilt: number | null = null
  if (active.length > 0) {
    let weightSum = 0
    let acc = 0
    for (const i of active) {
      const w = WEIGHTS[i.key] ?? 0.2
      weightSum += w
      acc += w * (i.contribution as number)
    }
    tilt = weightSum > 0 ? (acc / weightSum) * 100 : null
  }
  const magnitude = tilt == null ? null : Math.abs(tilt)
  const label =
    tilt == null
      ? 'no signal'
      : (magnitude as number) < 10
        ? 'neutral'
        : `${(magnitude as number) < 35 ? 'weak' : (magnitude as number) < 65 ? 'moderate' : 'strong'} ${tilt > 0 ? 'bullish' : 'bearish'} tilt`
  const confidence: SignalReport['confidence'] = active.length >= 3 ? 'medium' : active.length >= 1 ? 'low' : 'none'

  const report: SignalReport = {
    symbol: sym,
    asOf: new Date().toISOString(),
    tilt,
    label,
    confidence,
    inputs,
    regime,
    disclosures: DISCLOSURES
  }
  // Never cache fully-degraded reports (missing keys/history/API failures) — the
  // user typically fixes the cause immediately and must not see it stale for 6h.
  if (active.length > 0) cache.set(sym, { at: Date.now(), report })
  return report
}

export function invalidateSignalsCache(symbol?: string): void {
  if (symbol) cache.delete(symbol.toUpperCase())
  else cache.clear()
}
