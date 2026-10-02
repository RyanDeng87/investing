import { useEffect, useState } from 'react'
import type { AlertKind, AlertRule, JournalEntry, Retrospective, TrackRecord } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T } from '../theme'

// Trade journal + alerts. The journal's design bias: thesis BEFORE, outcome
// AFTER — reviewing the gap between them is the highest-value habit in
// retail investing. Alerts are one-shot thresholds (price via quote polls,
// IV Rank via the daily collector) that fire a Windows notification.

const ALERT_KINDS: { key: AlertKind; label: string }[] = [
  { key: 'price_above', label: 'price above' },
  { key: 'price_below', label: 'price below' },
  { key: 'iv_rank_above', label: 'IV Rank above' },
  { key: 'iv_rank_below', label: 'IV Rank below' }
]

const inputStyle: React.CSSProperties = {
  background: T.bg,
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  color: T.text,
  padding: '5px 8px',
  fontSize: 12
}

export default function JournalView({ onSelect, active = true }: { onSelect?: (symbol: string) => void; active?: boolean }): React.JSX.Element {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [alerts, setAlerts] = useState<AlertRule[]>([])
  const [err, setErr] = useState<string | null>(null)
  // add-entry form ('sv' locale = ISO date, in LOCAL time — toISOString is
  // UTC and would date an evening entry tomorrow)
  const [date, setDate] = useState(new Date().toLocaleDateString('sv'))
  const [symbol, setSymbol] = useState('')
  const [side, setSide] = useState<'buy' | 'sell' | 'note'>('buy')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [account, setAccount] = useState('roth')
  const [thesis, setThesis] = useState('')
  // outcome editing
  const [editing, setEditing] = useState<number | null>(null)
  const [outcomeDraft, setOutcomeDraft] = useState('')
  // alert form
  const [aSymbol, setASymbol] = useState('')
  const [aKind, setAKind] = useState<AlertKind>('price_above')
  const [aThreshold, setAThreshold] = useState('')
  // hypothesis review + track record
  const [reviewing, setReviewing] = useState(false)
  const [record, setRecord] = useState<TrackRecord | null>(null)
  const [retro, setRetro] = useState<Retrospective | null>(null)
  const [retroLoading, setRetroLoading] = useState(false)

  // Refetch every time the view becomes ACTIVE (the component stays mounted
  // behind display:none) — copilot-logged hypotheses and newly-due states
  // must appear without an app restart.
  useEffect(() => {
    if (!active) return
    window.api.journalList().then(setEntries).catch(() => {})
    window.api.alertsList().then(setAlerts).catch(() => {})
    window.api
      .trackRecord()
      .then(setRecord)
      .catch(() =>
        setRecord({ available: false, asOf: '', kinds: [], disclosures: [], message: 'Track record failed to load — switch views and come back to retry.' })
      )
  }, [active])

  const today = new Date().toLocaleDateString('sv')
  const dueCount = entries.filter((e) => e.status === 'open' && e.horizonDate != null && e.horizonDate <= today).length

  const reviewDue = (): void => {
    if (reviewing) return
    setReviewing(true)
    window.api
      .reviewDueHypotheses()
      .then((r) => setEntries(r.entries))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setReviewing(false))
  }

  const loadRetro = (force: boolean): void => {
    setRetroLoading(true)
    window.api
      .aiRetrospective(force)
      .then((r) => setRetro((prev) => (r.available || !prev?.available ? r : prev)))
      .catch(() => {})
      .finally(() => setRetroLoading(false))
  }

  const addEntry = (): void => {
    setErr(null)
    window.api
      .journalAdd({
        date,
        symbol: symbol.trim().toUpperCase(),
        side,
        qty: qty ? Number(qty) : null,
        price: price ? Number(price) : null,
        account: account.trim(),
        thesis: thesis.trim(),
        outcome: ''
      })
      .then((rows) => {
        setEntries(rows)
        setSymbol('')
        setQty('')
        setPrice('')
        setThesis('')
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message.replace(/^.*Error:\s*/s, '') : String(e)))
  }

  const saveOutcome = (id: number): void => {
    window.api
      .journalUpdate(id, { outcome: outcomeDraft })
      .then((rows) => {
        setEntries(rows)
        setEditing(null)
      })
      .catch(() => {})
  }

  const addAlert = (): void => {
    setErr(null)
    window.api
      .alertsAdd({ symbol: aSymbol.trim().toUpperCase(), kind: aKind, threshold: Number(aThreshold) })
      .then((rows) => {
        setAlerts(rows)
        setASymbol('')
        setAThreshold('')
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message.replace(/^.*Error:\s*/s, '') : String(e)))
  }

  const sectionTitle: React.CSSProperties = { color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }
  const th: React.CSSProperties = { color: T.muted, fontWeight: 400, textAlign: 'left', padding: '2px 14px 4px 0', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { color: T.text, padding: '4px 14px 4px 0', fontSize: 11.5, verticalAlign: 'top' }

  return (
    <div data-scroll-container style={{ padding: '12px 16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Journal</span>
        <span style={{ fontSize: 11.5, color: T.muted }}>thesis before, outcome after — the review habit</span>
        <InfoTip width={380}>
          <span>
            Write WHY before you know how it turns out; come back and fill in the outcome. The gap between the two is
            where the learning is — hindsight rewrites memory unless it's written down. ✦ entries are HYPOTHESES the
            copilot logged (falsifiable predictions with a due date) — when due, the review scores them against real
            prices, with an AI verdict on why if a key is set. Everything is local (SQLite), never uploaded.
          </span>
        </InfoTip>
        {dueCount > 0 && (
          <button
            onClick={reviewDue}
            disabled={reviewing}
            style={{
              background: reviewing ? 'transparent' : T.warn,
              border: `1px solid ${T.warn}`,
              borderRadius: 6,
              color: reviewing ? T.muted : '#1a1a1a',
              padding: '4px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: reviewing ? 'default' : 'pointer'
            }}
          >
            {reviewing ? 'Scoring against real prices…' : `⚖ Review ${dueCount} due hypothes${dueCount === 1 ? 'is' : 'es'}`}
          </button>
        )}
      </div>

      {err && <div style={{ color: T.down, fontSize: 12, marginBottom: 8 }}>{err}</div>}

      <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, maxWidth: 1100 }}>
        <div style={sectionTitle}>New entry</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="SPY" style={{ ...inputStyle, width: 70 }} spellCheck={false} />
          <select value={side} onChange={(e) => setSide(e.target.value as typeof side)} style={inputStyle}>
            <option value="buy">buy</option>
            <option value="sell">sell</option>
            <option value="note">note</option>
          </select>
          <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" style={{ ...inputStyle, width: 70 }} />
          <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price" style={{ ...inputStyle, width: 84 }} />
          <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="account" style={{ ...inputStyle, width: 90 }} spellCheck={false} />
        </div>
        <textarea
          value={thesis}
          onChange={(e) => setThesis(e.target.value)}
          placeholder="Thesis — why this, why now, what would prove it wrong?"
          rows={2}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <button
          onClick={addEntry}
          disabled={!symbol.trim() || !thesis.trim()}
          style={{
            marginTop: 8,
            background: symbol.trim() && thesis.trim() ? T.accent : 'transparent',
            border: `1px solid ${T.accent}`,
            borderRadius: 6,
            color: symbol.trim() && thesis.trim() ? '#fff' : T.muted,
            padding: '6px 16px',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Add entry
        </button>
      </div>

      {entries.length > 0 && (
        <table style={{ borderCollapse: 'collapse', marginBottom: 20, maxWidth: 1100, width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Symbol</th>
              <th style={th}>Action</th>
              <th style={th}>Acct</th>
              <th style={{ ...th, width: '38%' }}>Thesis</th>
              <th style={{ ...th, width: '32%' }}>Outcome</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} style={{ borderTop: `1px solid ${T.grid}` }}>
                <td style={{ ...td, color: T.muted, whiteSpace: 'nowrap' }}>{e.date}</td>
                <td style={{ ...td, color: T.accent, cursor: onSelect ? 'pointer' : 'default' }} onClick={() => onSelect?.(e.symbol)}>
                  {e.author === 'copilot' ? '✦ ' : ''}
                  {e.symbol}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {e.status !== '' ? (
                    <span
                      style={{
                        color:
                          e.status === 'resolved' ? T.muted : e.horizonDate != null && e.horizonDate <= today ? T.warn : T.accent,
                        fontSize: 10.5,
                        border: `1px solid ${T.border}`,
                        borderRadius: 8,
                        padding: '1px 7px'
                      }}
                    >
                      {e.status === 'resolved' ? 'resolved' : e.horizonDate != null && e.horizonDate <= today ? 'due' : `open · ${e.horizonDate ?? ''}`}
                    </span>
                  ) : (
                    <span style={{ color: e.side === 'buy' ? T.up : e.side === 'sell' ? T.down : T.muted }}>
                      {e.side}
                      {e.qty != null ? ` ${e.qty}` : ''}
                      {e.price != null ? ` @${e.price}` : ''}
                    </span>
                  )}
                </td>
                <td style={{ ...td, color: T.muted }}>{e.account}</td>
                <td style={{ ...td, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{e.thesis}</td>
                <td style={{ ...td, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
                  {editing === e.id ? (
                    <div>
                      <textarea
                        value={outcomeDraft}
                        onChange={(ev) => setOutcomeDraft(ev.target.value)}
                        rows={3}
                        autoFocus
                        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
                      />
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button onClick={() => saveOutcome(e.id)} style={{ background: T.accent, border: 'none', borderRadius: 5, color: '#fff', padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}>
                          save
                        </button>
                        <button onClick={() => setEditing(null)} style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 5, color: T.muted, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
                          cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <span
                      onClick={() => {
                        setEditing(e.id)
                        setOutcomeDraft(e.outcome)
                      }}
                      style={{ cursor: 'pointer', color: e.outcome ? T.text : T.faint, borderBottom: `1px dotted ${T.faint}` }}
                    >
                      {e.outcome || 'add outcome…'}
                    </span>
                  )}
                </td>
                <td style={td}>
                  <button
                    onClick={() => void window.api.journalRemove(e.id).then(setEntries)}
                    title="delete entry"
                    style={{ background: 'transparent', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 13 }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Alerts</span>
          <span style={{ fontSize: 11.5, color: T.muted }}>one-shot thresholds → Windows notification, then they disarm</span>
          <InfoTip width={340}>
            <span>
              Price alerts check on the app's quote polls (~minutely while open) and once per daily collector run; IV
              Rank alerts check after each collector run. A fired alert deactivates itself — re-add to re-arm. IV Rank
              needs at least 5 days of collected IV history.
            </span>
          </InfoTip>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <input type="text" value={aSymbol} onChange={(e) => setASymbol(e.target.value.toUpperCase())} placeholder="NVDA" style={{ ...inputStyle, width: 70 }} spellCheck={false} />
          <select value={aKind} onChange={(e) => setAKind(e.target.value as AlertKind)} style={inputStyle}>
            {ALERT_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          <input type="number" value={aThreshold} onChange={(e) => setAThreshold(e.target.value)} placeholder={aKind.startsWith('iv') ? '0-100' : '$'} style={{ ...inputStyle, width: 90 }} />
          <button
            onClick={addAlert}
            disabled={!aSymbol.trim() || !aThreshold}
            style={{ background: 'transparent', border: `1px solid ${T.accent}`, borderRadius: 6, color: aSymbol.trim() && aThreshold ? T.accent : T.faint, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            + Add alert
          </button>
        </div>
        {alerts.length === 0 && <div style={{ color: T.faint, fontSize: 12 }}>No alerts yet.</div>}
        {alerts.length > 0 && (
          <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...td, color: T.text }}>{a.symbol}</td>
                  <td style={{ ...td, color: T.muted }}>
                    {ALERT_KINDS.find((k) => k.key === a.kind)?.label} {a.threshold}
                  </td>
                  <td style={{ ...td, color: a.active ? T.up : T.warn }}>
                    {a.active ? `armed${a.lastValue != null ? ` · last ${a.lastValue.toFixed(2)}` : ''}` : `fired ${a.firedAt ?? ''} at ${a.lastValue?.toFixed(2) ?? '?'}`}
                  </td>
                  <td style={td}>
                    <button
                      onClick={() => void window.api.alertsRemove(a.id).then(setAlerts)}
                      style={{ background: 'transparent', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 13 }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 16, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Track record</span>
          <span style={{ fontSize: 11.5, color: T.muted }}>the app's own predictions, timestamped daily and scored later</span>
          <InfoTip width={400}>
            <span>
              Every collector run snapshots what the engines are saying — signal tilt, Buffett QARP percentile, IV Rank
              — for each watchlist symbol. Once a snapshot's horizon passes (3 months for tilts, a year for QARP, a
              month for IV), it is scored against what actually happened. Misses are kept forever. This is the honest,
              survivorship-free version of "were the predictions right?" — expect it to look humbler than any backtest.
            </span>
          </InfoTip>
          <button
            onClick={() => loadRetro(retro?.available === true)}
            disabled={retroLoading}
            title={retro?.available ? 'Regenerate (skips the 24h cache — a paid call)' : 'Serves the cached version when fresh'}
            style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6, color: retroLoading ? T.faint : T.muted, padding: '3px 12px', fontSize: 11.5, cursor: 'pointer' }}
          >
            {retroLoading ? 'Reviewing…' : retro?.available ? '✦ Regenerate retrospective' : '✦ AI retrospective (why were we wrong?)'}
          </button>
        </div>

        {retro && (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', marginBottom: 12 }}>
            {retro.available ? (
              <>
                <div style={{ fontSize: 12, color: T.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{retro.text}</div>
                <div style={{ color: T.faint, fontSize: 10, marginTop: 6 }}>AI review of computed outcomes · {retro.generatedAt.slice(0, 16).replace('T', ' ')} UTC · cached 24h</div>
              </>
            ) : (
              <span style={{ fontSize: 11.5, color: T.faint }}>{retro.message}</span>
            )}
          </div>
        )}

        {!record?.available && <div style={{ color: T.faint, fontSize: 12 }}>{record?.message ?? 'Loading…'}</div>}
        {record?.available && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {record.kinds.map((k) => (
              <div key={k.kind} style={{ flex: '1 1 320px', minWidth: 300, border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px' }}>
                <div style={{ color: T.text, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{k.label}</div>
                <div style={{ color: T.faint, fontSize: 10.5, marginBottom: 6 }}>
                  {k.matured} scored · {k.pending} still maturing
                </div>
                <table style={{ borderCollapse: 'collapse', fontSize: 11.5, width: '100%' }}>
                  <tbody>
                    {k.stats.map((s) => (
                      <tr key={s.label}>
                        <td style={{ color: T.muted, padding: '2px 10px 2px 0' }}>{s.label}</td>
                        <td style={{ color: T.text, padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {k.misses.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ color: T.down, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Worst misses</div>
                    {k.misses.map((m, i) => (
                      <div key={i} style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.5 }}>
                        • {m}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ color: T.faint, fontSize: 10.5, lineHeight: 1.5, marginTop: 6 }}>{k.note}</div>
              </div>
            ))}
          </div>
        )}
        {record?.available && (
          <div style={{ color: T.faint, fontSize: 10.5, lineHeight: 1.55, marginTop: 10 }}>
            {record.disclosures.map((d, i) => (
              <div key={i}>• {d}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
