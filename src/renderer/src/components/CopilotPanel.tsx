import { useEffect, useRef } from 'react'
import type { CopilotTurn } from '../../../shared/types'
import { T } from '../theme'

// Phase 7 copilot: chat grounded in the app's computed engines for the
// active symbol. Each question ships fresh signals/score/options/discovery
// data as context; the model is instructed to cite fields and keep the
// app's honest-labeling rules. Not an oracle — a reading aid.
//
// Threads + busy state live in App (passed as props): answers cost real
// cents, so an in-flight reply must survive tab/view switches — the promise
// writes into App state whether or not this panel is mounted.

export interface CopilotChatMsg extends CopilotTurn {
  costCents?: number
  error?: boolean
  logged?: number // hypotheses recorded into the journal by this reply
}

export type CopilotThreads = Record<string, CopilotChatMsg[]>

interface Props {
  symbol: string
  hasKey: boolean
  threads: CopilotThreads
  setThreads: React.Dispatch<React.SetStateAction<CopilotThreads>>
  busy: Record<string, boolean>
  setBusy: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  input: string
  setInput: (v: string) => void
}

const SUGGESTIONS = [
  'Summarize what the app knows about this symbol.',
  'What are the strongest and weakest parts of the Buffett score?',
  'Is IV rich or cheap here, and what would the screener do about it?',
  'What would make the momentum signal flip?'
]

export default function CopilotPanel({ symbol, hasKey, threads, setThreads, busy, setBusy, input, setInput }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const messages = threads[symbol] ?? []
  const symbolBusy = busy[symbol] === true

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, symbolBusy])

  const ask = (q: string): void => {
    const question = q.trim()
    if (!question || symbolBusy) return
    const forSymbol = symbol
    // History for the API: successful exchanges only — drop errored replies
    // AND the user turn that produced them, keeping user/assistant pairs.
    const raw = threads[forSymbol] ?? []
    const history: CopilotTurn[] = []
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i]
      if (m.role === 'user') {
        const reply = raw[i + 1]
        if (reply && reply.role === 'assistant' && !reply.error) {
          history.push({ role: 'user', content: m.content }, { role: 'assistant', content: reply.content })
        }
      }
    }
    setThreads((p) => ({ ...p, [forSymbol]: [...(p[forSymbol] ?? []), { role: 'user', content: question }] }))
    setInput('')
    setBusy((p) => ({ ...p, [forSymbol]: true }))
    window.api
      .askCopilot(forSymbol, question, history)
      .then((r) => {
        setThreads((p) => ({
          ...p,
          [forSymbol]: [
            ...(p[forSymbol] ?? []),
            r.ok
              ? { role: 'assistant' as const, content: r.text, costCents: r.costCents, logged: r.logged }
              : { role: 'assistant' as const, content: r.error ?? 'Something went wrong.', error: true }
          ]
        }))
      })
      .catch((e: unknown) => {
        setThreads((p) => ({
          ...p,
          [forSymbol]: [...(p[forSymbol] ?? []), { role: 'assistant' as const, content: e instanceof Error ? e.message : String(e), error: true }]
        }))
      })
      .finally(() => {
        setBusy((p) => ({ ...p, [forSymbol]: false }))
      })
  }

  if (!hasKey) {
    return (
      <div style={{ padding: 16, color: T.muted, fontSize: 12.5, lineHeight: 1.6 }}>
        <b style={{ color: T.text }}>✦ Copilot</b> answers questions about {symbol} grounded in the app's own computed
        data — signals, Buffett score, options analytics, market discovery — with the honest-labeling rules built in.
        <br />
        Add an <b>Anthropic API key</b> in Settings to enable it (console.anthropic.com, pay-as-you-go — a question
        costs a few cents). The same key also powers the AI market brief in Discover.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ color: T.muted, fontSize: 12 }}>
            <div style={{ marginBottom: 8 }}>
              Ask about <b style={{ color: T.text }}>{symbol}</b> — answers are grounded in the app's computed data and
              inherit its caveats. Never advice.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  disabled={symbolBusy}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${T.border}`,
                    borderRadius: 12,
                    color: symbolBusy ? T.faint : T.muted,
                    padding: '3px 10px',
                    fontSize: 11.5,
                    cursor: symbolBusy ? 'default' : 'pointer'
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10, display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div
              style={{
                maxWidth: '85%',
                background: m.role === 'user' ? T.panelHover : 'transparent',
                border: `1px solid ${m.error ? T.down : T.border}`,
                borderRadius: 8,
                padding: '7px 11px',
                fontSize: 12.5,
                color: m.error ? T.down : T.text,
                whiteSpace: 'pre-wrap',
                lineHeight: 1.55
              }}
            >
              {m.content}
              {(m.costCents != null || (m.logged ?? 0) > 0) && (
                <div style={{ color: T.faint, fontSize: 10, marginTop: 5 }}>
                  {(m.logged ?? 0) > 0 && <span style={{ color: T.warn }}>📌 hypothesis logged → Journal (scored when due) · </span>}
                  claude-opus-4-8 · ~{m.costCents}¢
                </div>
              )}
            </div>
          </div>
        ))}
        {symbolBusy && <div style={{ color: T.muted, fontSize: 12 }}>Thinking… (gathering the app's data, then asking Claude)</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}` }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask(input)
          }}
          placeholder={`Ask about ${symbol}…`}
          style={{
            flex: 1,
            background: T.bg,
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            color: T.text,
            padding: '7px 10px',
            fontSize: 12.5
          }}
        />
        <button
          onClick={() => ask(input)}
          disabled={symbolBusy || !input.trim()}
          style={{
            background: symbolBusy || !input.trim() ? 'transparent' : T.accent,
            border: `1px solid ${T.accent}`,
            borderRadius: 6,
            color: symbolBusy || !input.trim() ? T.muted : '#fff',
            padding: '7px 16px',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: symbolBusy || !input.trim() ? 'default' : 'pointer'
          }}
        >
          Ask
        </button>
      </div>
    </div>
  )
}
