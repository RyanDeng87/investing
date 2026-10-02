import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BarRow, IntradayBar, IvSnapshotRow, JobLogRow, QuoteRow, StreamStatus, WatchItem } from '../../shared/types'
import PriceChart, { isIntradayRange, type ChartMode, type ChartRange, type PatternFocus } from './components/PriceChart'
import DiscoveryView from './components/DiscoveryView'
import BacktestView from './components/BacktestView'
import PaperView from './components/PaperView'
import PortfolioView from './components/PortfolioView'
import JournalView from './components/JournalView'
import CopilotPanel, { type CopilotThreads } from './components/CopilotPanel'
import Settings from './components/Settings'
import BuffettPanel from './components/BuffettPanel'
import DescriptionPanel from './components/DescriptionPanel'
import NewsPanel from './components/NewsPanel'
import SignalsPanel from './components/SignalsPanel'
import OptionsPanel from './components/OptionsPanel'
import { detectPatterns, type PatternHit } from './patterns'
import { T, fmtPct, fmtPrice, pctColor } from './theme'

const RANGES: ChartRange[] = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', 'MAX']
type Tab = 'buffett' | 'description' | 'signals' | 'options' | 'volatility' | 'news' | 'copilot'

// Stable empty array — a fresh [] literal per render would defeat PriceChart's
// referential checks and churn its effects.
const NO_PATTERNS: PatternHit[] = []

const TF_LABEL: Record<string, string> = { '1D': '1-minute candles', '1W': '15-minute candles' }

const S: Record<string, React.CSSProperties> = {
  app: {
    fontFamily: 'Segoe UI, system-ui, sans-serif',
    background: T.bg,
    color: T.text,
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 14px',
    borderBottom: `1px solid ${T.border}`,
    background: T.panel,
    flexShrink: 0
  },
  brand: { fontSize: 14, fontWeight: 700, color: T.text },
  search: {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    padding: '6px 10px',
    fontSize: 12.5,
    width: 180
  },
  gear: {
    marginLeft: 'auto',
    background: 'transparent',
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    padding: '5px 12px',
    fontSize: 12.5,
    cursor: 'pointer'
  },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  sidebar: {
    width: 250,
    borderRight: `1px solid ${T.border}`,
    background: T.panel,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0
  },
  sideHead: {
    padding: '8px 12px',
    fontSize: 11,
    fontWeight: 700,
    color: T.muted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    borderBottom: `1px solid ${T.border}`
  },
  watchRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '7px 10px',
    fontSize: 12.5,
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    borderBottom: `1px solid ${T.grid}`
  },
  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  symHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 14,
    padding: '10px 16px',
    borderBottom: `1px solid ${T.border}`,
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums'
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 16px',
    borderBottom: `1px solid ${T.border}`,
    flexShrink: 0
  },
  chartArea: { flex: 1, minHeight: 0, position: 'relative' },
  bottomPanel: {
    height: 250,
    borderTop: `1px solid ${T.border}`,
    background: T.panel,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0
  },
  tabRow: { display: 'flex', gap: 2, borderBottom: `1px solid ${T.border}`, padding: '0 10px', flexShrink: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' },
  th: {
    textAlign: 'left',
    color: T.muted,
    fontWeight: 600,
    padding: '5px 10px',
    borderBottom: `1px solid ${T.border}`,
    position: 'sticky',
    top: 0,
    background: T.panel
  },
  td: { padding: '4px 10px', borderBottom: `1px solid ${T.grid}`, color: T.text },
  statusBar: {
    display: 'flex',
    gap: 16,
    padding: '4px 14px',
    borderTop: `1px solid ${T.border}`,
    background: T.panel,
    fontSize: 11,
    color: T.muted,
    flexShrink: 0
  }
}

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? T.panelHover : 'transparent',
    border: `1px solid ${active ? T.accent : T.border}`,
    borderRadius: 6,
    color: active ? T.text : T.muted,
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer'
  }
}

function tabBtn(active: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    borderBottom: `2px solid ${active ? T.accent : 'transparent'}`,
    color: active ? T.text : T.muted,
    padding: '8px 14px',
    fontSize: 12.5,
    cursor: 'pointer'
  }
}

export default function App(): React.JSX.Element {
  const [watchlist, setWatchlist] = useState<WatchItem[]>([])
  const [quotes, setQuotes] = useState<Map<string, QuoteRow>>(new Map())
  const [symbol, setSymbol] = useState<string>(() => localStorage.getItem('selectedSymbol') ?? 'QQQ')
  const [search, setSearch] = useState('')
  const [dailyBars, setDailyBars] = useState<BarRow[]>([])
  const [intradayBars, setIntradayBars] = useState<IntradayBar[]>([])
  const [barsLoading, setBarsLoading] = useState(false)
  const [mode, setMode] = useState<ChartMode>(() => (localStorage.getItem('chartMode') as ChartMode) ?? 'candles')
  const [range, setRange] = useState<ChartRange>(() => (localStorage.getItem('chartRange') as ChartRange) ?? '1Y')
  // Default ON — the boxes/arrows are the discoverable entry point to the
  // pattern inspector; hover/click inspection works even when toggled off.
  const [patternsOn, setPatternsOn] = useState<boolean>(() => localStorage.getItem('patternsOn') !== '0')
  const [tab, setTab] = useState<Tab>('buffett')
  const [ivHistory, setIvHistory] = useState<IvSnapshotRow[]>([])
  const [lastJob, setLastJob] = useState<JobLogRow | null>(null)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>({ state: 'off', symbols: [] })
  const [showSettings, setShowSettings] = useState(false)
  const [keysMissing, setKeysMissing] = useState(false)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false)
  const [patternFocus, setPatternFocus] = useState<PatternFocus | null>(null)
  const [view, setView] = useState<'chart' | 'discover' | 'backtest' | 'paper' | 'portfolio' | 'journal'>('chart')
  // PaperView is mounted lazily (first open) then kept alive so ticket state
  // and the Self-Test computation survive view switches.
  const [paperOpened, setPaperOpened] = useState(false)
  // Same for JournalView: a half-written thesis must survive a view toggle.
  const [journalOpened, setJournalOpened] = useState(false)
  // Same for PortfolioView: a half-typed position must survive a view toggle.
  const [portfolioOpened, setPortfolioOpened] = useState(false)
  // Copilot chat lives HERE, not in the panel: answers cost real cents, so a
  // tab/view switch must not destroy the thread or drop an in-flight reply.
  const [copilotThreads, setCopilotThreads] = useState<CopilotThreads>({})
  const [copilotBusy, setCopilotBusy] = useState<Record<string, boolean>>({})
  const [copilotInput, setCopilotInput] = useState('')
  const livePrices = useRef<Map<string, number>>(new Map())
  const loadReqRef = useRef(0)
  const intradayReqRef = useRef(0)
  const focusNonceRef = useRef(0)

  const loadSidebar = useCallback(async () => {
    const [wl, ks] = await Promise.all([window.api.watchlist(), window.api.keysStatus()])
    setWatchlist(wl)
    setKeysMissing(!ks.alpacaKeyId || !ks.alpacaSecret)
    setHasAnthropicKey(ks.anthropicKey)
    const q = await window.api.quotesWatchlist()
    // Merge, never wholesale-replace: a transient REST failure returns nulls and
    // must not wipe live-stream prices already on screen.
    setQuotes((prev) => {
      const next = new Map(prev)
      for (const r of q) {
        const old = next.get(r.symbol)
        next.set(r.symbol, {
          symbol: r.symbol,
          price: r.price ?? old?.price ?? null,
          prevClose: r.prevClose ?? old?.prevClose ?? null
        })
      }
      return next
    })
    const jobs = await window.api.recentJobs(1)
    setLastJob(jobs[0] ?? null)
    setStreamStatus(await window.api.streamStatus())
  }, [])

  const loadSymbol = useCallback(async (sym: string, r: ChartRange) => {
    // Request token: a slow in-flight fetch for a previously selected symbol
    // must not overwrite the currently selected symbol's data.
    const req = ++loadReqRef.current
    // EVERY writer of intradayBars shares intradayReqRef: bumping it here kills
    // any in-flight range-effect fetch (possibly for another symbol or the
    // other granularity) — otherwise the stale response wins the race and the
    // chart shows the wrong symbol's (or wrong-granularity) candles.
    const ireq = ++intradayReqRef.current
    setBarsLoading(true)
    setIntradayBars([]) // never show another symbol's intraday data
    try {
      void window.api.setActiveSymbol(sym)
      const [daily, iv] = await Promise.all([window.api.bars(sym), window.api.snapshotsFor(sym, 90)])
      if (req !== loadReqRef.current) return
      setDailyBars(daily)
      setIvHistory(iv)
      if (isIntradayRange(r)) {
        const intraday = await window.api.intradayBars(sym, r as '1D' | '1W')
        if (req !== loadReqRef.current || ireq !== intradayReqRef.current) return
        setIntradayBars(intraday)
      }
    } catch {
      // IPC/DB failure — keep whatever was on screen; the loading flag clears below.
    } finally {
      if (req === loadReqRef.current) setBarsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSidebar()
    const t = setInterval(() => void loadSidebar(), 120_000)
    return () => clearInterval(t)
  }, [loadSidebar])

  useEffect(() => {
    localStorage.setItem('selectedSymbol', symbol)
    setPatternFocus(null) // a pinned pattern belongs to the previous symbol
    void loadSymbol(symbol, range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, loadSymbol])

  useEffect(() => {
    localStorage.setItem('chartRange', range)
    // Always refetch on switching to an intraday range — the main process caches
    // for 60s, so this is cheap and guarantees the bars belong to the current
    // symbol AND granularity. intradayReqRef is shared with loadSymbol so each
    // writer invalidates the other's in-flight fetch; loadReqRef stays separate
    // (bumping it here would cancel loadSymbol and strand barsLoading).
    if (isIntradayRange(range)) {
      const req = ++intradayReqRef.current
      setIntradayBars([])
      setBarsLoading(true) // without this the "No intraday bars (market closed…)" message lies during the fetch
      window.api
        .intradayBars(symbol, range as '1D' | '1W')
        .then((b) => {
          if (req === intradayReqRef.current) {
            setIntradayBars(b)
            setBarsLoading(false)
          }
        })
        .catch(() => {
          if (req === intradayReqRef.current) setBarsLoading(false)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  useEffect(() => localStorage.setItem('chartMode', mode), [mode])
  useEffect(() => localStorage.setItem('patternsOn', patternsOn ? '1' : '0'), [patternsOn])

  // --- UI test harness (`--uitest` CLI): drive the app into a deterministic
  // state so the main process can screenshot it. No-op in normal use.
  const uitestDoneRef = useRef(false)
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('uitest')
    if (!raw) return
    const p = new URLSearchParams(raw)
    const sym = p.get('symbol')
    if (sym) setSymbol(sym.toUpperCase())
    const r = p.get('range')
    if (r && (RANGES as string[]).includes(r)) setRange(r as ChartRange)
    if (p.get('patterns') != null) setPatternsOn(p.get('patterns') === '1')
    const t = p.get('tab')
    if (t) setTab(t as Tab)
    const v = p.get('view')
    if (v === 'discover' || v === 'backtest' || v === 'paper' || v === 'portfolio' || v === 'journal') setView(v)
    if (v === 'paper') setPaperOpened(true)
    if (v === 'portfolio') setPortfolioOpened(true)
    if (v === 'journal') setJournalOpened(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pattern detection is cheap and pure; always computed for the Signals tab,
  // shown as chart markers only when toggled on. Guarded by symbol: right after
  // a symbol switch, dailyBars still holds the PREVIOUS symbol's bars until the
  // new fetch resolves — their patterns must not render under the new symbol.
  const patternHits = useMemo(
    () =>
      dailyBars.length > 0 && dailyBars[0].symbol === symbol
        ? detectPatterns(
            dailyBars.map((b) => ({ t: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
          )
        : NO_PATTERNS,
    [dailyBars, symbol]
  )

  // Patterns at the SELECTED timeframe's granularity (1-min candles on 1D,
  // 15-min on 1W); daily ranges fall back to the daily set above.
  const tfPatternHits = useMemo(
    () =>
      isIntradayRange(range) && intradayBars.length > 0
        ? detectPatterns(
            intradayBars.map((b) => ({ t: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
            240
          )
        : NO_PATTERNS,
    [intradayBars, range]
  )

  // Chart markers use whichever granularity is on screen.
  const chartPatternHits = isIntradayRange(range) ? tfPatternHits : patternHits

  // Clicking a pattern in the Signals tab jumps the chart to that candle.
  // Daily-list patterns need a daily chart: if an intraday range is active,
  // switch to the smallest daily range that reaches the pattern's date (the
  // chart centers on it either way).
  const jumpToPattern = useCallback(
    (hit: PatternHit, scope: 'daily' | 'tf') => {
      if (scope === 'daily' && isIntradayRange(range)) {
        const ageDays = (Date.now() - Date.parse(`${String(hit.key)}T12:00:00`)) / 86_400_000
        setRange(ageDays <= 85 ? '3M' : ageDays <= 175 ? '6M' : '1Y')
      }
      setPatternFocus({ hit, nonce: ++focusNonceRef.current })
    },
    [range]
  )

  // UI-test auto-pin: jump to a pattern once hits are available (see harness above).
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('uitest')
    if (!raw || uitestDoneRef.current) return
    const p = new URLSearchParams(raw)
    const pin = p.get('pin') // e.g. "daily.1" = second-most-recent daily pattern (dot separator — a colon in a CLI arg kills Electron's arg parsing on Windows)
    if (!pin) return
    const [scope, idxStr] = pin.split('.')
    const hits = scope === 'tf' ? tfPatternHits : patternHits
    if (hits.length === 0) return
    uitestDoneRef.current = true
    const idx = Math.max(0, hits.length - 1 - (Number(idxStr) || 0))
    // Small delay so the chart finishes its initial layout first. Deliberately
    // NO cleanup: dep-identity churn (e.g. the intraday fetch landing right
    // after the daily one) would cancel the armed one-shot and — with the done
    // flag already set — the pin would silently never happen.
    setTimeout(() => jumpToPattern(hits[idx], scope === 'tf' ? 'tf' : 'daily'), 1200)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternHits, tfPatternHits])

  // Live prices: collect ticks in a ref, flush to the watchlist once per second.
  useEffect(() => {
    const off = window.api.onStreamTrade((t) => livePrices.current.set(t.symbol, t.price))
    const offStatus = window.api.onStreamStatus(setStreamStatus)
    const flush = setInterval(() => {
      if (livePrices.current.size === 0) return
      setQuotes((prev) => {
        const next = new Map(prev)
        for (const [s, p] of livePrices.current) {
          const q = next.get(s)
          next.set(s, { symbol: s, price: p, prevClose: q?.prevClose ?? null })
        }
        return next
      })
      livePrices.current.clear()
    }, 1000)
    return () => {
      off()
      offStatus()
      clearInterval(flush)
    }
  }, [])

  const quote = quotes.get(symbol)
  const lastBar = dailyBars.length ? dailyBars[dailyBars.length - 1] : null
  const price = quote?.price ?? lastBar?.close ?? null
  const prevClose = quote?.prevClose ?? (dailyBars.length > 1 ? dailyBars[dailyBars.length - 2].close : null)
  const changePct = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null
  const latestIv = ivHistory.length ? ivHistory[0] : null
  const isLive = streamStatus.state === 'live' && streamStatus.symbols.includes(symbol)

  const submitSearch = (): void => {
    const s = search.trim().toUpperCase()
    if (/^[A-Z.]{1,6}$/.test(s)) {
      setSymbol(s)
      setSearch('')
    }
  }

  return (
    <div style={S.app}>
      <div style={S.topBar}>
        <span style={S.brand}>Investing</span>
        <input
          style={S.search}
          placeholder="Symbol… (Enter)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
        />
        <button
          style={{
            ...S.gear,
            marginLeft: 0,
            borderColor: view === 'discover' ? T.accent : T.border,
            color: view === 'discover' ? T.text : T.muted
          }}
          title="Broad-market discovery: sector rotation, movers, momentum leaders, focus panels"
          onClick={() => setView(view === 'discover' ? 'chart' : 'discover')}
        >
          ⌕ Discover
        </button>
        <button
          style={{
            ...S.gear,
            marginLeft: 0,
            borderColor: view === 'backtest' ? T.accent : T.border,
            color: view === 'backtest' ? T.text : T.muted
          }}
          title="Backtest the app's signal families with honest metrics (deflated Sharpe, costs, survivorship warnings)"
          onClick={() => setView(view === 'backtest' ? 'chart' : 'backtest')}
        >
          ⧗ Backtest
        </button>
        <button
          style={{
            ...S.gear,
            marginLeft: 0,
            borderColor: view === 'paper' ? T.accent : T.border,
            color: view === 'paper' ? T.text : T.muted
          }}
          title="Alpaca paper trading + Self-Test: backtest expectation vs forward reality"
          onClick={() => {
            setPaperOpened(true)
            setView(view === 'paper' ? 'chart' : 'paper')
          }}
        >
          ⚑ Paper
        </button>
        <button
          style={{
            ...S.gear,
            marginLeft: 0,
            borderColor: view === 'portfolio' ? T.accent : T.border,
            color: view === 'portfolio' ? T.text : T.muted
          }}
          title="Your actual holdings (manual entry): live pricing, weights, concentration flags, engine reads per position"
          onClick={() => {
            setPortfolioOpened(true)
            setView(view === 'portfolio' ? 'chart' : 'portfolio')
          }}
        >
          ⌂ Portfolio
        </button>
        <button
          style={{
            ...S.gear,
            marginLeft: 0,
            borderColor: view === 'journal' ? T.accent : T.border,
            color: view === 'journal' ? T.text : T.muted
          }}
          title="Trade journal (thesis before, outcome after) + price/IV alerts"
          onClick={() => {
            setJournalOpened(true)
            setView(view === 'journal' ? 'chart' : 'journal')
          }}
        >
          ⛁ Journal
        </button>
        {keysMissing && <span style={{ fontSize: 12, color: T.warn }}>Alpaca keys missing — set them in Settings</span>}
        <button style={S.gear} onClick={() => setShowSettings(true)}>
          ⚙ Settings
        </button>
      </div>

      <div style={S.body}>
        <div style={S.sidebar}>
          <div style={S.sideHead}>Watchlist · ★ = live stream</div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {watchlist.map((w) => {
              const q = quotes.get(w.symbol)
              const pct = q?.price != null && q?.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null
              const selected = w.symbol === symbol
              return (
                <div
                  key={w.symbol}
                  style={{
                    ...S.watchRow,
                    background: selected ? T.panelHover : 'transparent',
                    borderLeft: `2px solid ${selected ? T.accent : 'transparent'}`
                  }}
                  onClick={() => {
                    setSymbol(w.symbol)
                    setView('chart') // from Discover/Backtest/Paper/Journal, a watchlist click returns to the chart
                  }}
                >
                  <span
                    title={w.favorite ? 'Streaming live — click to unfavorite' : 'Click to stream live'}
                    style={{ color: w.favorite ? T.warn : T.faint, marginRight: 6, cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.api.setFavorite(w.symbol, !w.favorite).then(setWatchlist)
                    }}
                  >
                    {w.favorite ? '★' : '☆'}
                  </span>
                  <span style={{ fontWeight: 600, width: 56 }}>{w.symbol}</span>
                  <span style={{ marginLeft: 'auto', color: T.text }}>{fmtPrice(q?.price ?? null)}</span>
                  <span style={{ width: 62, textAlign: 'right', color: pctColor(pct) }}>{fmtPct(pct)}</span>
                </div>
              )
            })}
          </div>
          {!watchlist.some((w) => w.symbol === symbol) && (
            <div
              style={{ ...S.watchRow, color: T.accent, borderTop: `1px solid ${T.border}` }}
              onClick={() => void window.api.watchlistAdd(symbol).then(setWatchlist)}
            >
              + Add {symbol} to watchlist
            </div>
          )}
        </div>

        <div style={S.main}>
          {view === 'discover' && (
            <DiscoveryView
              onSelect={(sym) => {
                setSymbol(sym)
                setView('chart')
              }}
            />
          )}
          {/* Kept MOUNTED (hidden) so a running backtest — up to a minute on
              first run — survives view switches instead of being discarded
              and re-armed for a duplicate concurrent run. */}
          <div style={{ display: view === 'backtest' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <BacktestView />
          </div>
          {paperOpened && (
            <div style={{ display: view === 'paper' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <PaperView
                onSelect={(sym) => {
                  setSymbol(sym)
                  setView('chart')
                }}
              />
            </div>
          )}
          {portfolioOpened && (
            <div style={{ display: view === 'portfolio' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <PortfolioView
                active={view === 'portfolio'}
                onSelect={(sym) => {
                  setSymbol(sym)
                  setView('chart')
                }}
              />
            </div>
          )}
          {journalOpened && (
            <div style={{ display: view === 'journal' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <JournalView
                active={view === 'journal'}
                onSelect={(sym) => {
                  setSymbol(sym)
                  setView('chart')
                }}
              />
            </div>
          )}
          {view === 'chart' && (
            <>
          <div style={S.symHeader}>
            <span style={{ fontSize: 20, fontWeight: 700 }}>{symbol}</span>
            <span style={{ fontSize: 20, color: T.text }}>{fmtPrice(price)}</span>
            <span style={{ fontSize: 14, color: pctColor(changePct) }}>{fmtPct(changePct)}</span>
            {isLive && (
              <span style={{ fontSize: 11, color: T.up, border: `1px solid ${T.up}`, borderRadius: 4, padding: '1px 6px' }}>
                ● LIVE
              </span>
            )}
            {latestIv?.atm_iv_30d != null && (
              <span style={{ fontSize: 12, color: T.muted }}>
                ATM IV ~30d: <span style={{ color: T.text }}>{(latestIv.atm_iv_30d * 100).toFixed(1)}%</span> · IV days
                collected: {ivHistory.length}
              </span>
            )}
          </div>

          <div style={S.toolbar}>
            <button style={toggleBtn(mode === 'candles')} onClick={() => setMode('candles')}>
              Candles
            </button>
            <button style={toggleBtn(mode === 'line')} onClick={() => setMode('line')}>
              Line
            </button>
            <span style={{ width: 12 }} />
            {RANGES.map((r) => (
              <button key={r} style={toggleBtn(range === r)} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
            <span style={{ width: 12 }} />
            <button
              style={toggleBtn(patternsOn)}
              title="Mark detected candlestick patterns on the chart (annotations, not signals — see Signals tab)"
              onClick={() => setPatternsOn((v) => !v)}
            >
              Patterns
            </button>
            {barsLoading && <span style={{ fontSize: 11.5, color: T.muted, marginLeft: 8 }}>loading…</span>}
          </div>

          <div style={S.chartArea}>
            {(isIntradayRange(range) ? intradayBars.length : dailyBars.length) > 0 ? (
              <PriceChart
                dailyBars={dailyBars}
                intradayBars={intradayBars}
                range={range}
                mode={mode}
                symbol={symbol}
                patterns={chartPatternHits}
                showPatternMarks={patternsOn}
                focus={patternFocus}
              />
            ) : (
              <div style={{ padding: 24, color: T.muted, fontSize: 13 }}>
                {barsLoading
                  ? 'Loading price history…'
                  : keysMissing
                    ? 'No price data — add your Alpaca keys in Settings, then reselect the symbol.'
                    : isIntradayRange(range)
                      ? `No intraday bars for ${symbol} yet today (market closed or IEX-quiet symbol) — try a longer range.`
                      : `No daily bars for ${symbol} yet. If this is a valid US-listed symbol, it will load on selection.`}
              </div>
            )}
          </div>

          <div style={S.bottomPanel}>
            <div style={S.tabRow}>
              <button style={tabBtn(tab === 'buffett')} onClick={() => setTab('buffett')}>
                Buffett Score
              </button>
              <button style={tabBtn(tab === 'description')} onClick={() => setTab('description')}>
                Description
              </button>
              <button style={tabBtn(tab === 'signals')} onClick={() => setTab('signals')}>
                Signals
              </button>
              <button style={tabBtn(tab === 'options')} onClick={() => setTab('options')}>
                Options
              </button>
              <button style={tabBtn(tab === 'volatility')} onClick={() => setTab('volatility')}>
                Volatility
              </button>
              <button style={tabBtn(tab === 'news')} onClick={() => setTab('news')}>
                News
              </button>
              <button style={tabBtn(tab === 'copilot')} onClick={() => setTab('copilot')}>
                ✦ Copilot
              </button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {tab === 'buffett' && <BuffettPanel symbol={symbol} />}
              {tab === 'description' && <DescriptionPanel symbol={symbol} />}
              {tab === 'signals' && (
                <SignalsPanel
                  symbol={symbol}
                  patterns={patternHits}
                  tfPatterns={isIntradayRange(range) ? tfPatternHits : null}
                  tfLabel={isIntradayRange(range) ? `${range} view — ${TF_LABEL[range]}` : null}
                  onJump={jumpToPattern}
                />
              )}
              {tab === 'options' && <OptionsPanel symbol={symbol} />}
              {tab === 'news' && <NewsPanel symbol={symbol} />}
              {tab === 'copilot' && (
                <div style={{ flex: 1, minHeight: 0 }}>
                  <CopilotPanel
                    symbol={symbol}
                    hasKey={hasAnthropicKey}
                    threads={copilotThreads}
                    setThreads={setCopilotThreads}
                    busy={copilotBusy}
                    setBusy={setCopilotBusy}
                    input={copilotInput}
                    setInput={setCopilotInput}
                  />
                </div>
              )}
              {tab === 'volatility' && (
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>IV snapshot (NY date)</th>
                      <th style={S.th}>Spot</th>
                      <th style={S.th}>ATM IV ~30d</th>
                      <th style={S.th}>Expirations</th>
                      <th style={S.th}>Skew (25Δ put−call, near)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ivHistory.map((s) => (
                      <tr key={s.id}>
                        <td style={S.td}>{s.snapshot_date}</td>
                        <td style={S.td}>{fmtPrice(s.spot)}</td>
                        <td style={S.td}>{s.atm_iv_30d != null ? (s.atm_iv_30d * 100).toFixed(1) + '%' : '—'}</td>
                        <td style={S.td}>{expCount(s.expirations)}</td>
                        <td style={S.td}>{nearSkew(s.expirations)}</td>
                      </tr>
                    ))}
                    {ivHistory.length === 0 && (
                      <tr>
                        <td style={S.td} colSpan={5}>
                          No IV snapshots for {symbol} yet — captured daily for watchlist symbols. IV Rank needs ~1 year
                          of history; every day counts.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
            </>
          )}
        </div>
      </div>

      <div style={S.statusBar}>
        <span
          style={{
            color: streamStatus.state === 'live' ? T.up : streamStatus.state === 'error' ? T.down : T.muted
          }}
        >
          ● stream: {streamStatus.state}
          {streamStatus.state === 'live' ? ` (${streamStatus.symbols.length} symbols)` : ''}
          {streamStatus.detail ? ` — ${streamStatus.detail}` : ''}
        </span>
        <span>
          Last job: {lastJob ? `${lastJob.job} · ${lastJob.status} (${lastJob.ran_at} UTC)` : '—'}
        </span>
        <span style={{ marginLeft: 'auto' }}>IEX feed · live via websocket (no REST quota) · not advice</span>
      </div>

      {showSettings && (
        <Settings
          onClose={() => {
            setShowSettings(false)
            void loadSidebar()
          }}
        />
      )}
    </div>
  )
}

function expCount(json: string): number {
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? a.length : 0
  } catch {
    return 0
  }
}

function nearSkew(json: string): string {
  try {
    const a = JSON.parse(json) as { dte: number; call25dIv: number | null; put25dIv: number | null }[]
    if (!Array.isArray(a)) return '—'
    const near = a
      .filter((e) => e.call25dIv != null && e.put25dIv != null && e.dte >= 20)
      .sort((x, y) => Math.abs(x.dte - 30) - Math.abs(y.dte - 30))[0]
    if (!near) return '—'
    const skew = ((near.put25dIv as number) - (near.call25dIv as number)) * 100
    return `${skew >= 0 ? '+' : ''}${skew.toFixed(1)} pts`
  } catch {
    return '—'
  }
}
