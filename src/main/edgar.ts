import { getDb, logJob } from './db'
import { fetchFinnhubMetrics } from './finnhub'

// SEC EDGAR XBRL fallback for symbols the FMP free tier gates (fmp:unavailable).
// Official, free, covers every US filer. Data is fiscal-year (10-K) rather than
// TTM, so ratios lag up to a year — the UI discloses this wherever EDGAR feeds a
// score. We store a COMPACT derived series (source 'edgar:derived'), never the
// multi-megabyte raw companyfacts payload.

// SEC fair-access policy: declared User-Agent with contact info, stay well under
// 10 requests/second.
const UA = 'PersonalInvestingApp/0.1 (ryan.deng.2016@gmail.com)'
const REQUEST_GAP_MS = 200

export interface EdgarAnnual {
  end: string
  revenue: number | null
  netIncome: number | null
  epsDiluted: number | null
  grossProfit: number | null
  equity: number | null
  operatingCashFlow: number | null
  capex: number | null
}

export interface EdgarDerived {
  cik: number
  fetchedAt: string
  sharesOutstanding: number | null
  annual: EdgarAnnual[]
}

const TAGS: Record<Exclude<keyof EdgarAnnual, 'end'>, { tags: string[]; unit: string; duration: boolean }> = {
  revenue: {
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'RevenueFromContractWithCustomerIncludingAssessedTax'
    ],
    unit: 'USD',
    duration: true
  },
  netIncome: { tags: ['NetIncomeLoss'], unit: 'USD', duration: true },
  epsDiluted: { tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], unit: 'USD/shares', duration: true },
  grossProfit: { tags: ['GrossProfit'], unit: 'USD', duration: true },
  equity: {
    tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    unit: 'USD',
    duration: false
  },
  operatingCashFlow: {
    tags: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    unit: 'USD',
    duration: true
  },
  capex: { tags: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'], unit: 'USD', duration: true }
}

interface FactEntry {
  start?: string
  end?: string
  val?: number
  form?: string
  fp?: string
  filed?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function secGet(url: string): Promise<unknown> {
  await sleep(REQUEST_GAP_MS)
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } })
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`)
  return res.json()
}

// Ticker → CIK map, cached in settings for 7 days.
async function cikFor(symbol: string): Promise<number | null> {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('edgar_cik_map') as { value: string } | undefined
  let map: Record<string, number> | null = null
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { at: number; map: Record<string, number> }
      if (Date.now() - parsed.at < 7 * 86_400_000) map = parsed.map
    } catch {
      /* refetch below */
    }
  }
  if (!map) {
    const j = (await secGet('https://www.sec.gov/files/company_tickers.json')) as Record<
      string,
      { cik_str: number; ticker: string }
    >
    map = {}
    for (const entry of Object.values(j)) map[entry.ticker.toUpperCase()] = entry.cik_str
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'edgar_cik_map',
      JSON.stringify({ at: Date.now(), map })
    )
  }
  return map[symbol.toUpperCase()] ?? null
}

// Annual (10-K FY) series for one concept: dedupe by period end, keep latest filing.
function annualSeries(
  facts: Record<string, { units?: Record<string, FactEntry[]> }>,
  spec: { tags: string[]; unit: string; duration: boolean }
): Map<string, number> {
  for (const tag of spec.tags) {
    const entries = facts[tag]?.units?.[spec.unit]
    if (!entries || entries.length === 0) continue
    const byEnd = new Map<string, { val: number; filed: string }>()
    for (const e of entries) {
      if (e.form !== '10-K' || e.fp !== 'FY' || e.end == null || typeof e.val !== 'number') continue
      if (spec.duration) {
        if (!e.start) continue
        const days = (Date.parse(e.end) - Date.parse(e.start)) / 86_400_000
        if (days < 300 || days > 400) continue // exclude quarterly comparatives in 10-Ks
      }
      const prev = byEnd.get(e.end)
      const filed = e.filed ?? ''
      if (!prev || filed > prev.filed) byEnd.set(e.end, { val: e.val, filed })
    }
    if (byEnd.size > 0) {
      const out = new Map<string, number>()
      for (const [end, { val }] of byEnd) out.set(end, val)
      return out
    }
  }
  return new Map()
}

export async function fetchEdgarDerived(symbol: string): Promise<EdgarDerived | null> {
  const cik = await cikFor(symbol)
  if (cik == null) return null
  const padded = String(cik).padStart(10, '0')
  const j = (await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`)) as {
    facts?: {
      'us-gaap'?: Record<string, { units?: Record<string, FactEntry[]> }>
      dei?: Record<string, { units?: Record<string, FactEntry[]> }>
    }
  }
  const gaap = j?.facts?.['us-gaap']
  if (!gaap) return null

  const series: Record<string, Map<string, number>> = {}
  for (const [key, spec] of Object.entries(TAGS)) series[key] = annualSeries(gaap, spec)

  // Union of period-ends across concepts, most recent 6 fiscal years.
  const ends = [...new Set(Object.values(series).flatMap((m) => [...m.keys()]))].sort().slice(-6)
  if (ends.length === 0) return null
  const annual: EdgarAnnual[] = ends.map((end) => ({
    end,
    revenue: series.revenue.get(end) ?? null,
    netIncome: series.netIncome.get(end) ?? null,
    epsDiluted: series.epsDiluted.get(end) ?? null,
    grossProfit: series.grossProfit.get(end) ?? null,
    equity: series.equity.get(end) ?? null,
    operatingCashFlow: series.operatingCashFlow.get(end) ?? null,
    capex: series.capex.get(end) ?? null
  }))

  // Latest share count from dei (any recent form, latest period end wins).
  let sharesOutstanding: number | null = null
  const shareEntries = j?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares
  if (Array.isArray(shareEntries)) {
    let best: FactEntry | null = null
    for (const e of shareEntries) {
      if (typeof e.val !== 'number' || !e.end) continue
      if (!best || e.end > (best.end as string)) best = e
    }
    sharesOutstanding = best?.val ?? null
  }

  return { cik, fetchedAt: new Date().toISOString(), sharesOutstanding, annual }
}

// Backfill: symbols in watchlist ∪ universe with no usable FMP fundamentals and
// no fresh EDGAR snapshot. Runs after the FMP crawl (headless daily + manual).
export async function backfillEdgar(maxSymbols = 15): Promise<{ symbols: string[]; failed: string[] }> {
  const db = getDb()
  const targets = (
    db
      .prepare(
        `
        SELECT u.symbol FROM (SELECT symbol FROM watchlist UNION SELECT symbol FROM universe) u
        WHERE NOT EXISTS (
          SELECT 1 FROM fundamentals_snapshots f
          WHERE f.symbol = u.symbol
            AND f.source IN ('fmp:ratios-ttm', 'fmp:key-metrics-ttm', 'fmp:income-annual')
        )
        AND EXISTS (SELECT 1 FROM fundamentals_snapshots f2 WHERE f2.symbol = u.symbol)
        AND NOT EXISTS (
          SELECT 1 FROM fundamentals_snapshots f3
          WHERE f3.symbol = u.symbol AND f3.source = 'edgar:derived'
            AND f3.fetched_at > datetime('now', '-30 days')
        )
        ORDER BY EXISTS(SELECT 1 FROM watchlist w WHERE w.symbol = u.symbol) DESC, u.symbol
        `
      )
      .all() as { symbol: string }[]
  )
    .map((r) => r.symbol)
    .slice(0, maxSymbols)

  const insert = db.prepare('INSERT INTO fundamentals_snapshots(symbol, source, payload) VALUES (?, ?, ?)')
  const done: string[] = []
  const failed: string[] = []
  for (const symbol of targets) {
    let got = false
    try {
      const derived = await fetchEdgarDerived(symbol)
      if (derived && derived.annual.length > 0) {
        insert.run(symbol, 'edgar:derived', JSON.stringify(derived))
        got = true
      }
    } catch (e) {
      logJob('edgar_backfill', 'error', `${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // Finnhub basic financials complement EDGAR with TTM ratios (free, not gated).
    try {
      const metrics = await fetchFinnhubMetrics(symbol)
      if (metrics) {
        insert.run(symbol, 'finnhub:metrics', JSON.stringify(metrics))
        got = true
      }
    } catch (e) {
      logJob('edgar_backfill', 'error', `${symbol} (finnhub): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (got) done.push(symbol)
    else failed.push(symbol)
  }
  if (targets.length > 0) {
    logJob(
      'edgar_backfill',
      failed.length === 0 ? 'ok' : 'partial',
      `${done.length}/${targets.length} symbols via EDGAR+Finnhub (${done.join(', ') || 'none'})`
    )
  }
  return { symbols: done, failed }
}
