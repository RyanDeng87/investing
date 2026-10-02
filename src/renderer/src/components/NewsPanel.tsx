import { useEffect, useState } from 'react'
import type { NewsDigest, NewsItem } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T } from '../theme'

function ago(unixSec: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSec) / 60))
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

const SENTIMENT_COLOR: Record<string, string> = {
  positive: T.up,
  negative: T.down,
  mixed: T.warn,
  neutral: T.muted
}

// Phase 9: AI digest above the raw headlines — main points, sentiment,
// catalysts, risks. Structured output, cached 12h per symbol, key-gated,
// and labeled as an AI summary (verify sources before acting).
export default function NewsPanel({ symbol }: { symbol: string }): React.JSX.Element {
  const [items, setItems] = useState<NewsItem[] | null>(null)
  const [digest, setDigest] = useState<NewsDigest | null>(null)

  useEffect(() => {
    setItems(null)
    setDigest(null)
    let cancelled = false
    window.api
      .news(symbol)
      .then((n) => {
        if (!cancelled) setItems(n)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    window.api
      .newsDigest(symbol)
      .then((d) => {
        if (!cancelled) setDigest(d)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [symbol])

  if (items === null) return <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>Loading news…</div>
  if (items.length === 0)
    return (
      <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>
        No recent news for {symbol} (ETFs often have none; check the Finnhub key in Settings if this looks wrong).
      </div>
    )

  return (
    <div style={{ padding: '8px 16px', fontSize: 12.5 }}>
      {digest?.available && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', margin: '4px 0 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>✦ AI digest</span>
            <span
              style={{
                fontSize: 10.5,
                color: SENTIMENT_COLOR[digest.sentiment] ?? T.muted,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                padding: '1px 8px'
              }}
            >
              {digest.sentiment || 'n/a'}
            </span>
            <span style={{ fontSize: 10, color: T.faint }}>
              {digest.headlineCount} headlines · {digest.generatedAt.slice(0, 16).replace('T', ' ')} UTC · cached 12h
            </span>
            <InfoTip width={330}>
              <span>
                Claude condenses the headlines below into takeaways — it sees ONLY these headlines and summaries, no
                outside information. AI summary: verify against the sources before acting on anything here.
              </span>
            </InfoTip>
          </div>
          {digest.mainPoints.length > 0 && (
            <div style={{ color: T.text, lineHeight: 1.55, fontSize: 12 }}>
              {digest.mainPoints.map((p, i) => (
                <div key={i}>• {p}</div>
              ))}
            </div>
          )}
          {digest.catalysts.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span style={{ color: T.accent, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Catalysts</span>
              {digest.catalysts.map((c, i) => (
                <div key={i} style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                  • {c}
                </div>
              ))}
            </div>
          )}
          {digest.risks.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span style={{ color: T.down, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Risks flagged</span>
              {digest.risks.map((r, i) => (
                <div key={i} style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                  • {r}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {digest && !digest.available && digest.message && (
        <div style={{ color: T.faint, fontSize: 11, margin: '4px 0 8px' }}>✦ {digest.message}</div>
      )}
      {items.map((n, i) => (
        <div
          key={i}
          style={{ padding: '6px 0', borderBottom: `1px solid ${T.grid}`, cursor: 'pointer' }}
          onClick={() => void window.api.openExternal(n.url)}
          title={n.summary}
        >
          <span style={{ color: T.faint, marginRight: 8, fontVariantNumeric: 'tabular-nums' }}>{ago(n.datetime)}</span>
          <span style={{ color: T.text }}>{n.headline}</span>
          <span style={{ color: T.faint, marginLeft: 8, fontSize: 11 }}>{n.source}</span>
        </div>
      ))}
    </div>
  )
}
