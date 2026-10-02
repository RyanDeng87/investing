import { getSecret } from './keyvault'
import { logJob } from './db'
import {
  cancelPaperOrder,
  fetchPaperAccount,
  fetchPaperOrders,
  fetchPaperPositions,
  fetchPortfolioHistory,
  submitPaperOrder,
  type AlpacaKeys,
  type PlaceOrderInput,
  type RawPaperOrder
} from './alpaca'
import type { PaperOrder, PaperOrderInput, PaperSnapshot, PortfolioHistoryPoint } from '../shared/types'

// Phase 6: Alpaca PAPER trading (PLAN.md §3). The trading base URL is pinned
// to paper-api.alpaca.markets in alpaca.ts — no code path here can ever reach
// a live brokerage account. Same key pair the app already uses for data.

const SYMBOL_RE = /^[A-Z.]{1,6}$/

function alpacaKeys(): AlpacaKeys | null {
  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  return keyId && secret ? { keyId, secret } : null
}

function toOrder(o: RawPaperOrder): PaperOrder {
  return { ...o }
}

export async function getPaperSnapshot(): Promise<PaperSnapshot> {
  const keys = alpacaKeys()
  if (!keys) {
    return {
      available: false,
      message: 'Add your Alpaca keys in Settings — the same paper keys the app already uses for market data.',
      account: null,
      positions: [],
      openOrders: [],
      recentOrders: []
    }
  }
  try {
    const [account, rawPositions, openOrders, closedOrders] = await Promise.all([
      fetchPaperAccount(keys),
      fetchPaperPositions(keys),
      fetchPaperOrders(keys, 'open', 50),
      fetchPaperOrders(keys, 'closed', 10)
    ])
    const equity = account.equity
    const positions = rawPositions
      .map((p) => ({
        ...p,
        weight: equity != null && equity > 0 && p.marketValue != null ? p.marketValue / equity : null
      }))
      .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
    return {
      available: true,
      account,
      positions,
      openOrders: openOrders.map(toOrder),
      recentOrders: closedOrders.map(toOrder)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logJob('paper_snapshot', 'error', msg)
    return { available: false, message: msg, account: null, positions: [], openOrders: [], recentOrders: [] }
  }
}

// Validation lives in the MAIN process: the renderer's payload is untrusted.
export async function placePaperOrder(raw: PaperOrderInput): Promise<PaperOrder> {
  const keys = alpacaKeys()
  if (!keys) throw new Error('Alpaca keys are not configured.')
  const symbol = String(raw?.symbol ?? '').trim().toUpperCase()
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol "${symbol}".`)
  const side = raw?.side === 'sell' ? 'sell' : raw?.side === 'buy' ? 'buy' : null
  if (!side) throw new Error('Order side must be buy or sell.')
  const type = raw?.type === 'limit' ? 'limit' : raw?.type === 'market' ? 'market' : null
  if (!type) throw new Error('Order type must be market or limit.')
  const tif = raw?.tif === 'gtc' ? 'gtc' : 'day'
  const qty = raw?.qty != null ? Number(raw.qty) : undefined
  const notional = raw?.notional != null ? Number(raw.notional) : undefined
  const hasQty = qty != null && Number.isFinite(qty) && qty > 0
  const hasNotional = notional != null && Number.isFinite(notional) && notional > 0
  if (hasQty === hasNotional) throw new Error('Specify exactly one of shares or dollar amount.')
  if (hasNotional && type !== 'market') throw new Error('Dollar-amount (notional) orders must be market orders (Alpaca rule).')
  if (hasNotional && tif !== 'day') throw new Error('Dollar-amount (notional) orders must be day orders (Alpaca rule).')
  let limitPrice: number | undefined
  if (type === 'limit') {
    limitPrice = Number(raw?.limitPrice)
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw new Error('Limit orders need a positive limit price.')
  }
  const input: PlaceOrderInput = {
    symbol,
    side,
    type,
    tif,
    ...(hasQty ? { qty } : { notional }),
    ...(limitPrice != null ? { limitPrice } : {})
  }
  const placed = await submitPaperOrder(keys, input)
  logJob('paper_order', 'ok', `${side} ${hasQty ? `${qty} sh` : `$${notional}`} ${symbol} ${type}${limitPrice ? ` @${limitPrice}` : ''} → ${placed.status}`)
  return toOrder(placed)
}

export async function cancelOrder(orderId: string): Promise<void> {
  const keys = alpacaKeys()
  if (!keys) throw new Error('Alpaca keys are not configured.')
  const id = String(orderId ?? '').trim()
  if (!id) throw new Error('Missing order id.')
  await cancelPaperOrder(keys, id)
  logJob('paper_order', 'ok', `cancelled ${id.slice(0, 8)}…`)
}

export async function getPaperHistory(period: '1M' | '3M' | '1A'): Promise<PortfolioHistoryPoint[]> {
  const keys = alpacaKeys()
  if (!keys) return []
  const h = await fetchPortfolioHistory(keys, period)
  const out: PortfolioHistoryPoint[] = []
  for (let i = 0; i < h.timestamps.length; i++) {
    const eq = h.equity[i]
    if (eq == null || !Number.isFinite(eq) || eq <= 0) continue
    out.push({ date: new Date(h.timestamps[i] * 1000).toISOString().slice(0, 10), equity: eq })
  }
  return out
}
