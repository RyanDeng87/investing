import WebSocket from 'ws'
import { BrowserWindow } from 'electron'
import { getDb, logJob } from './db'
import { getSecret } from './keyvault'
import type { StreamStatus } from '../shared/types'

// Real-time streaming over Alpaca's free IEX websocket. A persistent push
// connection: it does NOT consume REST rate limits. Free-tier constraints:
// one concurrent connection, ~30 symbol subscriptions — so we stream the
// user's FAVORITES plus the actively viewed symbol, capped with headroom.

const STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex'
const MAX_SUBSCRIPTIONS = 28

let ws: WebSocket | null = null
let status: StreamStatus = { state: 'off', symbols: [] }
let activeSymbol: string | null = null
let currentSubs = new Set<string>()
let reconnectDelay = 5_000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopping = false
let authenticated = false
let authFailed = false

function favorites(): string[] {
  return (getDb().prepare('SELECT symbol FROM watchlist WHERE favorite = 1 ORDER BY symbol').all() as { symbol: string }[]).map(
    (r) => r.symbol
  )
}

function desiredSymbols(): string[] {
  const set = new Set<string>()
  if (activeSymbol) set.add(activeSymbol)
  for (const s of favorites()) {
    if (set.size >= MAX_SUBSCRIPTIONS) break
    set.add(s)
  }
  return [...set]
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function setStatus(next: StreamStatus): void {
  status = next
  broadcast('stream:status', status)
}

export function getStreamStatus(): StreamStatus {
  return status
}

let currentBarSub: string | null = null

// Trades stream for every desired symbol; minute-bars only for the actively
// viewed one — keeps total channel-symbol pairs ≤ 29 even if Alpaca's 30-sub
// cap counts pairs rather than symbols (docs are ambiguous; error 405 if over).
function resubscribe(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) return
  const want = new Set(desiredSymbols())
  const wantBar = activeSymbol
  const add = [...want].filter((s) => !currentSubs.has(s))
  const remove = [...currentSubs].filter((s) => !want.has(s))
  const unsub: Record<string, string[]> = {}
  const sub: Record<string, string[]> = {}
  if (remove.length) unsub.trades = remove
  if (add.length) sub.trades = add
  if (currentBarSub && currentBarSub !== wantBar) unsub.bars = [currentBarSub]
  if (wantBar && wantBar !== currentBarSub) sub.bars = [wantBar]
  if (Object.keys(unsub).length) ws.send(JSON.stringify({ action: 'unsubscribe', ...unsub }))
  if (Object.keys(sub).length) ws.send(JSON.stringify({ action: 'subscribe', ...sub }))
  currentSubs = want
  currentBarSub = wantBar
  setStatus({ state: 'live', symbols: [...want].sort() })
}

function scheduleReconnect(): void {
  if (stopping || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureStream()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 120_000)
}

export function ensureStream(): void {
  // Any explicit ensure call expresses intent to stream again.
  stopping = false
  if (authFailed) return // bad keys — wait for restartStream() after a key change
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    resubscribe()
    return
  }
  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  if (!keyId || !secret) {
    setStatus({ state: 'off', symbols: [], detail: 'Alpaca keys not configured' })
    return
  }

  setStatus({ state: 'connecting', symbols: [] })
  const socket = new WebSocket(STREAM_URL)
  ws = socket
  authenticated = false

  socket.on('open', () => {
    socket.send(JSON.stringify({ action: 'auth', key: keyId, secret }))
  })

  socket.on('message', (data) => {
    let msgs: unknown
    try {
      msgs = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!Array.isArray(msgs)) return
    for (const m of msgs as Record<string, unknown>[]) {
      switch (m.T) {
        case 'success':
          if (m.msg === 'authenticated') {
            authenticated = true
            authFailed = false
            reconnectDelay = 5_000
            currentSubs = new Set()
            currentBarSub = null
            resubscribe()
          }
          break
        case 't':
          broadcast('stream:trade', { symbol: m.S, price: m.p, size: m.s, time: m.t })
          break
        case 'b':
          broadcast('stream:bar', {
            symbol: m.S,
            open: m.o,
            high: m.h,
            low: m.l,
            close: m.c,
            volume: m.v,
            time: m.t
          })
          break
        case 'error': {
          const detail = `stream error ${m.code}: ${m.msg}`
          logJob('stream', 'error', detail)
          setStatus({ state: 'error', symbols: [], detail })
          // 406 = connection limit (another session holds the slot) — back off hard.
          if (m.code === 406) reconnectDelay = Math.max(reconnectDelay, 60_000)
          // 402 = auth failed — reconnecting with the same keys is pointless;
          // stay in error state until the keys change (restartStream).
          if (m.code === 402) authFailed = true
          break
        }
      }
    }
  })

  socket.on('close', () => {
    // A superseded socket's close must not clobber the live connection's state.
    if (ws !== socket) return
    ws = null
    authenticated = false
    currentSubs = new Set()
    currentBarSub = null
    if (stopping) {
      setStatus({ state: 'off', symbols: [] })
    } else if (authFailed) {
      // Preserve the auth-error status; do not reconnect with bad keys.
    } else {
      setStatus({ state: 'connecting', symbols: [], detail: 'reconnecting…' })
      scheduleReconnect()
    }
  })

  socket.on('error', (err) => {
    logJob('stream', 'error', err instanceof Error ? err.message : String(err))
    socket.close()
  })
}

export function setActiveSymbol(symbol: string | null): void {
  activeSymbol = symbol ? symbol.toUpperCase() : null
  if (ws && ws.readyState === WebSocket.OPEN) resubscribe()
  else ensureStream()
}

export function refreshStreamSubscriptions(): void {
  if (ws && ws.readyState === WebSocket.OPEN) resubscribe()
  else ensureStream()
}

// Called when API keys change: clears the fatal auth flag and reconnects fresh.
export function restartStream(): void {
  authFailed = false
  reconnectDelay = 5_000
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Reconnect with the new credentials.
    const old = ws
    ws = null
    old.close()
  }
  ensureStream()
}

export function stopStream(): void {
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close()
  ws = null
}
