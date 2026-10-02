import { useEffect, useState } from 'react'
import type { PortfolioPosition, PortfolioReport } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T, fmtPrice } from '../theme'

// ⌂ Portfolio: the user's ACTUAL holdings, manually entered (no broker read
// API exists for Fidelity/Robinhood individuals). Live-priced table with
// weights, concentration flags, and each engine's read per holding — the
// "is MY portfolio okay?" view the per-symbol tabs can't be.

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: '12px 16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', fontSize: 12.5 },
  tile: { minWidth: 150 },
  tileLabel: { color: T.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  tileValue: { fontSize: 18, fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums' },
  th: {
    textAlign: 'left',
    color: T.muted,
    fontWeight: 600,
    padding: '5px 8px',
    borderBottom: `1px solid ${T.border}`,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    whiteSpace: 'nowrap'
  },
  td: { padding: '5px 8px', borderBottom: `1px solid ${T.grid}`, color: T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  input: {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: 5,
    color: T.text,
    padding: '4px 8px',
    fontSize: 12,
    width: 90
  },
  btn: {
    background: T.accent,
    border: 'none',
    borderRadius: 6,
    color: 'white',
    padding: '5px 14px',
    fontSize: 12,
    cursor: 'pointer'
  }
}

function pctColor(v: number | null): string {
  if (v == null) return T.muted
  return v >= 0 ? T.up : T.down
}

function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}

function fmtMoney(v: number | null): string {
  if (v == null) return '—'
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function stanceColor(a: PortfolioPosition['stance']): string {
  return a === 'buy' ? T.up : a === 'sell' ? T.down : T.muted
}

// Click-to-edit numeric cell: commits on Enter/blur, reverts on Escape.
function EditCell({ value, onCommit }: { value: number | null; onCommit: (v: number | null) => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  if (!editing) {
    return (
      <span
        style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
        title="Click to edit"
        onClick={() => {
          setText(value != null ? String(value) : '')
          setEditing(true)
        }}
      >
        {value != null ? String(value) : '—'}
      </span>
    )
  }
  const commit = (): void => {
    setEditing(false)
    const n = text.trim() === '' ? null : Number(text)
    if (n !== value && (n == null || Number.isFinite(n))) onCommit(n)
  }
  return (
    <input
      style={{ ...S.input, width: 70 }}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

interface Props {
  active: boolean
  onSelect: (symbol: string) => void
}

export default function PortfolioView({ active, onSelect }: Props): React.JSX.Element {
  const [report, setReport] = useState<PortfolioReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ symbol: '', qty: '', cost: '', account: 'roth' })

  const load = (): void => {
    window.api
      .portfolioReport()
      .then((r) => {
        setReport(r)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  // Keep-mounted view: refetch on every activation, not just first mount.
  useEffect(() => {
    if (active) load()
  }, [active])

  const run = (p: Promise<PortfolioReport>): void => {
    setBusy(true)
    p.then((r) => {
      setReport(r)
      setError(null)
    })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const add = (): void => {
    const qty = Number(form.qty)
    if (!form.symbol.trim() || !Number.isFinite(qty) || qty <= 0) {
      setError('Add needs at least a symbol and a positive share count.')
      return
    }
    run(
      window.api.portfolioAdd({
        symbol: form.symbol.trim().toUpperCase(),
        qty,
        costBasis: form.cost.trim() === '' ? null : Number(form.cost),
        account: form.account.trim()
      })
    )
    setForm({ symbol: '', qty: '', cost: '', account: form.account })
  }

  return (
    <div style={S.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Portfolio</span>
        <InfoTip width={380}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Manual by necessity</div>
          <div style={{ color: T.muted }}>
            Fidelity and Robinhood expose no read API for individuals, so holdings are entered by hand — a snapshot,
            not a sync. What the app adds: live pricing, weights, concentration flags, and each engine&apos;s read
            (QARP / tilt / stance) beside every holding. Click a symbol to open it in the chart and tabs.
          </div>
        </InfoTip>
        {error && <span style={{ color: T.down, fontSize: 11.5 }}>{error}</span>}
        {busy && <span style={{ color: T.muted, fontSize: 11.5 }}>saving…</span>}
      </div>

      {report?.available && (
        <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={S.tile}>
            <div style={S.tileLabel}>Total value</div>
            <div style={S.tileValue}>{fmtMoney(report.totalValue)}</div>
          </div>
          <div style={S.tile}>
            <div style={S.tileLabel}>Day P&L</div>
            <div style={{ ...S.tileValue, color: pctColor(report.dayGainPct) }}>
              {report.dayGainAbs != null ? `${fmtMoney(report.dayGainAbs)} (${fmtPct(report.dayGainPct)})` : '—'}
            </div>
          </div>
          <div style={S.tile}>
            <div style={S.tileLabel}>Total P&L (vs cost)</div>
            <div style={{ ...S.tileValue, color: pctColor(report.totalGainPct) }}>
              {report.totalGainAbs != null ? `${fmtMoney(report.totalGainAbs)} (${fmtPct(report.totalGainPct)})` : '—'}
            </div>
          </div>
          <div style={S.tile}>
            <div style={S.tileLabel}>Positions</div>
            <div style={S.tileValue}>{report.positions.length}</div>
          </div>
        </div>
      )}

      {report?.available && report.warnings.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {report.warnings.map((w, i) => (
            <div key={i} style={{ color: T.warn, fontSize: 11.5, lineHeight: 1.5 }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      )}

      {report && !report.available && <div style={{ color: T.muted, marginBottom: 12, maxWidth: 640, lineHeight: 1.6 }}>{report.message}</div>}
      {!report && !error && <div style={{ color: T.muted }}>Loading portfolio…</div>}

      {report?.available && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, maxWidth: 1250 }}>
          <thead>
            <tr>
              <th style={S.th}>Symbol</th>
              <th style={S.th}>Account</th>
              <th style={S.th}>Shares</th>
              <th style={S.th}>Avg cost</th>
              <th style={S.th}>Price</th>
              <th style={S.th}>Day</th>
              <th style={S.th}>Gain</th>
              <th style={S.th}>Value</th>
              <th style={S.th}>Weight</th>
              <th style={S.th}>QARP</th>
              <th style={S.th}>Tilt</th>
              <th style={S.th}>Stance</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {report.positions.map((p) => (
              <tr key={p.id}>
                <td
                  style={{ ...S.td, cursor: 'pointer' }}
                  title={`Open ${p.symbol} in the chart + engines${p.sector ? ` · ${p.sector}` : ''}`}
                  onClick={() => onSelect(p.symbol)}
                >
                  <span style={{ color: T.accent, fontWeight: 600 }}>{p.symbol}</span>
                  {p.sector && <span style={{ color: T.faint, fontSize: 10, marginLeft: 6 }}>{p.sector}</span>}
                </td>
                <td style={{ ...S.td, color: T.muted }}>{p.account || '—'}</td>
                <td style={S.td}>
                  <EditCell value={p.qty} onCommit={(v) => v != null && run(window.api.portfolioUpdate(p.id, { qty: v }))} />
                </td>
                <td style={S.td}>
                  <EditCell value={p.costBasis} onCommit={(v) => run(window.api.portfolioUpdate(p.id, { costBasis: v }))} />
                </td>
                <td style={S.td}>{fmtPrice(p.price)}</td>
                <td style={{ ...S.td, color: pctColor(p.dayPct) }}>{fmtPct(p.dayPct)}</td>
                <td style={{ ...S.td, color: pctColor(p.gainPct) }}>
                  {p.gainPct != null ? `${fmtPct(p.gainPct)}${p.gainAbs != null ? ` (${fmtMoney(p.gainAbs)})` : ''}` : '—'}
                </td>
                <td style={S.td}>{fmtMoney(p.marketValue)}</td>
                <td style={{ ...S.td, color: p.weight != null && p.weight > 0.25 ? T.warn : T.text }}>
                  {p.weight != null ? (p.weight * 100).toFixed(1) + '%' : '—'}
                </td>
                <td style={{ ...S.td, color: p.qarp != null ? (p.qarp >= 60 ? T.up : p.qarp >= 40 ? T.warn : T.down) : T.muted }}>
                  {p.qarp != null ? p.qarp.toFixed(0) : '—'}
                </td>
                <td style={{ ...S.td, color: p.tilt != null && Math.abs(p.tilt) >= 10 ? (p.tilt > 0 ? T.up : T.down) : T.muted }}>
                  {p.tilt != null ? `${p.tilt >= 0 ? '+' : ''}${p.tilt.toFixed(0)}` : '—'}
                </td>
                <td style={{ ...S.td, color: stanceColor(p.stance), fontWeight: 600 }}>{p.stance ? p.stance.toUpperCase() : '—'}</td>
                <td style={S.td}>
                  <span
                    style={{ color: T.faint, cursor: 'pointer' }}
                    title="Remove this position"
                    onClick={() => run(window.api.portfolioRemove(p.id))}
                  >
                    ×
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
        <span style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Add position</span>
        <input
          style={{ ...S.input, width: 80 }}
          placeholder="Symbol"
          value={form.symbol}
          onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))}
        />
        <input style={S.input} placeholder="Shares" value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} />
        <input
          style={S.input}
          placeholder="Avg cost (opt.)"
          value={form.cost}
          onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
        />
        <input
          style={S.input}
          placeholder="Account"
          value={form.account}
          onChange={(e) => setForm((f) => ({ ...f, account: e.target.value }))}
        />
        <button style={S.btn} disabled={busy} onClick={add}>
          Add
        </button>
        <span style={{ color: T.faint, fontSize: 10.5 }}>fractional shares fine · cost basis optional (gains show n/a without it)</span>
      </div>

      {report && (
        <div style={{ marginTop: 12, color: T.faint, fontSize: 10.5, lineHeight: 1.5, maxWidth: 900 }}>
          {report.disclosures.map((d, i) => (
            <div key={i}>• {d}</div>
          ))}
        </div>
      )}
    </div>
  )
}
