import { getSecret } from './keyvault'
import { finnhubBudget } from './budgeter'
import type { EarningsEvent } from '../shared/types'

// Upcoming earnings via Finnhub's earnings calendar (free tier — sees roughly
// one month ahead). The date matters twice in this app: options premium sold
// across a report carries IV-crush/event risk, and the PEAD signal resets at
// the next report. In-memory cached 6h per symbol; degrades to cache/null on
// any failure — never rejects the IPC call.

const cacheMap = new Map<string, { at: number; ev: EarningsEvent | null }>()

export async function getNextEarnings(symbol: string): Promise<EarningsEvent | null> {
  const sym = symbol.toUpperCase()
  const cached = cacheMap.get(sym)
  if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.ev

  const token = getSecret('finnhub_key')
  if (!token) return null

  const from = new Date().toISOString().slice(0, 10)
  const to = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
  try {
    await finnhubBudget.take()
    const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${sym}`, {
      headers: { 'X-Finnhub-Token': token }
    })
    if (!res.ok) return cached?.ev ?? null
    const j = (await res.json()) as {
      earningsCalendar?: {
        date?: string
        hour?: string
        epsEstimate?: number | null
        revenueEstimate?: number | null
      }[]
    }
    const next = (j?.earningsCalendar ?? [])
      .filter((e) => e.date && e.date >= from)
      .sort((a, b) => (a.date as string).localeCompare(b.date as string))[0]
    const ev: EarningsEvent | null = next
      ? {
          symbol: sym,
          date: next.date as string,
          hour: next.hour === 'bmo' || next.hour === 'amc' || next.hour === 'dmh' ? next.hour : null,
          epsEstimate: next.epsEstimate ?? null,
          revenueEstimate: next.revenueEstimate ?? null,
          daysUntil: Math.max(0, Math.round((Date.parse(`${next.date}T12:00:00`) - Date.now()) / 86_400_000))
        }
      : null
    cacheMap.set(sym, { at: Date.now(), ev })
    return ev
  } catch {
    return cached?.ev ?? null
  }
}
