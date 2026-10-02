import { createServer } from 'http'
import { getDb, logJob } from './db'
import { getSignals } from './signals'
import { scoreSymbol, qarpLeaderboard } from './scoring'
import { getOptionsAnalytics } from './options'
import { getNextEarnings } from './earnings'
import { getDiscovery } from './discovery'
import { runBacktest } from './backtest'
import { getSelfTest } from './selftest'
import { getPaperSnapshot } from './paper'
import { getMacro } from './fred'
import { listJournal, logHypothesis } from './journal'
import { getTrackRecord } from './predictions'
import { getStance } from './stance'
import { getFearGreed } from './feargreed'
import { getReverseDcf } from './valuation'
import { getPortfolioReport } from './portfolio'
import type { BacktestConfig, StrategyKind } from '../shared/types'

// Phase 7: local MCP server (PLAN.md — "Claude Code can query the app's
// engines"). Streamable-HTTP transport (stateless JSON responses) served by
// the RUNNING app on 127.0.0.1 — Electron's main process has no working
// process.stdin on Windows, and an HTTP server inside the live instance is
// better anyway: shared caches, no second process on the SQLite WAL.
// Register once from a terminal (app must be running when Claude Code uses it):
//   claude mcp add --transport http investing http://127.0.0.1:48620/mcp

// Overridable for test instances (the port is otherwise owned by whichever
// app instance started first). Invalid overrides fall back — a bad env var
// must not throw inside listen() and abort app startup.
const rawPort = Number(process.env.INVESTING_MCP_PORT)
export const MCP_PORT = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 48620
const PROTOCOL_VERSION = '2024-11-05'

interface RpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

type RpcResponse = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } }

function ok(id: number | string | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function err(id: number | string | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

const sym = (args: Record<string, unknown> | undefined): string => String(args?.symbol ?? '').trim().toUpperCase()

const SYMBOL_SCHEMA = {
  type: 'object',
  properties: { symbol: { type: 'string', description: 'Ticker, e.g. NVDA' } },
  required: ['symbol']
}
const EMPTY_SCHEMA = { type: 'object', properties: {} }

// Each tool returns a JSON-serializable value; oversized fields are trimmed
// so a tool result stays a readable few KB.
const TOOLS: { name: string; description: string; inputSchema: unknown; run: (args?: Record<string, unknown>) => Promise<unknown> }[] = [
  {
    name: 'get_signals',
    description:
      "Short-term signal report for a symbol: momentum/PEAD/revision tilt (-100..+100, probabilistic, weak-evidence by design), moving-average regime, and the app's disclosures.",
    inputSchema: SYMBOL_SCHEMA,
    run: async (a) => getSignals(sym(a))
  },
  {
    name: 'get_buffett_score',
    description:
      'Buffett-style fundamental score for a symbol: quality/value/growth/safety percentiles within the tracked universe, QARP composite, Lynch checklist. Percentile-based — relative, not absolute.',
    inputSchema: SYMBOL_SCHEMA,
    run: async (a) => scoreSymbol(sym(a))
  },
  {
    name: 'get_options_analytics',
    description:
      'Options analytics for a symbol: IV30, IV Rank (needs ~1y of collected history), expected move, 25-delta skew, term structure, naive GEX, and the income-strategy screener with full rationale.',
    inputSchema: SYMBOL_SCHEMA,
    run: async (a) => getOptionsAnalytics(sym(a))
  },
  {
    name: 'get_next_earnings',
    description: 'Next scheduled earnings report for a symbol (date, before/after market, estimates), or null if none within the visible window.',
    inputSchema: SYMBOL_SCHEMA,
    run: async (a) => getNextEarnings(sym(a))
  },
  {
    name: 'get_discovery',
    description:
      'Broad-market dashboard: sector rotation vs SPY, 1-month movers, 12-1 momentum leaders, and tech/quantum/broad/gold-currency focus panels — computed from locally cached daily bars.',
    inputSchema: EMPTY_SCHEMA,
    run: async () => getDiscovery(false)
  },
  {
    name: 'run_backtest',
    description:
      'Run the honest backtester on total-return bars. Strategies: momentum-12-1, dual-momentum, fixed-allocation, ma-timing, buy-hold. Returns metrics (incl. deflated Sharpe — every run registers a trial), worst drawdowns, warnings; the daily points array is omitted. Registering trials means: do not sweep parameters idly.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['momentum-12-1', 'dual-momentum', 'fixed-allocation', 'ma-timing', 'buy-hold'] },
        topN: { type: 'number', description: 'momentum only (default 5)' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'custom universe / legs (see strategy docs)' },
        weights: { type: 'array', items: { type: 'number' }, description: 'fixed-allocation leg weights, parallel to symbols' },
        start: { type: 'string', description: 'YYYY[-MM[-DD]], default earliest' },
        end: { type: 'string', description: 'YYYY[-MM[-DD]], default latest' },
        benchmark: { type: 'string', description: 'default SPY' },
        rebalance: { type: 'string', enum: ['monthly', 'quarterly', 'yearly', 'none', 'bands'] }
      },
      required: ['strategy']
    },
    run: async (a) => {
      const config: BacktestConfig = {
        strategy: a?.strategy as StrategyKind,
        topN: Number(a?.topN ?? NaN),
        costBps: 5,
        start: String(a?.start ?? ''),
        end: String(a?.end ?? ''),
        symbols: Array.isArray(a?.symbols) ? (a.symbols as string[]) : [],
        weights: Array.isArray(a?.weights) ? (a.weights as number[]) : [],
        benchmark: String(a?.benchmark ?? 'SPY'),
        rebalance: (a?.rebalance as BacktestConfig['rebalance']) ?? (a?.strategy === 'fixed-allocation' ? 'quarterly' : 'monthly'),
        initialCapital: 10_000,
        contribMonthly: 0
      }
      const r = await runBacktest(config)
      return { ...r, points: `${r.points.length} daily points (omitted)` }
    }
  },
  {
    name: 'get_selftest',
    description:
      "The app's Self-Test: frozen backtest expectations per canonical strategy vs realized out-of-sample forward performance since each anchor date, plus what each strategy says to hold right now.",
    inputSchema: EMPTY_SCHEMA,
    run: async () => getSelfTest()
  },
  {
    name: 'get_paper_snapshot',
    description: 'Alpaca PAPER account snapshot: equity, cash, positions, open orders, recent fills. Read-only; this server exposes no order placement.',
    inputSchema: EMPTY_SCHEMA,
    run: async () => getPaperSnapshot()
  },
  {
    name: 'get_qarp_leaderboard',
    description: 'Top symbols by QARP (quality-at-a-reasonable-price) percentile among crawled fundamentals.',
    inputSchema: EMPTY_SCHEMA,
    run: async () => qarpLeaderboard()
  },
  {
    name: 'get_macro',
    description: 'FRED macro context: fed funds rate, 10y Treasury, CPI YoY, broad dollar index — latest vs a year ago. Needs a FRED key in app Settings.',
    inputSchema: EMPTY_SCHEMA,
    run: async () => getMacro()
  },
  {
    name: 'get_stance',
    description:
      "The app's rule-based buy/hold/sell stance for a symbol: action, timeframe, confidence, and per-input reasoning (QARP, signal tilt, MA regime, Fear & Greed). A synthesis of the other engines, not independent of them; stances on starred symbols are graded in the track record.",
    inputSchema: SYMBOL_SCHEMA,
    run: async (a) => getStance(sym(a))
  },
  {
    name: 'get_fear_greed',
    description:
      "CNN Fear & Greed Index (0 = extreme fear, 100 = extreme greed): composite score, rating, seven component readings, and recent daily history from the app's cache. Market-mood context; contrarian evidence is weak outside extremes.",
    inputSchema: EMPTY_SCHEMA,
    run: async () => getFearGreed()
  },
  {
    name: 'get_reverse_dcf',
    description:
      "Reverse DCF for a symbol: the 10-year FCF growth rate today's price implies (at 8/10/12% required returns, 2.5% terminal), next to the trailing revenue/EPS CAGR. Inverts price into an assumption — makes no forecast.",
    inputSchema: SYMBOL_SCHEMA,
    run: async (a) => getReverseDcf(sym(a))
  },
  {
    name: 'get_portfolio',
    description:
      "The user's manually entered REAL holdings: positions with live prices, weights, day/total P&L, concentration warnings, and each engine's read (QARP/tilt/stance) per position. Read-only.",
    inputSchema: EMPTY_SCHEMA,
    run: async () => getPortfolioReport()
  },
  {
    name: 'get_bars',
    description: 'Recent daily OHLCV bars for a symbol from the local cache (split-adjusted, most recent last).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        limit: { type: 'number', description: 'bars to return, default 30, max 250' }
      },
      required: ['symbol']
    },
    run: async (a) => {
      const limit = Math.min(250, Math.max(1, Math.round(Number(a?.limit) || 30)))
      return getDb()
        .prepare('SELECT date, open, high, low, close, volume FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?')
        .all(sym(a), limit)
        .reverse()
    }
  },
  {
    name: 'get_journal',
    description: "The user's trade journal entries (thesis written before, outcome after), including hypotheses and their resolutions.",
    inputSchema: EMPTY_SCHEMA,
    run: async () => listJournal()
  },
  {
    name: 'log_hypothesis',
    description:
      "Record a falsifiable market prediction into the user's journal, to be scored against realized prices when its horizon passes (misses are kept and reviewed). The hypothesis must be one wrong-able sentence plus its basis.",
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        hypothesis: { type: 'string', description: 'one falsifiable sentence + basis' },
        horizon_days: { type: 'number', description: 'calendar days until evaluation (5-365)' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['symbol', 'hypothesis', 'horizon_days', 'confidence']
    },
    run: async (a) =>
      logHypothesis({
        symbol: sym(a),
        hypothesis: String(a?.hypothesis ?? ''),
        horizonDays: Number(a?.horizon_days ?? 30),
        confidence: String(a?.confidence ?? 'low'),
        author: 'copilot'
      })
  },
  {
    name: 'get_track_record',
    description:
      "The app's prediction track record: daily-timestamped signal tilts, QARP percentiles, and IV ranks scored against what actually happened after their horizons. Includes the worst misses. Survivorship-free by construction.",
    inputSchema: EMPTY_SCHEMA,
    run: async () => getTrackRecord()
  }
]

// Returns null for notifications (no response body owed).
async function handle(req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null
  const isNotification = req.id === undefined
  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'investing-app', version: '0.1.0' },
        instructions:
          'Engines of a personal investing-analysis app. All outputs inherit its honest-labeling rules: signals are probabilistic tilts, backtests are survivor-biased descriptions of one past, scores are universe-relative percentiles. Nothing is financial advice.'
      })
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const name = String(req.params?.name ?? '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return err(id, -32602, `Unknown tool: ${name}`)
      try {
        const result = await tool.run((req.params?.arguments ?? {}) as Record<string, unknown>)
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] })
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
      }
    }
    default:
      if (isNotification || req.method.startsWith('notifications/')) return null
      return err(id, -32601, `Method not found: ${req.method}`)
  }
}

export function startMcpServer(): void {
  const server = createServer((req, res) => {
    // DNS-rebinding guard (MCP spec requires Origin validation): a hostile
    // web page can point its own hostname at 127.0.0.1 and POST here from a
    // browser — but it cannot forge the Host header to loopback.
    const host = String(req.headers.host ?? '')
    const origin = req.headers.origin
    const hostOk = host === `127.0.0.1:${MCP_PORT}` || host === `localhost:${MCP_PORT}`
    const originOk =
      origin == null || origin === `http://127.0.0.1:${MCP_PORT}` || origin === `http://localhost:${MCP_PORT}`
    if (!hostOk || !originOk) {
      res.writeHead(403).end()
      return
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'GET') {
      // No server-initiated stream; the spec allows 405 here.
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end() // stateless — nothing to tear down
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(err(null, -32700, 'Parse error')))
          return
        }
        const messages = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest]
        const responses: RpcResponse[] = []
        for (const m of messages) {
          const r = await handle(m).catch((e) => err(m?.id ?? null, -32603, e instanceof Error ? e.message : String(e)))
          if (r && m?.id !== undefined) responses.push(r)
        }
        if (responses.length === 0) {
          res.writeHead(202).end() // notifications only
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]))
      })()
    })
  })
  server.on('error', (e) => {
    // Port in use = a second app instance; the first one keeps serving.
    logJob('mcp', 'error', e instanceof Error ? e.message : String(e))
  })
  server.listen(MCP_PORT, '127.0.0.1', () => {
    logJob('mcp', 'ok', `MCP server on http://127.0.0.1:${MCP_PORT}/mcp`)
  })
}
