import { getDb, logJob } from './db'
import { getSecret } from './keyvault'
import { fetchChain, fetchOpenInterest, fetchSpot, type AlpacaKeys, type OptionContractSnap } from './alpaca'
import { checkIvAlerts, checkPriceAlerts } from './alerts'
import type { CollectorResult, ExpirationSummary } from '../shared/types'

// Daily IV snapshot collector. Alpaca's free tier has no historical-IV endpoint,
// so IV Rank / term-structure / skew history only exists if we record it ourselves.
// A missed day cannot be backfilled.

function nyDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
}

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

export function summarizeExpirations(
  chain: OptionContractSnap[],
  spot: number,
  today: string
): ExpirationSummary[] {
  const byExpiry = new Map<string, OptionContractSnap[]>()
  for (const c of chain) {
    const list = byExpiry.get(c.expiry) ?? []
    list.push(c)
    byExpiry.set(c.expiry, list)
  }

  const out: ExpirationSummary[] = []
  for (const [expiry, contracts] of [...byExpiry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dte = Math.round((Date.parse(expiry) - Date.parse(today)) / 86_400_000)
    const calls = contracts.filter((c) => c.type === 'C')
    const puts = contracts.filter((c) => c.type === 'P')

    const atmCall = nearestBy(calls.filter((c) => c.iv != null), (c) => Math.abs(c.strike - spot))
    const atmPut = nearestBy(puts.filter((c) => c.iv != null), (c) => Math.abs(c.strike - spot))
    const atmIvs = [atmCall?.iv, atmPut?.iv].filter((v): v is number => v != null)

    // Tolerance-bounded: on sparse chains the nearest contract can be nowhere
    // near 25Δ — emitting it would mislabel garbage as the risk-reversal.
    let call25 = nearestBy(
      calls.filter((c) => c.delta != null && c.iv != null),
      (c) => Math.abs((c.delta as number) - 0.25)
    )
    if (call25 && Math.abs((call25.delta as number) - 0.25) > 0.1) call25 = null
    let put25 = nearestBy(
      puts.filter((c) => c.delta != null && c.iv != null),
      (c) => Math.abs((c.delta as number) + 0.25)
    )
    if (put25 && Math.abs((put25.delta as number) + 0.25) > 0.1) put25 = null

    // Naive GEX (SqueezeMetrics convention): gamma * OI * 100, calls positive, puts negative.
    // Dealer positioning is an assumption, not an observation — this is pedagogical data.
    let callOi = 0
    let putOi = 0
    let gex = 0
    let haveOi = false
    for (const c of contracts) {
      if (c.oi == null) continue
      haveOi = true
      if (c.type === 'C') {
        callOi += c.oi
        if (c.gamma != null) gex += c.gamma * c.oi * 100
      } else {
        putOi += c.oi
        if (c.gamma != null) gex -= c.gamma * c.oi * 100
      }
    }

    out.push({
      expiry,
      dte,
      atmIv: atmIvs.length ? atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length : null,
      call25dIv: call25?.iv ?? null,
      put25dIv: put25?.iv ?? null,
      callOi: haveOi ? callOi : null,
      putOi: haveOi ? putOi : null,
      gexNaive: haveOi ? gex : null
    })
  }
  return out
}

export async function runCollector(): Promise<CollectorResult[]> {
  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  if (!keyId || !secret) {
    logJob('iv_collect', 'skipped', 'Alpaca keys not configured')
    return [{ symbol: '*', status: 'skipped', message: 'Alpaca keys not configured — set them in Settings' }]
  }
  const keys: AlpacaKeys = { keyId, secret }
  const db = getDb()
  const today = nyDate()
  const symbols = (db.prepare('SELECT symbol FROM watchlist ORDER BY symbol').all() as { symbol: string }[]).map(
    (r) => r.symbol
  )

  const upsert = db.prepare(`
    INSERT INTO iv_snapshots(symbol, snapshot_date, spot, atm_iv_30d, expirations)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(symbol, snapshot_date) DO UPDATE SET
      spot = excluded.spot, atm_iv_30d = excluded.atm_iv_30d, expirations = excluded.expirations
  `)

  const results: CollectorResult[] = []
  for (const symbol of symbols) {
    try {
      const spot = await fetchSpot(symbol, keys)
      if (spot == null) {
        results.push({ symbol, status: 'error', message: 'no spot price available' })
        continue
      }
      const chain = await fetchChain(symbol, keys, nyDate(5), nyDate(65))
      if (chain.length === 0) {
        results.push({ symbol, status: 'error', message: 'empty option chain (no listed options?)' })
        continue
      }
      // Open interest from the trading API's contracts endpoint (snapshots lack
      // it) so daily snapshots record OI/GEX history too. Best-effort.
      try {
        const oiMap = await fetchOpenInterest(symbol, keys, nyDate(5), nyDate(65))
        for (const c of chain) {
          const oi = oiMap.get(c.osi)
          if (oi != null) c.oi = oi
        }
      } catch {
        /* OI unavailable today — snapshot keeps null OI/GEX */
      }
      const summaries = summarizeExpirations(chain, spot, today)
      const near30 = nearestBy(summaries.filter((s) => s.atmIv != null), (s) => Math.abs(s.dte - 30))
      const atmIv30d = near30?.atmIv ?? null
      upsert.run(symbol, today, spot, atmIv30d, JSON.stringify(summaries))
      results.push({ symbol, status: 'ok', atmIv30d })
    } catch (e) {
      results.push({ symbol, status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const errors = results.filter((r) => r.status === 'error').length
  logJob('iv_collect', errors === 0 ? 'ok' : 'partial', `${results.length - errors}/${results.length} symbols ok (${today})`)
  // Alert checks belong to EVERY collector invocation (headless task AND the
  // in-app "Run collector now" button) — fresh snapshots may cross IV-rank
  // thresholds, and price rules get their daily closed-app check here.
  try {
    checkIvAlerts()
    await checkPriceAlerts()
  } catch (e) {
    logJob('alert', 'error', e instanceof Error ? e.message : String(e))
  }
  return results
}
