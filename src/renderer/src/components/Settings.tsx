import { useEffect, useState } from 'react'
import type { CollectorResult, CollectorScheduleInfo, CrawlSummary, JobLogRow, KeyStatus } from '../../../shared/types'
import { T } from '../theme'

// Weekday order for the schedule editor — weekdays first, weekend last.
const DAY_OPTIONS: { name: string; short: string }[] = [
  { name: 'Monday', short: 'Mon' },
  { name: 'Tuesday', short: 'Tue' },
  { name: 'Wednesday', short: 'Wed' },
  { name: 'Thursday', short: 'Thu' },
  { name: 'Friday', short: 'Fri' },
  { name: 'Saturday', short: 'Sat' },
  { name: 'Sunday', short: 'Sun' }
]

function fmtLocal(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50
  },
  modal: {
    width: 640,
    maxHeight: '85vh',
    overflowY: 'auto',
    background: T.panel,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: 20
  },
  h2: { fontSize: 15, margin: '0 0 12px', color: T.text },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
  label: { width: 140, fontSize: 12.5, color: T.muted },
  input: {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    padding: '6px 10px',
    fontSize: 12.5,
    flex: 1,
    minWidth: 200
  },
  btn: {
    background: T.accent,
    border: 'none',
    borderRadius: 6,
    color: 'white',
    padding: '7px 14px',
    fontSize: 12.5,
    cursor: 'pointer'
  },
  btnGhost: {
    background: 'transparent',
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    padding: '6px 12px',
    fontSize: 12.5,
    cursor: 'pointer'
  },
  note: { fontSize: 11.5, color: T.muted, marginTop: 6, lineHeight: 1.5 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5, marginTop: 8 },
  th: { textAlign: 'left', color: T.muted, fontWeight: 600, padding: '4px 6px', borderBottom: `1px solid ${T.border}` },
  td: { padding: '4px 6px', borderBottom: `1px solid ${T.grid}`, color: T.text }
}

const KEY_FIELDS = [
  { name: 'alpaca_key_id', label: 'Alpaca Key ID', prop: 'alpacaKeyId' as const, note: undefined },
  { name: 'alpaca_secret', label: 'Alpaca Secret', prop: 'alpacaSecret' as const, note: undefined },
  { name: 'fmp_key', label: 'FMP Key', prop: 'fmpKey' as const, note: undefined },
  { name: 'finnhub_key', label: 'Finnhub Key', prop: 'finnhubKey' as const, note: undefined },
  {
    name: 'anthropic_key',
    label: 'Anthropic Key',
    prop: 'anthropicKey' as const,
    note: 'console.anthropic.com → API keys. Powers the ✦ Copilot tab and the Discover market brief (~cents/day at normal use).'
  },
  {
    name: 'fred_key',
    label: 'FRED Key',
    prop: 'fredKey' as const,
    note: 'fredaccount.stlouisfed.org/apikeys (free). Powers the macro panel in Discover: rates, inflation, dollar index.'
  }
]

export default function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [keys, setKeys] = useState<KeyStatus | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [collectResults, setCollectResults] = useState<CollectorResult[]>([])
  const [crawl, setCrawl] = useState<CrawlSummary | null>(null)
  const [jobs, setJobs] = useState<JobLogRow[]>([])
  // The MCP registration to-do is independent of any key — dismissed manually.
  const [mcpDone, setMcpDone] = useState(() => localStorage.getItem('mcpTodoDone') === '1')
  // Scheduled collector task (Windows). `sched` reflects the real task; the
  // editor state below is what the user is about to save.
  const [sched, setSched] = useState<CollectorScheduleInfo | null>(null)
  const [schedDays, setSchedDays] = useState<string[]>(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
  const [schedTime, setSchedTime] = useState('14:50')
  const [schedEnabled, setSchedEnabled] = useState(true)

  const refresh = async (): Promise<void> => {
    setKeys(await window.api.keysStatus())
    setJobs(await window.api.recentJobs(12))
  }

  // Sync the editor from the real task. Kept separate from refresh() so running
  // a collector/crawl doesn't clobber in-progress schedule edits.
  const loadSchedule = async (): Promise<void> => {
    const s = await window.api.collectorSchedule()
    setSched(s)
    setSchedDays(s.days)
    setSchedTime(s.time)
    setSchedEnabled(s.registered ? s.enabled : true)
  }

  useEffect(() => {
    void refresh()
    void loadSchedule()
  }, [])

  const toggleDay = (name: string): void =>
    setSchedDays((cur) => (cur.includes(name) ? cur.filter((d) => d !== name) : [...cur, name]))

  const saveSchedule = async (): Promise<void> => {
    setBusy('schedule')
    try {
      const s = await window.api.collectorScheduleSet({ enabled: schedEnabled, days: schedDays, time: schedTime })
      setSched(s)
      setSchedDays(s.days)
      setSchedTime(s.time)
      if (s.registered) setSchedEnabled(s.enabled)
    } finally {
      setBusy(null)
    }
  }

  const removeSchedule = async (): Promise<void> => {
    setBusy('schedule')
    try {
      setSched(await window.api.collectorScheduleRemove())
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async (name: string): Promise<void> => {
    await window.api.setKey(name, inputs[name] ?? '')
    setInputs((p) => ({ ...p, [name]: '' }))
    await refresh()
  }

  const runCollector = async (): Promise<void> => {
    setBusy('collector')
    try {
      setCollectResults(await window.api.runCollector())
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const runCrawl = async (): Promise<void> => {
    setBusy('crawl')
    try {
      setCrawl(await window.api.runCrawl())
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={S.h2}>Settings</h2>
          <button style={S.btnGhost} onClick={onClose}>
            Close
          </button>
        </div>

        {keys && (!keys.anthropicKey || !keys.fredKey || !mcpDone) && (
          <div style={{ border: `1px solid ${T.warn}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            <div style={{ color: T.warn, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Setup to-dos (whenever you get to them)</div>
            <div style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.7 }}>
              {!keys.anthropicKey && (
                <div>
                  ☐ <b>Anthropic key</b> (console.anthropic.com, pay-as-you-go) — unlocks ✦ Copilot + hypothesis logging, AI
                  verdicts on due hypotheses, the AI retrospective, the Discover market brief, and the news digest.
                </div>
              )}
              {!keys.fredKey && (
                <div>
                  ☐ <b>FRED key</b> (fredaccount.stlouisfed.org/apikeys, free) — unlocks the macro panel in Discover.
                </div>
              )}
              {!mcpDone && (
                <div>
                  ☐ <b>MCP registration</b> (optional, one-time, in any terminal):{' '}
                  <code style={{ fontSize: 10.5 }}>claude mcp add --transport http investing http://127.0.0.1:48620/mcp</code> — lets
                  Claude Code query this app's engines while it runs.{' '}
                  <button
                    onClick={() => {
                      localStorage.setItem('mcpTodoDone', '1')
                      setMcpDone(true)
                    }}
                    style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 5, color: T.muted, padding: '0 8px', fontSize: 10.5, cursor: 'pointer' }}
                  >
                    mark done
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <h2 style={{ ...S.h2, marginTop: 8 }}>API keys</h2>
        {keys && !keys.encryptionAvailable && (
          <p style={{ ...S.note, color: T.warn }}>
            OS encryption unavailable — keys would be stored obfuscated but NOT encrypted.
          </p>
        )}
        {KEY_FIELDS.map((f) => (
          <div key={f.name}>
            <div style={S.row}>
              <span style={S.label}>
                {f.label}{' '}
                <span style={{ color: keys?.[f.prop] ? T.up : T.down }}>{keys?.[f.prop] ? '●' : '○'}</span>
              </span>
              <input
                style={S.input}
                type="password"
                placeholder="paste key, then Save"
                value={inputs[f.name] ?? ''}
                onChange={(e) => setInputs((p) => ({ ...p, [f.name]: e.target.value }))}
              />
              <button style={S.btnGhost} onClick={() => void saveKey(f.name)}>
                Save
              </button>
            </div>
            {f.note && !keys?.[f.prop] && <p style={{ ...S.note, margin: '0 0 8px 148px' }}>{f.note}</p>}
          </div>
        ))}

        <h2 style={{ ...S.h2, marginTop: 16 }}>Data jobs</h2>
        <div style={S.row}>
          <button style={S.btn} disabled={busy !== null} onClick={() => void runCollector()}>
            {busy === 'collector' ? 'Collecting…' : 'Run IV collector now'}
          </button>
          <button style={S.btnGhost} disabled={busy !== null} onClick={() => void runCrawl()}>
            {busy === 'crawl' ? 'Crawling…' : 'Run fundamentals crawl now'}
          </button>
        </div>
        <p style={S.note}>
          The scheduled collector (configured below) runs IV collection, bar refresh, and the fundamentals crawl
          automatically. The crawl refreshes the scoring universe a few symbols per day within FMP's 250-call budget.
        </p>
        {collectResults.length > 0 && (
          <p style={S.note}>
            Collector: {collectResults.filter((r) => r.status === 'ok').length}/{collectResults.length} symbols ok
            {collectResults
              .filter((r) => r.status !== 'ok')
              .slice(0, 3)
              .map((r) => ` · ${r.symbol}: ${r.message}`)
              .join('')}
          </p>
        )}
        {crawl && (
          <p style={S.note}>
            Crawl: {crawl.symbols.length} symbols ({crawl.symbols.slice(0, 8).join(', ')}
            {crawl.symbols.length > 8 ? '…' : ''}) · {crawl.callsUsed} calls used · {crawl.remainingToday} left today
            {crawl.message ? ` · ${crawl.message}` : ''}
          </p>
        )}

        <h2 style={{ ...S.h2, marginTop: 16 }}>Scheduled collector</h2>
        {sched && !sched.supported && (
          <p style={S.note}>Scheduled tasks are managed on Windows only.</p>
        )}
        {sched && sched.supported && (
          <>
            <p style={S.note}>
              {sched.registered ? (
                <>
                  Status:{' '}
                  <b style={{ color: sched.enabled ? T.up : T.warn }}>{sched.enabled ? 'enabled' : 'disabled'}</b>
                  {sched.nextRun ? ` · next run ${fmtLocal(sched.nextRun)}` : ''}
                  {' · '}
                  {sched.lastRun
                    ? `last run ${fmtLocal(sched.lastRun)} (${sched.lastResult === 0 ? 'ok' : `code ${sched.lastResult}`})`
                    : 'has not run yet'}
                </>
              ) : (
                'No scheduled task registered — pick days and a time below, then Save to create it.'
              )}
            </p>
            <div style={S.row}>
              <span style={S.label}>Run on</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {DAY_OPTIONS.map((d) => (
                  <label
                    key={d.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: T.text, cursor: 'pointer' }}
                  >
                    <input type="checkbox" checked={schedDays.includes(d.name)} onChange={() => toggleDay(d.name)} />
                    {d.short}
                  </label>
                ))}
              </div>
            </div>
            <div style={S.row}>
              <span style={S.label}>At (local time)</span>
              <input
                type="time"
                style={{ ...S.input, flex: 'none', width: 130, minWidth: 0 }}
                value={schedTime}
                onChange={(e) => setSchedTime(e.target.value)}
              />
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text, cursor: 'pointer', marginLeft: 8 }}
              >
                <input type="checkbox" checked={schedEnabled} onChange={(e) => setSchedEnabled(e.target.checked)} />
                Enabled
              </label>
            </div>
            <div style={S.row}>
              <button style={S.btn} disabled={busy !== null} onClick={() => void saveSchedule()}>
                {busy === 'schedule' ? 'Saving…' : sched.registered ? 'Save schedule' : 'Create scheduled task'}
              </button>
              {sched.registered && (
                <button style={S.btnGhost} disabled={busy !== null} onClick={() => void removeSchedule()}>
                  Cancel scheduled task
                </button>
              )}
            </div>
            {sched.message && <p style={{ ...S.note, color: T.warn }}>{sched.message}</p>}
            <p style={S.note}>
              Runs the collector in the background with no console window. Times are your computer's local time — aim for
              ~10 min before the 4:00 PM ET close (2:50 PM Central / 3:50 PM Eastern). StartWhenAvailable is on, so a
              sleeping PC runs it on wake. "Cancel" removes the task entirely; untick "Enabled" to keep it but pause it.
            </p>
          </>
        )}

        <h2 style={{ ...S.h2, marginTop: 16 }}>Job log</h2>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>When (UTC)</th>
              <th style={S.th}>Job</th>
              <th style={S.th}>Status</th>
              <th style={S.th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td style={S.td}>{j.ran_at}</td>
                <td style={S.td}>{j.job}</td>
                <td style={{ ...S.td, color: j.status === 'ok' ? T.up : j.status === 'error' ? T.down : T.warn }}>
                  {j.status}
                </td>
                <td style={S.td}>{j.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
