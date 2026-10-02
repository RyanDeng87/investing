import { alpacaBudget } from './budgeter'

const DATA_BASE = 'https://data.alpaca.markets'
const TRADING_BASE = 'https://paper-api.alpaca.markets'

export interface AlpacaKeys {
  keyId: string
  secret: string
}

export interface OptionContractSnap {
  osi: string
  expiry: string
  strike: number
  type: 'C' | 'P'
  iv: number | null
  delta: number | null
  gamma: number | null
  oi: number | null
  bid: number | null
  ask: number | null
}

async function getJson(url: string, keys: AlpacaKeys): Promise<unknown> {
  await alpacaBudget.take()
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': keys.keyId,
      'APCA-API-SECRET-KEY': keys.secret
    }
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`Alpaca ${res.status}: ${body}`)
  }
  return res.json()
}

// POST/DELETE against the PAPER trading API. The base URL is pinned to
// paper-api.alpaca.markets — this app never routes an order to a live account.
async function sendJson(url: string, keys: AlpacaKeys, method: 'POST' | 'DELETE', body?: unknown): Promise<unknown> {
  await alpacaBudget.take()
  const res = await fetch(url, {
    method,
    headers: {
      'APCA-API-KEY-ID': keys.keyId,
      'APCA-API-SECRET-KEY': keys.secret,
      ...(body != null ? { 'Content-Type': 'application/json' } : {})
    },
    body: body != null ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    // Alpaca returns {"code":...,"message":"..."} — surface the message.
    let msg = text
    try {
      const j = JSON.parse(text) as { message?: string }
      if (j?.message) msg = j.message
    } catch {
      /* not json */
    }
    throw new Error(`Alpaca ${res.status}: ${msg}`)
  }
  if (res.status === 204) return null
  return res.json()
}

export interface AlpacaDailyBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// Daily bars from the IEX feed, paginated. `start` is YYYY-MM-DD.
// adjustment 'split' (charts: prices match what you'd have seen on screen) or
// 'all' (splits + dividends: TOTAL-RETURN series, what backtests must use).
export async function fetchDailyBars(
  symbol: string,
  keys: AlpacaKeys,
  start: string,
  adjustment: 'split' | 'all' = 'split'
): Promise<AlpacaDailyBar[]> {
  const out: AlpacaDailyBar[] = []
  let pageToken: string | null = null
  do {
    const url = new URL(`${DATA_BASE}/v2/stocks/${symbol}/bars`)
    url.searchParams.set('timeframe', '1Day')
    url.searchParams.set('start', start)
    url.searchParams.set('limit', '10000')
    url.searchParams.set('adjustment', adjustment)
    url.searchParams.set('feed', 'iex')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const j = (await getJson(url.toString(), keys)) as {
      bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[]
      next_page_token?: string | null
    }
    for (const b of j?.bars ?? []) {
      out.push({ date: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })
    }
    pageToken = j?.next_page_token ?? null
  } while (pageToken)
  return out
}

export interface AlpacaMinuteBar {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// Intraday bars (IEX feed) for the 1D/1W chart views.
export async function fetchMinuteBars(
  symbol: string,
  keys: AlpacaKeys,
  startIso: string,
  timeframe: '1Min' | '15Min' = '1Min'
): Promise<AlpacaMinuteBar[]> {
  const out: AlpacaMinuteBar[] = []
  let pageToken: string | null = null
  do {
    const url = new URL(`${DATA_BASE}/v2/stocks/${symbol}/bars`)
    url.searchParams.set('timeframe', timeframe)
    url.searchParams.set('start', startIso)
    url.searchParams.set('limit', '10000')
    url.searchParams.set('adjustment', 'split')
    url.searchParams.set('feed', 'iex')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const j = (await getJson(url.toString(), keys)) as {
      bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[]
      next_page_token?: string | null
    }
    for (const b of j?.bars ?? []) {
      out.push({
        time: Math.floor(Date.parse(b.t) / 1000),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v
      })
    }
    pageToken = j?.next_page_token ?? null
  } while (pageToken)
  return out
}

// Open interest lives on the TRADING API's contracts endpoint — the data API's
// option snapshots never populate it on the free indicative feed. Same key
// pair (paper account). OI is exchange-reported once daily, as of the prior
// session. Returns OSI symbol → open interest.
export async function fetchOpenInterest(
  underlying: string,
  keys: AlpacaKeys,
  expirationGte: string,
  expirationLte: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let pageToken: string | null = null
  do {
    const url = new URL(`${TRADING_BASE}/v2/options/contracts`)
    url.searchParams.set('underlying_symbols', underlying)
    url.searchParams.set('expiration_date_gte', expirationGte)
    url.searchParams.set('expiration_date_lte', expirationLte)
    url.searchParams.set('status', 'active')
    url.searchParams.set('limit', '10000')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const j = (await getJson(url.toString(), keys)) as {
      option_contracts?: { symbol?: string; open_interest?: string | number | null }[]
      next_page_token?: string | null
    }
    for (const c of j?.option_contracts ?? []) {
      if (!c.symbol || c.open_interest == null) continue
      const oi = Number(c.open_interest)
      if (Number.isFinite(oi)) out.set(c.symbol, oi)
    }
    pageToken = j?.next_page_token ?? null
  } while (pageToken)
  return out
}

export interface StockQuote {
  symbol: string
  price: number | null
  prevClose: number | null
}

// One batched call for the whole watchlist (multi-symbol snapshot endpoint).
export async function fetchQuotes(symbols: string[], keys: AlpacaKeys): Promise<StockQuote[]> {
  if (symbols.length === 0) return []
  const url = new URL(`${DATA_BASE}/v2/stocks/snapshots`)
  url.searchParams.set('symbols', symbols.join(','))
  url.searchParams.set('feed', 'iex')
  type Snap = { latestTrade?: { p?: number }; dailyBar?: { c?: number }; prevDailyBar?: { c?: number } }
  const j = (await getJson(url.toString(), keys)) as Record<string, Snap>
  return symbols.map((symbol) => {
    const s = j[symbol]
    return {
      symbol,
      price: s?.latestTrade?.p ?? s?.dailyBar?.c ?? null,
      prevClose: s?.prevDailyBar?.c ?? null
    }
  })
}

export async function fetchSpot(symbol: string, keys: AlpacaKeys): Promise<number | null> {
  const j = (await getJson(`${DATA_BASE}/v2/stocks/${symbol}/snapshot?feed=iex`, keys)) as {
    latestTrade?: { p?: number }
    latestQuote?: { ap?: number; bp?: number }
  }
  if (j?.latestTrade?.p) return j.latestTrade.p
  const q = j?.latestQuote
  if (q?.ap && q?.bp) return (q.ap + q.bp) / 2
  return null
}

// --- Paper trading (Phase 6). All endpoints on TRADING_BASE = paper-api. ---
// Alpaca returns most numerics as strings; num() normalizes.

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface RawPaperAccount {
  equity: number | null
  lastEquity: number | null
  cash: number | null
  buyingPower: number | null
  longMarketValue: number | null
  status: string
}

export async function fetchPaperAccount(keys: AlpacaKeys): Promise<RawPaperAccount> {
  const j = (await getJson(`${TRADING_BASE}/v2/account`, keys)) as Record<string, unknown>
  return {
    equity: num(j.equity),
    lastEquity: num(j.last_equity),
    cash: num(j.cash),
    buyingPower: num(j.buying_power),
    longMarketValue: num(j.long_market_value),
    status: String(j.status ?? 'unknown')
  }
}

export interface RawPaperPosition {
  symbol: string
  qty: number
  avgEntry: number | null
  currentPrice: number | null
  marketValue: number | null
  unrealizedPl: number | null
  unrealizedPlPct: number | null
  todayPlPct: number | null
}

export async function fetchPaperPositions(keys: AlpacaKeys): Promise<RawPaperPosition[]> {
  const j = (await getJson(`${TRADING_BASE}/v2/positions`, keys)) as Record<string, unknown>[]
  return (j ?? []).map((p) => ({
    symbol: String(p.symbol ?? ''),
    qty: num(p.qty) ?? 0,
    avgEntry: num(p.avg_entry_price),
    currentPrice: num(p.current_price),
    marketValue: num(p.market_value),
    unrealizedPl: num(p.unrealized_pl),
    unrealizedPlPct: num(p.unrealized_plpc),
    todayPlPct: num(p.unrealized_intraday_plpc)
  }))
}

export interface RawPaperOrder {
  id: string
  symbol: string
  side: string
  type: string
  qty: number | null
  notional: number | null
  limitPrice: number | null
  status: string
  filledQty: number | null
  filledAvgPrice: number | null
  submittedAt: string
  tif: string
}

function mapOrder(o: Record<string, unknown>): RawPaperOrder {
  return {
    id: String(o.id ?? ''),
    symbol: String(o.symbol ?? ''),
    side: String(o.side ?? ''),
    type: String(o.type ?? ''),
    qty: num(o.qty),
    notional: num(o.notional),
    limitPrice: num(o.limit_price),
    status: String(o.status ?? ''),
    filledQty: num(o.filled_qty),
    filledAvgPrice: num(o.filled_avg_price),
    submittedAt: String(o.submitted_at ?? ''),
    tif: String(o.time_in_force ?? '')
  }
}

export async function fetchPaperOrders(keys: AlpacaKeys, status: 'open' | 'closed' | 'all', limit = 50): Promise<RawPaperOrder[]> {
  const url = new URL(`${TRADING_BASE}/v2/orders`)
  url.searchParams.set('status', status)
  url.searchParams.set('limit', String(Math.min(500, Math.max(1, limit))))
  url.searchParams.set('direction', 'desc')
  const j = (await getJson(url.toString(), keys)) as Record<string, unknown>[]
  return (j ?? []).map(mapOrder)
}

export interface PlaceOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  qty?: number
  notional?: number
  limitPrice?: number
  tif: 'day' | 'gtc'
}

export async function submitPaperOrder(keys: AlpacaKeys, input: PlaceOrderInput): Promise<RawPaperOrder> {
  const body: Record<string, unknown> = {
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    time_in_force: input.tif
  }
  if (input.qty != null) body.qty = String(input.qty)
  else body.notional = String(input.notional)
  if (input.type === 'limit') body.limit_price = String(input.limitPrice)
  const j = (await sendJson(`${TRADING_BASE}/v2/orders`, keys, 'POST', body)) as Record<string, unknown>
  return mapOrder(j)
}

export async function cancelPaperOrder(keys: AlpacaKeys, orderId: string): Promise<void> {
  await sendJson(`${TRADING_BASE}/v2/orders/${encodeURIComponent(orderId)}`, keys, 'DELETE')
}

export interface RawPortfolioHistory {
  timestamps: number[] // unix seconds
  equity: (number | null)[]
}

export async function fetchPortfolioHistory(keys: AlpacaKeys, period: '1M' | '3M' | '1A'): Promise<RawPortfolioHistory> {
  const url = new URL(`${TRADING_BASE}/v2/account/portfolio/history`)
  url.searchParams.set('period', period)
  url.searchParams.set('timeframe', '1D')
  const j = (await getJson(url.toString(), keys)) as { timestamp?: number[]; equity?: (number | null)[] }
  return { timestamps: j?.timestamp ?? [], equity: j?.equity ?? [] }
}

// OSI symbology: ROOT + YYMMDD + C/P + strike*1000 zero-padded to 8 digits.
const OSI_RE = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/

export async function fetchChain(
  underlying: string,
  keys: AlpacaKeys,
  expirationGte: string,
  expirationLte: string
): Promise<OptionContractSnap[]> {
  const out: OptionContractSnap[] = []
  let pageToken: string | null = null
  do {
    const url = new URL(`${DATA_BASE}/v1beta1/options/snapshots/${underlying}`)
    url.searchParams.set('feed', 'indicative')
    url.searchParams.set('limit', '1000')
    url.searchParams.set('expiration_date_gte', expirationGte)
    url.searchParams.set('expiration_date_lte', expirationLte)
    if (pageToken) url.searchParams.set('page_token', pageToken)

    const j = (await getJson(url.toString(), keys)) as {
      snapshots?: Record<string, {
        impliedVolatility?: number
        openInterest?: number
        greeks?: { delta?: number; gamma?: number }
        latestQuote?: { bp?: number; ap?: number }
      }>
      next_page_token?: string | null
    }
    for (const [osi, s] of Object.entries(j?.snapshots ?? {})) {
      const m = OSI_RE.exec(osi)
      if (!m) continue
      out.push({
        osi,
        expiry: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`,
        strike: parseInt(m[4], 10) / 1000,
        type: m[3] as 'C' | 'P',
        iv: s?.impliedVolatility ?? null,
        delta: s?.greeks?.delta ?? null,
        gamma: s?.greeks?.gamma ?? null,
        oi: s?.openInterest ?? null,
        bid: s?.latestQuote?.bp ?? null,
        ask: s?.latestQuote?.ap ?? null
      })
    }
    pageToken = j?.next_page_token ?? null
  } while (pageToken)
  return out
}
