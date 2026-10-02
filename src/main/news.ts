import { getSecret } from './keyvault'
import { finnhubBudget } from './budgeter'
import type { NewsItem } from '../shared/types'

// Company news via Finnhub free tier (60 req/min — separate from the scarce FMP
// budget). In-memory cached 10 minutes per symbol.

const cacheMap = new Map<string, { at: number; items: NewsItem[] }>()

export async function getNews(symbol: string): Promise<NewsItem[]> {
  const sym = symbol.toUpperCase()
  const cached = cacheMap.get(sym)
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.items

  const token = getSecret('finnhub_key')
  if (!token) return []

  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  try {
    await finnhubBudget.take()
    const url = `https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${from}&to=${to}`
    const res = await fetch(url, { headers: { 'X-Finnhub-Token': token } })
    if (!res.ok) return cached?.items ?? []
    const j = (await res.json()) as {
      headline?: string
      source?: string
      datetime?: number
      url?: string
      summary?: string
    }[]
    if (!Array.isArray(j)) return cached?.items ?? []
    const items: NewsItem[] = j
      .filter((n) => n.headline && n.url)
      .slice(0, 30)
      .map((n) => ({
        headline: n.headline as string,
        source: n.source ?? '',
        datetime: n.datetime ?? 0,
        url: n.url as string,
        summary: n.summary ?? ''
      }))
    cacheMap.set(sym, { at: Date.now(), items })
    return items
  } catch {
    // Offline/DNS hiccups degrade to cache or empty — never reject the IPC call.
    return cached?.items ?? []
  }
}
