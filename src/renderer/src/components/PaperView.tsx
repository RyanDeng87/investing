import { useEffect, useRef, useState } from 'react'
import { ColorType, createChart, type IChartApi, type Time } from 'lightweight-charts'
import type { PaperOrderInput, PaperSnapshot, PortfolioHistoryPoint, SelfTestReport } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T, fmtPrice } from '../theme'

// Phase 6: Alpaca PAPER trading + the Self-Test dashboard (PLAN.md §3).
// The paper account answers "how is it doing from TODAY forward" — the
// forward, out-of-sample validation that backtests systematically overstate.
// Orders here go to paper-api.alpaca.markets only: simulated fills, zero real
// dollars, same API shape as live if that ever becomes a goal.

function usd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function pct(v: number | null | undefined, digits = 1, signed = true): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${signed && v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}

function Tile({ label, value, color, tip }: { label: string; value: string; color?: string; tip?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ minWidth: 130 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
        {tip && <InfoTip width={320}>{tip}</InfoTip>}
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color ?? T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function HistoryChart({ points }: { points: PortfolioHistoryPoint[] }): React.JSX.Element {
  const chartRef = useRef<IChartApi | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!el || points.length === 0) return
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: T.bg }, textColor: T.muted, fontSize: 11 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      rightPriceScale: { borderColor: T.border },
      timeScale: { borderColor: T.border, fixLeftEdge: true, fixRightEdge: true }
    })
    chartRef.current = chart
    const line = chart.addLineSeries({ color: T.accent, lineWidth: 2 })
    line.setData(points.map((p) => ({ time: p.date as Time, value: p.equity })))
    chart.timeScale().fitContent()
    const resize = (): void => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [el, points])

  if (points.length === 0) return <div style={{ color: T.faint, fontSize: 11.5, padding: 12 }}>No history yet — it starts accruing once the account has activity.</div>
  return <div ref={setEl} style={{ width: '100%', height: 160 }} />
}

interface TicketState {
  symbol: string
  side: 'buy' | 'sell'
  mode: 'qty' | 'notional'
  qty: string
  notional: string
  type: 'market' | 'limit'
  limitPrice: string
  tif: 'day' | 'gtc'
}

const TICKET0: TicketState = { symbol: '', side: 'buy', mode: 'qty', qty: '1', notional: '100', type: 'market', limitPrice: '', tif: 'day' }

export default function PaperView({ onSelect }: { onSelect?: (symbol: string) => void }): React.JSX.Element {
  const [snap, setSnap] = useState<PaperSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<PortfolioHistoryPoint[]>([])
  const [period, setPeriod] = useState<'1M' | '3M' | '1A'>('3M')
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null)
  const [selfTestLoading, setSelfTestLoading] = useState(false)
  const [ticket, setTicket] = useState<TicketState>(TICKET0)
  const [reviewing, setReviewing] = useState(false)
  const [orderMsg, setOrderMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [placing, setPlacing] = useState(false)
  const seqRef = useRef(0)

  const refresh = (): void => {
    const seq = ++seqRef.current
    setLoading(true)
    window.api
      .paperSnapshot()
      .then((s) => {
        if (seq === seqRef.current) setSnap(s)
      })
      .catch((e: unknown) => {
        if (seq === seqRef.current)
          setSnap({ available: false, message: e instanceof Error ? e.message : String(e), account: null, positions: [], openOrders: [], recentOrders: [] })
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false)
      })
  }

  useEffect(() => {
    refresh()
    setSelfTestLoading(true)
    window.api
      .selfTest()
      .then(setSelfTest)
      .catch(() => setSelfTest(null))
      .finally(() => setSelfTestLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let stale = false
    window.api
      .paperHistory(period)
      .then((h) => {
        if (!stale) setHistory(h)
      })
      .catch(() => {
        if (!stale) setHistory([])
      })
    return () => {
      stale = true
    }
  }, [period])

  const submit = (): void => {
    if (placing) return
    setPlacing(true)
    setOrderMsg(null)
    const input: PaperOrderInput = {
      symbol: ticket.symbol.trim().toUpperCase(),
      side: ticket.side,
      type: ticket.type,
      tif: ticket.tif,
      ...(ticket.mode === 'qty' ? { qty: Number(ticket.qty) } : { notional: Number(ticket.notional) }),
      ...(ticket.type === 'limit' ? { limitPrice: Number(ticket.limitPrice) } : {})
    }
    window.api
      .paperPlaceOrder(input)
      .then((o) => {
        setOrderMsg({ ok: true, text: `Order ${o.status}: ${o.side} ${o.qty ?? `$${o.notional}`} ${o.symbol} (${o.type})` })
        setReviewing(false)
        refresh()
      })
      .catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e)
        // Electron wraps IPC errors as "Error invoking remote method '…': Error: <msg>"
        setOrderMsg({ ok: false, text: raw.replace(/^.*'paper:place'.*?Error:\s*/s, '') })
      })
      .finally(() => setPlacing(false))
  }

  const cancel = (id: string): void => {
    window.api
      .paperCancelOrder(id)
      .then(() => refresh())
      .catch((e: unknown) => setOrderMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }))
  }

  const a = snap?.account ?? null
  const dayPl = a?.equity != null && a?.lastEquity != null ? a.equity - a.lastEquity : null
  const dayPlPct = dayPl != null && a?.lastEquity ? dayPl / a.lastEquity : null
  const inputStyle: React.CSSProperties = {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    padding: '5px 8px',
    fontSize: 12,
    width: 76
  }
  const sectionTitle: React.CSSProperties = { color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }
  const th: React.CSSProperties = { color: T.muted, fontWeight: 400, textAlign: 'right', padding: '2px 0 4px 16px', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { color: T.text, textAlign: 'right', padding: '3px 0 3px 16px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

  return (
    <div data-scroll-container style={{ padding: '12px 16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Paper Trading</span>
        <span style={{ fontSize: 11.5, color: T.muted }}>Alpaca paper account — simulated fills, zero real dollars</span>
        <InfoTip width={380}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Why paper trading is here</div>
          <div style={{ color: T.muted }}>
            The backtester answers "how would this have done"; this account answers "how is it doing from today
            forward" — genuine out-of-sample. Orders route to paper-api.alpaca.markets only. Fills are simulated
            (roughly at the quote, no real queue), so treat results as directionally honest, slightly optimistic.
          </div>
        </InfoTip>
        <button
          onClick={refresh}
          disabled={loading}
          style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6, color: loading ? T.faint : T.muted, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >
          {loading ? '…' : '↻ refresh'}
        </button>
      </div>

      {snap && !snap.available && <div style={{ color: T.warn, fontSize: 12.5, marginBottom: 12 }}>{snap.message}</div>}

      {snap?.available && a && (
        <>
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginBottom: 12 }}>
            <Tile label="Equity" value={usd(a.equity)} tip={<span>Cash + market value of positions, marked to the latest quotes.</span>} />
            <Tile
              label="Day P&L"
              value={`${usd(dayPl)}${dayPlPct != null ? ` (${pct(dayPlPct)})` : ''}`}
              color={dayPl == null ? T.muted : dayPl >= 0 ? T.up : T.down}
              tip={<span>Change vs yesterday's closing equity.</span>}
            />
            <Tile label="Cash" value={usd(a.cash)} />
            <Tile label="Buying power" value={usd(a.buyingPower)} tip={<span>Paper accounts default to 2× margin — buying power above cash is simulated margin, not free money. Staying within cash keeps the experiment realistic for a Roth-style account (no margin there).</span>} />
            <Tile label="Status" value={a.status} color={a.status === 'ACTIVE' ? T.up : T.warn} />
          </div>

          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 14, maxWidth: 1100 }}>
            <div style={{ padding: '6px 12px', borderBottom: `1px solid ${T.border}`, color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', gap: 10, alignItems: 'center' }}>
              Account equity
              <span style={{ display: 'inline-flex', gap: 4 }}>
                {(['1M', '3M', '1A'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    style={{
                      background: period === p ? T.panelHover : 'transparent',
                      border: `1px solid ${period === p ? T.crosshair : T.border}`,
                      borderRadius: 5,
                      color: period === p ? T.text : T.muted,
                      padding: '1px 8px',
                      fontSize: 11,
                      cursor: 'pointer'
                    }}
                  >
                    {p === '1A' ? '1Y' : p}
                  </button>
                ))}
              </span>
            </div>
            <HistoryChart points={history} />
          </div>

          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 16, maxWidth: 1100 }}>
            <div style={{ flex: '1 1 460px', minWidth: 380 }}>
              <div style={sectionTitle}>Positions</div>
              {snap.positions.length === 0 && <div style={{ color: T.faint, fontSize: 12 }}>None yet — place a paper order to start the experiment.</div>}
              {snap.positions.length > 0 && (
                <table style={{ borderCollapse: 'collapse', fontSize: 11.5, width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left', paddingLeft: 0 }}>Symbol</th>
                      <th style={th}>Qty</th>
                      <th style={th}>Avg entry</th>
                      <th style={th}>Last</th>
                      <th style={th}>Value</th>
                      <th style={th}>Weight</th>
                      <th style={th}>Unrl P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.positions.map((p) => (
                      <tr key={p.symbol}>
                        <td
                          style={{ ...td, textAlign: 'left', paddingLeft: 0, color: T.accent, cursor: onSelect ? 'pointer' : 'default' }}
                          onClick={() => onSelect?.(p.symbol)}
                        >
                          {p.symbol}
                        </td>
                        <td style={td}>{p.qty}</td>
                        <td style={td}>{fmtPrice(p.avgEntry)}</td>
                        <td style={td}>{fmtPrice(p.currentPrice)}</td>
                        <td style={td}>{usd(p.marketValue)}</td>
                        <td style={td}>{p.weight == null ? '—' : `${(p.weight * 100).toFixed(1)}%`}</td>
                        <td style={{ ...td, color: (p.unrealizedPl ?? 0) >= 0 ? T.up : T.down }}>
                          {usd(p.unrealizedPl)} ({pct(p.unrealizedPlPct)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {snap.openOrders.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={sectionTitle}>Open orders</div>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <tbody>
                      {snap.openOrders.map((o) => (
                        <tr key={o.id}>
                          <td style={{ ...td, textAlign: 'left', paddingLeft: 0 }}>{o.symbol}</td>
                          <td style={{ ...td, color: o.side === 'buy' ? T.up : T.down }}>{o.side}</td>
                          <td style={td}>{o.qty ?? `$${o.notional}`}</td>
                          <td style={td}>
                            {o.type}
                            {o.limitPrice != null ? ` @${fmtPrice(o.limitPrice)}` : ''}
                          </td>
                          <td style={td}>{o.tif}</td>
                          <td style={{ ...td, color: T.muted }}>{o.status}</td>
                          <td style={td}>
                            <button
                              onClick={() => cancel(o.id)}
                              style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 5, color: T.down, padding: '1px 8px', fontSize: 11, cursor: 'pointer' }}
                            >
                              cancel
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {snap.recentOrders.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={sectionTitle}>Recent orders</div>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <tbody>
                      {snap.recentOrders.map((o) => (
                        <tr key={o.id}>
                          <td style={{ ...td, textAlign: 'left', paddingLeft: 0, color: T.muted, whiteSpace: 'nowrap' }}>{o.submittedAt.slice(0, 10)}</td>
                          <td style={td}>{o.symbol}</td>
                          <td style={{ ...td, color: o.side === 'buy' ? T.up : T.down }}>{o.side}</td>
                          {/* filled_qty is "0" for cancelled/expired orders — show the ordered size, not 0 */}
                          <td style={td}>{o.filledQty ? o.filledQty : (o.qty ?? `$${o.notional}`)}</td>
                          <td style={td}>{o.filledAvgPrice != null ? `@${fmtPrice(o.filledAvgPrice)}` : o.type}</td>
                          <td style={{ ...td, color: o.status === 'filled' ? T.up : T.muted }}>{o.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={{ flex: '0 0 300px', border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
                Order ticket
                <InfoTip width={300}>
                  <span>
                    Paper only. Market notional (dollar) orders let you buy fractional shares — handy for mirroring a
                    strategy's weights. Limit orders rest until filled or cancelled ({'"'}gtc{'"'}) / end of day ({'"'}day{'"'}).
                  </span>
                </InfoTip>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={ticket.symbol}
                    onChange={(e) => {
                      setTicket({ ...ticket, symbol: e.target.value.toUpperCase() })
                      setReviewing(false)
                    }}
                    placeholder="SPY"
                    style={{ ...inputStyle, width: 70 }}
                    spellCheck={false}
                  />
                  {(['buy', 'sell'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setTicket({ ...ticket, side: s })
                        setReviewing(false)
                      }}
                      style={{
                        background: ticket.side === s ? (s === 'buy' ? T.up : T.down) : 'transparent',
                        border: `1px solid ${ticket.side === s ? 'transparent' : T.border}`,
                        borderRadius: 5,
                        color: ticket.side === s ? '#fff' : T.muted,
                        padding: '4px 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={ticket.mode}
                    onChange={(e) => {
                      const mode = e.target.value as 'qty' | 'notional'
                      setTicket({ ...ticket, mode, type: mode === 'notional' ? 'market' : ticket.type, tif: mode === 'notional' ? 'day' : ticket.tif })
                      setReviewing(false)
                    }}
                    style={{ ...inputStyle, width: 86 }}
                  >
                    <option value="qty">shares</option>
                    <option value="notional">dollars</option>
                  </select>
                  {ticket.mode === 'qty' ? (
                    <input type="number" min={0} value={ticket.qty} onChange={(e) => { setTicket({ ...ticket, qty: e.target.value }); setReviewing(false) }} style={inputStyle} />
                  ) : (
                    <input type="number" min={0} value={ticket.notional} onChange={(e) => { setTicket({ ...ticket, notional: e.target.value }); setReviewing(false) }} style={inputStyle} />
                  )}
                  <select
                    value={ticket.type}
                    onChange={(e) => { setTicket({ ...ticket, type: e.target.value as 'market' | 'limit' }); setReviewing(false) }}
                    disabled={ticket.mode === 'notional'}
                    style={{ ...inputStyle, width: 86 }}
                  >
                    <option value="market">market</option>
                    <option value="limit">limit</option>
                  </select>
                  {ticket.type === 'limit' && (
                    <input
                      type="number"
                      min={0}
                      value={ticket.limitPrice}
                      onChange={(e) => { setTicket({ ...ticket, limitPrice: e.target.value }); setReviewing(false) }}
                      placeholder="limit $"
                      style={inputStyle}
                    />
                  )}
                  <select
                    value={ticket.tif}
                    onChange={(e) => { setTicket({ ...ticket, tif: e.target.value as 'day' | 'gtc' }); setReviewing(false) }}
                    disabled={ticket.mode === 'notional'}
                    style={{ ...inputStyle, width: 66 }}
                  >
                    <option value="day">day</option>
                    <option value="gtc">gtc</option>
                  </select>
                </div>
                {!reviewing && (
                  <button
                    onClick={() => {
                      setOrderMsg(null)
                      setReviewing(true)
                    }}
                    disabled={!ticket.symbol.trim()}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${T.accent}`,
                      borderRadius: 6,
                      color: ticket.symbol.trim() ? T.accent : T.faint,
                      padding: '6px 0',
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: ticket.symbol.trim() ? 'pointer' : 'default'
                    }}
                  >
                    Review order
                  </button>
                )}
                {reviewing && (
                  <div style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: '8px 10px', fontSize: 12, color: T.text }}>
                    <div style={{ marginBottom: 6 }}>
                      <b style={{ color: ticket.side === 'buy' ? T.up : T.down }}>{ticket.side.toUpperCase()}</b>{' '}
                      {ticket.mode === 'qty' ? `${ticket.qty} sh` : `$${ticket.notional}`} <b>{ticket.symbol.trim().toUpperCase()}</b>{' '}
                      {ticket.type}
                      {ticket.type === 'limit' ? ` @ ${ticket.limitPrice}` : ''} · {ticket.tif} · paper
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={submit}
                        disabled={placing}
                        style={{ background: T.accent, border: 'none', borderRadius: 5, color: '#fff', padding: '4px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        {placing ? 'Submitting…' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => setReviewing(false)}
                        style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 5, color: T.muted, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
                      >
                        back
                      </button>
                    </div>
                  </div>
                )}
                {orderMsg && <div style={{ color: orderMsg.ok ? T.up : T.down, fontSize: 11.5, lineHeight: 1.4 }}>{orderMsg.text}</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {/* --- Self-Test: the app grades itself --- */}
      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Self-Test</span>
          <span style={{ fontSize: 11.5, color: T.muted }}>backtest expectation vs what actually happened next</span>
          <InfoTip width={400}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>The app grades itself</div>
            <div style={{ color: T.muted }}>
              Each strategy's backtest metrics were frozen on its anchor date. The forward columns re-run the same
              engine on data that arrived AFTER that date — true out-of-sample. The research says forward should run
              worse than the backtest; watching whether (and by how much) that happens here is the whole point.
            </div>
          </InfoTip>
        </div>
        {selfTestLoading && <div style={{ color: T.muted, fontSize: 12 }}>Computing (first open anchors the strategies — one-time)…</div>}
        {selfTest && !selfTest.available && <div style={{ color: T.warn, fontSize: 12 }}>{selfTest.message}</div>}
        {selfTest?.available && (
          <>
            <table style={{ borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', marginBottom: 10 }}>
              <thead>
                <tr>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'left', padding: '2px 18px 4px 0' }}>Strategy</th>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'left', padding: '2px 18px 4px 0' }}>Anchored</th>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'right', padding: '2px 18px 4px 0' }}>Expected CAGR</th>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'right', padding: '2px 18px 4px 0' }}>Expected Sharpe · DSR</th>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'right', padding: '2px 18px 4px 0' }}>Forward return</th>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'right', padding: '2px 18px 4px 0' }}>Forward Sharpe</th>
                  <th style={{ color: T.muted, fontWeight: 400, textAlign: 'right', padding: '2px 0 4px 0' }}>SPY fwd</th>
                </tr>
              </thead>
              <tbody>
                {selfTest.entries.map((e) => (
                  <tr key={e.strategy}>
                    <td style={{ color: T.text, padding: '3px 18px 3px 0', whiteSpace: 'nowrap' }}>{e.label}</td>
                    <td style={{ color: T.muted, padding: '3px 18px 3px 0', whiteSpace: 'nowrap' }}>
                      {e.anchorDate} <span style={{ color: T.faint }}>({e.tradingDaysForward}d fwd)</span>
                    </td>
                    <td style={{ color: T.text, textAlign: 'right', padding: '3px 18px 3px 0' }}>{pct(e.expectation.cagr)}</td>
                    <td style={{ color: T.text, textAlign: 'right', padding: '3px 18px 3px 0' }}>
                      {e.expectation.sharpe.toFixed(2)} · {(e.expectation.dsr * 100).toFixed(0)}%
                    </td>
                    {e.forward ? (
                      <>
                        <td style={{ color: e.forward.totalReturn >= 0 ? T.up : T.down, textAlign: 'right', padding: '3px 18px 3px 0' }}>
                          {pct(e.forward.totalReturn)}
                        </td>
                        <td
                          style={{
                            color: e.forward.sharpe >= e.expectation.sharpe ? T.up : T.warn,
                            textAlign: 'right',
                            padding: '3px 18px 3px 0'
                          }}
                        >
                          {e.forward.sharpe.toFixed(2)}
                        </td>
                        <td style={{ color: T.muted, textAlign: 'right', padding: '3px 0' }}>{pct(e.benchForward?.totalReturn)}</td>
                      </>
                    ) : (
                      <td colSpan={3} style={{ color: T.faint, textAlign: 'right', padding: '3px 0' }}>
                        accruing — {e.note}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {selfTest.targets.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
                  What each strategy says to hold right now
                  <InfoTip width={330}>
                    <span>
                      Evaluated at the latest cached close. Mirroring one of these in the paper account (the dollar
                      ticket makes the weights easy) turns the Self-Test into a fills-and-all experiment. ✓ marks
                      holdings already in the account.
                    </span>
                  </InfoTip>
                </div>
                {selfTest.targets.map((t) => (
                  <div key={t.strategy} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ color: T.muted, fontSize: 11.5, minWidth: 210 }}>{t.label}</span>
                    {t.holdings.length === 0 && <span style={{ color: T.faint, fontSize: 11.5 }}>100% cash</span>}
                    {t.holdings.map((h) => {
                      const held = snap?.positions.some((p) => p.symbol === h.symbol)
                      return (
                        <span
                          key={h.symbol}
                          style={{
                            border: `1px solid ${held ? T.up : T.border}`,
                            borderRadius: 10,
                            padding: '1px 9px',
                            fontSize: 11,
                            color: held ? T.up : T.text,
                            fontVariantNumeric: 'tabular-nums'
                          }}
                        >
                          {held ? '✓ ' : ''}
                          {h.symbol} {(h.weight * 100).toFixed(0)}%
                        </span>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}

            <div style={{ color: T.faint, fontSize: 10.5, lineHeight: 1.55 }}>
              {selfTest.disclosures.map((d, i) => (
                <div key={i}>• {d}</div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
