import { getSecret } from './keyvault'
import { finnhubBudget } from './budgeter'

// Finnhub basic financials (/stock/metric) — free tier, 60 req/min, and unlike
// FMP's free tier it is NOT symbol-gated. Supplies TTM ratios (ROE, margins,
// D/E, P/E) that the EDGAR annual series can't. NOTE: Finnhub expresses margins,
// ROE, growth, and dividend yield in PERCENT (e.g. 45.3), not ratios.

export async function fetchFinnhubMetrics(symbol: string): Promise<Record<string, unknown> | null> {
  const token = getSecret('finnhub_key')
  if (!token) return null
  await finnhubBudget.take()
  const res = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol.toUpperCase()}&metric=all`, {
    headers: { 'X-Finnhub-Token': token }
  })
  if (!res.ok) throw new Error(`Finnhub ${res.status}`)
  const j = (await res.json()) as { metric?: Record<string, unknown> }
  const m = j?.metric
  return m && typeof m === 'object' && Object.keys(m).length > 0 ? m : null
}
