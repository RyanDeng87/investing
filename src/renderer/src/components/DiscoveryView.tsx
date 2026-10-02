import { useEffect, useRef, useState } from 'react'
import type { DiscoveryReport, DiscoverySymbolStat, FearGreed, MacroReport, MarketBrief, QarpLeaderboard } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T } from '../theme'

// Phase 8 Market Discovery dashboard — broad-market CONTEXT panels. Clicking
// any symbol loads it into the chart + engines; nothing here is a buy list.

interface Props {
  onSelect: (symbol: string) => void
}

function pct(v: number | null, digits = 1): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}

function pctColor(v: number | null): string {
  if (v == null) return T.muted
  return v >= 0 ? T.up : T.down
}

// Fear & Greed color matches CNN's read (fear red, greed green) — the (i)
// explains why a contrarian treats the ends as the interesting part.
function fgColor(score: number): string {
  if (score <= 45) return T.down
  if (score < 55) return T.muted
  return T.up
}

const CELL: React.CSSProperties = {
  padding: '4px 10px',
  borderBottom: `1px solid ${T.grid}`,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap'
}

const HEAD: React.CSSProperties = {
  textAlign: 'left',
  color: T.muted,
  fontWeight: 600,
  padding: '4px 10px',
  borderBottom: `1px solid ${T.border}`,
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  whiteSpace: 'nowrap'
}

function SymCell({ s, onSelect }: { s: DiscoverySymbolStat; onSelect: (sym: string) => void }): React.JSX.Element {
  return (
    <td style={{ ...CELL, cursor: 'pointer' }} title={`${s.name} — click to open in the chart + engines`} onClick={() => onSelect(s.symbol)}>
      <span style={{ color: T.accent, fontWeight: 600 }}>{s.symbol}</span>{' '}
      <span style={{ color: T.faint, fontSize: 10.5 }}>{s.name.length > 22 ? s.name.slice(0, 21) + '…' : s.name}</span>
    </td>
  )
}

function Panel({
  title,
  tip,
  children,
  minWidth = 320
}: {
  title: string
  tip: React.ReactNode
  children: React.ReactNode
  minWidth?: number
}): React.JSX.Element {
  return (
    <div style={{ minWidth, flex: '1 1 auto', border: `1px solid ${T.border}`, borderRadius: 8, background: T.panel, overflow: 'hidden' }}>
      <div
        style={{
          padding: '7px 12px',
          borderBottom: `1px solid ${T.border}`,
          color: T.text,
          fontSize: 12,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}
      >
        {title}
        <InfoTip width={340}>{tip}</InfoTip>
      </div>
      <div style={{ overflowX: 'auto' }}>{children}</div>
    </div>
  )
}

function StatTable({
  rows,
  onSelect,
  showMom = true
}: {
  rows: DiscoverySymbolStat[]
  onSelect: (sym: string) => void
  showMom?: boolean
}): React.JSX.Element {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
      <thead>
        <tr>
          <th style={HEAD}>Symbol</th>
          <th style={HEAD}>1M</th>
          <th style={HEAD}>3M</th>
          <th style={HEAD}>3M vs SPY</th>
          {showMom && <th style={HEAD}>Mom %ile</th>}
          <th style={HEAD}>vs 52w hi</th>
          <th style={HEAD}>200d</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.symbol}>
            <SymCell s={s} onSelect={onSelect} />
            <td style={{ ...CELL, color: pctColor(s.ret1m) }}>{pct(s.ret1m)}</td>
            <td style={{ ...CELL, color: pctColor(s.ret3m) }}>{pct(s.ret3m)}</td>
            <td style={{ ...CELL, color: pctColor(s.rel3m) }}>{pct(s.rel3m)}</td>
            {showMom && (
              <td style={{ ...CELL, color: s.momPct != null && s.momPct >= 70 ? T.up : T.text }}>
                {s.momPct != null ? s.momPct.toFixed(0) : '—'}
              </td>
            )}
            <td style={{ ...CELL, color: T.muted }}>{pct(s.from52wHigh)}</td>
            <td style={{ ...CELL, color: s.above200d == null ? T.muted : s.above200d ? T.up : T.down }}>
              {s.above200d == null ? '—' : s.above200d ? 'above' : 'below'}
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td style={CELL} colSpan={showMom ? 7 : 6}>
              <span style={{ color: T.muted }}>No history yet — backfill in progress.</span>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

export default function DiscoveryView({ onSelect }: Props): React.JSX.Element {
  const [report, setReport] = useState<DiscoveryReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [macro, setMacro] = useState<MacroReport | null>(null)
  const [fg, setFg] = useState<FearGreed | null>(null)
  const [qarp, setQarp] = useState<QarpLeaderboard | null>(null)
  const [brief, setBrief] = useState<MarketBrief | null>(null)
  const [briefLoading, setBriefLoading] = useState(false)
  // Refs mirror state for the poll interval — reading state there would
  // capture the mount-time values.
  const reportRef = useRef<DiscoveryReport | null>(null)
  const errorRef = useRef<string | null>(null)
  reportRef.current = report
  errorRef.current = error

  // Side panels re-fetch on every load: keys added in Settings mid-session
  // must light up macro/brief without a remount (fetches are cached
  // main-side — 12h TTLs — so this is cheap).
  const loadPanels = (): void => {
    window.api.macro().then(setMacro).catch(() => {})
    window.api.fearGreed().then(setFg).catch(() => {})
    window.api.qarpLeaderboard().then(setQarp).catch(() => {})
    // Keep a good brief on screen if a later fetch comes back unavailable.
    window.api
      .marketBrief()
      .then((b) => setBrief((prev) => (b.available || !prev?.available ? b : prev)))
      .catch(() => {})
  }

  const load = (force: boolean): void => {
    setLoading(true)
    loadPanels()
    window.api
      .discovery(force)
      .then((r) => {
        setReport(r)
        setError(null)
      })
      // A failed refresh must NOT blank a perfectly good on-screen report —
      // the error renders as a banner and the report stays.
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load(false)
    // Poll while the first backfill runs (panels fill in as bars land), and
    // retry when the initial load itself failed — otherwise one transient
    // error would strand the view until a remount.
    const t = setInterval(() => {
      if (reportRef.current?.refreshing || (!reportRef.current && errorRef.current)) load(true)
    }, 20_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const regenBrief = (): void => {
    setBriefLoading(true)
    window.api
      .marketBrief(true)
      // A failed regenerate must not replace a good brief with an error
      // (which would also remove the only regenerate button).
      .then((b) => setBrief((prev) => (b.available || !prev?.available ? b : prev)))
      .catch(() => {})
      .finally(() => setBriefLoading(false))
  }

  if (!report) {
    if (error)
      return (
        <div style={{ padding: 20, fontSize: 12.5 }}>
          <div style={{ color: T.down, marginBottom: 10 }}>Discovery failed: {error}</div>
          <button
            onClick={() => load(true)}
            style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, padding: '5px 14px', fontSize: 12, cursor: 'pointer' }}
          >
            ⟳ Retry
          </button>
        </div>
      )
    return <div style={{ padding: 20, color: T.muted, fontSize: 12.5 }}>Scanning the tracked universe…</div>
  }

  return (
    <div style={{ padding: '12px 16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Market Discovery</span>
        {error && <span style={{ fontSize: 11, color: T.warn }}>last refresh failed ({error}) — showing previous data</span>}
        <span style={{ fontSize: 11.5, color: T.muted }}>
          SPY 1M <span style={{ color: pctColor(report.spyRet.r1m) }}>{pct(report.spyRet.r1m)}</span> · 3M{' '}
          <span style={{ color: pctColor(report.spyRet.r3m) }}>{pct(report.spyRet.r3m)}</span> · 6M{' '}
          <span style={{ color: pctColor(report.spyRet.r6m) }}>{pct(report.spyRet.r6m)}</span>
        </span>
        <span style={{ fontSize: 11, color: T.faint }}>
          {report.withHistory}/{report.universeSize} tracked · momentum ranked across {report.poolSize} symbols
        </span>
        {report.refreshing && (
          <span style={{ fontSize: 11, color: T.warn }}>backfilling price history — panels fill in as it lands…</span>
        )}
        <button
          onClick={() => load(true)}
          disabled={loading}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            color: T.text,
            padding: '4px 12px',
            fontSize: 11.5,
            cursor: 'pointer'
          }}
        >
          {loading ? 'Refreshing…' : '⟳ Refresh'}
        </button>
        <InfoTip width={380}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>What this page is (and isn't)</div>
          <div style={{ color: T.muted }}>
            A ranked view over ~{report.universeSize} tracked ETFs and stocks (sectors, broad baskets, tech + quantum,
            gold/currency) computed from locally cached daily bars — zero API cost after backfill. It widens your
            horizon; it does NOT recommend. Click any symbol to load it and let the Buffett / Signals / Options engines
            judge it.
          </div>
        </InfoTip>
      </div>

      {(brief?.available || brief?.message) && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, background: T.panel, padding: '9px 12px', marginBottom: 12, maxWidth: 1330 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: brief.available ? 6 : 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>✦ AI market brief</span>
            {brief.available && (
              <span style={{ fontSize: 10.5, color: T.faint }}>
                generated {brief.generatedAt.slice(0, 16).replace('T', ' ')} UTC · cached 12h
              </span>
            )}
            {brief.available && (
              <button
                onClick={regenBrief}
                disabled={briefLoading}
                style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 5, color: T.muted, padding: '1px 8px', fontSize: 10.5, cursor: 'pointer' }}
              >
                {briefLoading ? '…' : '⟳ regenerate'}
              </button>
            )}
            <InfoTip width={330}>
              <span>
                Claude turns THIS page's computed stats (plus FRED macro when available) into two paragraphs. It sees
                only the numbers shown here — an AI wording of the dashboard, not extra information.
              </span>
            </InfoTip>
          </div>
          {brief.available ? (
            <div style={{ fontSize: 12, color: T.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{brief.text}</div>
          ) : (
            <span style={{ fontSize: 11.5, color: T.faint, marginLeft: 8 }}>{brief.message}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {fg && (fg.available || fg.message) && (
          <Panel
            title="Fear & Greed (CNN)"
            tip={
              <span>
                CNN&apos;s composite of seven market internals, 0 (extreme fear) to 100 (extreme greed). {fg.note} Pulled
                from CNN&apos;s unofficial endpoint and cached daily — if it breaks, the panel dims but nothing else does.
              </span>
            }
            minWidth={300}
          >
            {fg.available && fg.score != null ? (
              <div style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 26, fontWeight: 800, color: fgColor(fg.score), fontVariantNumeric: 'tabular-nums' }}>
                    {fg.score.toFixed(0)}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: fgColor(fg.score), textTransform: 'capitalize' }}>
                    {fg.rating}
                  </span>
                  <span style={{ fontSize: 10.5, color: T.faint, marginLeft: 'auto' }}>{fg.asOf}</span>
                </div>
                {/* 0–100 gauge */}
                <div style={{ position: 'relative', height: 8, background: T.panelHover, borderRadius: 4, marginBottom: 8 }}>
                  <div style={{ position: 'absolute', left: '25%', top: -1, bottom: -1, width: 1, background: T.faint }} />
                  <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: T.faint }} />
                  <div style={{ position: 'absolute', left: '75%', top: -1, bottom: -1, width: 1, background: T.faint }} />
                  <div
                    style={{
                      position: 'absolute',
                      left: `calc(${fg.score}% - 4px)`,
                      top: -3,
                      width: 8,
                      height: 14,
                      borderRadius: 3,
                      background: fgColor(fg.score)
                    }}
                  />
                </div>
                <div style={{ fontSize: 10.5, color: T.muted, marginBottom: 8 }}>
                  {fg.weekAgo != null && <span>1w ago {fg.weekAgo.toFixed(0)} · </span>}
                  {fg.monthAgo != null && <span>1m ago {fg.monthAgo.toFixed(0)} · </span>}
                  {fg.yearAgo != null && <span>1y ago {fg.yearAgo.toFixed(0)}</span>}
                </div>
                {fg.components.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
                    <tbody>
                      {fg.components.map((c) => (
                        <tr key={c.key}>
                          <td style={{ padding: '2px 0', color: T.muted }}>{c.label}</td>
                          <td style={{ padding: '2px 0 2px 8px', color: c.score != null ? fgColor(c.score) : T.faint, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {c.score != null ? c.score.toFixed(0) : '—'} {c.rating}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {fg.message && <div style={{ fontSize: 10.5, color: T.warn, marginTop: 6 }}>{fg.message}</div>}
                <div style={{ fontSize: 10, color: T.faint, marginTop: 6 }}>
                  Extreme readings (≤25 / ≥75) are recorded and graded in the Journal&apos;s track record.
                </div>
              </div>
            ) : (
              <div style={{ padding: '8px 12px', color: T.faint, fontSize: 11.5 }}>{fg.message}</div>
            )}
          </Panel>
        )}

        {macro && (macro.available || macro.message) && (
          <Panel
            title="Macro context (FRED)"
            tip={
              <span>
                Rates, inflation, and the dollar — the backdrop that moves gold/currency positions more than equity
                factors do. Real (after-inflation) yield ≈ 10y minus CPI YoY. Updated twice daily from the St. Louis
                Fed; series lag their sources by a day or two.
              </span>
            }
            minWidth={330}
          >
            {macro.available ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <tbody>
                  {macro.series.map((s) => (
                    <tr key={s.id}>
                      <td style={{ ...CELL, color: T.muted }}>{s.label}</td>
                      <td style={{ ...CELL, color: T.text, fontWeight: 600 }}>
                        {s.latest}
                        {s.units}
                      </td>
                      <td style={{ ...CELL, color: T.faint }}>
                        {s.yearAgo != null ? `1y ago ${s.yearAgo}${s.units}` : ''} · {s.date}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '8px 12px', color: T.faint, fontSize: 11.5 }}>{macro.message}</div>
            )}
          </Panel>
        )}

        {qarp && (
          <Panel
            title="QARP leaderboard (quality at a reasonable price)"
            tip={
              <span>
                Top symbols by the Buffett engine's QARP composite (65% quality percentile, 35% value percentile) among
                the {qarp.scoredCount} names with crawled fundamentals. ETFs never appear (no single-company
                fundamentals). Percentiles are UNIVERSE-relative — a rank, not a valuation verdict.
              </span>
            }
            minWidth={330}
          >
            {qarp.available ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th style={HEAD}>Symbol</th>
                    <th style={HEAD}>QARP</th>
                    <th style={HEAD}>Quality</th>
                    <th style={HEAD}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {qarp.rows.map((r) => (
                    <tr key={r.symbol}>
                      <td style={{ ...CELL, cursor: 'pointer' }} onClick={() => onSelect(r.symbol)}>
                        <span style={{ color: T.accent, fontWeight: 600 }}>{r.symbol}</span>
                        {r.dataSource === 'fallback' && <span style={{ color: T.warn, fontSize: 9.5 }}> ᶠᵇ</span>}
                      </td>
                      <td style={{ ...CELL, color: (r.qarp ?? 0) >= 70 ? T.up : T.text, fontWeight: 600 }}>{r.qarp?.toFixed(0) ?? '—'}</td>
                      <td style={{ ...CELL, color: T.muted }}>{r.quality?.toFixed(0) ?? '—'}</td>
                      <td style={{ ...CELL, color: T.muted }}>{r.value?.toFixed(0) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '8px 12px', color: T.faint, fontSize: 11.5 }}>{qarp.message}</div>
            )}
          </Panel>
        )}

        <Panel
          title="Sector rotation (SPDRs, sorted by 3M vs SPY)"
          tip={
            <span>
              Relative strength of the 11 sector ETFs against SPY. Leaders/laggards describe where money HAS rotated —
              academic momentum suggests persistence over 3–12 months, but it is a weak statistical tilt, not a rule.
            </span>
          }
          minWidth={430}
        >
          <StatTable rows={report.sectors} onSelect={onSelect} showMom={false} />
        </Panel>

        <Panel
          title="Momentum leaders (12-1, cross-sectional)"
          tip={
            <span>
              Top tracked symbols by 12-1 momentum percentile — the same signal family the Signals tab uses (skip the
              last month to avoid short-term reversal; Hou/Xue/Zhang 2020 find momentum among the best-replicating
              anomalies). Percentile is within the ~{report.poolSize} tracked symbols, not the market.
            </span>
          }
          minWidth={430}
        >
          <StatTable rows={report.momentumLeaders} onSelect={onSelect} />
        </Panel>

        <Panel
          title="1-month movers"
          tip={
            <span>
              Biggest 21-trading-day moves in the tracked universe, both directions. Big short-term moves REVERSE more
              often than they persist (short-term reversal effect) — context, not chase candidates.
            </span>
          }
          minWidth={430}
        >
          <div style={{ display: 'flex', gap: 0 }}>
            <div style={{ flex: 1 }}>
              <StatTable rows={report.moversUp} onSelect={onSelect} showMom={false} />
            </div>
            <div style={{ flex: 1, borderLeft: `1px solid ${T.grid}` }}>
              <StatTable rows={report.moversDown} onSelect={onSelect} showMom={false} />
            </div>
          </div>
        </Panel>

        <Panel
          title="Focus: Tech (incl. semis/software ETFs)"
          tip={<span>Your stated core lane, sorted by momentum percentile. Click into the Buffett tab for quality/valuation before anything else.</span>}
          minWidth={430}
        >
          <StatTable rows={report.focus.tech} onSelect={onSelect} />
        </Panel>

        <Panel
          title="Focus: Quantum"
          tip={
            <span>
              Early-stage, pre-profit companies — fundamentals engines will read mostly &quot;unknown&quot; here, and
              that itself is information. Extreme volatility; treat as speculative satellites, not core.
            </span>
          }
          minWidth={430}
        >
          <StatTable rows={report.focus.quantum} onSelect={onSelect} />
        </Panel>

        <Panel
          title="Focus: Broad baskets"
          tip={<span>Index exposure — the boring backbone. Relative strength between US large/small and international says more about regime than any single stock.</span>}
          minWidth={430}
        >
          <StatTable rows={report.focus.broad} onSelect={onSelect} />
        </Panel>

        <Panel
          title="Focus: Gold / currency"
          tip={
            <span>
              Gold, silver, miners, the dollar index, euro/yen trusts, and bitcoin. These respond to real rates and
              dollar moves more than to equity factors — momentum percentiles here compare apples to oranges; lean on
              the return columns.
            </span>
          }
          minWidth={430}
        >
          <StatTable rows={report.focus.goldfx} onSelect={onSelect} />
        </Panel>
      </div>

      <div style={{ marginTop: 12, color: T.faint, fontSize: 10.5, lineHeight: 1.55, maxWidth: 980 }}>
        {report.caveats.map((c, i) => (
          <div key={i}>• {c}</div>
        ))}
      </div>
    </div>
  )
}
