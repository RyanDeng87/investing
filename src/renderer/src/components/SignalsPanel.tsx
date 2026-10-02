import { useEffect, useState } from 'react'
import type { EarningsEvent, SignalReport } from '../../../shared/types'
import { formatPatternKey, type PatternHit } from '../patterns'
import InfoTip from './InfoTip'
import { T, fmtPrice } from '../theme'

function tiltColor(t: number | null): string {
  if (t == null) return T.muted
  if (Math.abs(t) < 10) return T.muted
  return t > 0 ? T.up : T.down
}

function Chip({ text, color }: { text: string; color: string }): React.JSX.Element {
  return (
    <span style={{ fontSize: 11, color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 8px', marginRight: 6 }}>
      {text}
    </span>
  )
}

interface Props {
  symbol: string
  patterns: PatternHit[]
  tfPatterns?: PatternHit[] | null
  tfLabel?: string | null
  onJump?: (hit: PatternHit, scope: 'daily' | 'tf') => void
}

function PatternRow({
  p,
  onClick,
  timeWidth
}: {
  p: PatternHit
  onClick?: () => void
  timeWidth: number
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        cursor: onClick ? 'pointer' : 'default',
        background: hovered && onClick ? T.panelHover : 'transparent',
        borderRadius: 4,
        padding: '1px 4px',
        margin: '0 -4px 6px'
      }}
      title={onClick ? 'Click to jump to this candle on the chart' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        style={{
          color: p.direction === 'bull' ? T.up : p.direction === 'bear' ? T.down : T.muted,
          width: timeWidth,
          flexShrink: 0,
          textDecoration: onClick ? 'underline dotted' : 'none',
          textUnderlineOffset: 3
        }}
      >
        {formatPatternKey(p.key)}
      </span>
      <div>
        <span style={{ color: T.text }}>{p.name}</span>
        {p.confirmed != null && (
          <span style={{ color: p.confirmed ? T.up : T.down, fontSize: 11 }}>
            {p.confirmed ? ' · confirmed' : ' · not confirmed'}
          </span>
        )}
        <span style={{ color: T.muted, fontSize: 11.5 }}> — {p.explanation}</span>
      </div>
    </div>
  )
}

export default function SignalsPanel({ symbol, patterns, tfPatterns, tfLabel, onJump }: Props): React.JSX.Element {
  const [report, setReport] = useState<SignalReport | null>(null)
  const [earnings, setEarnings] = useState<EarningsEvent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setReport(null)
    setEarnings(null)
    setError(null)
    let cancelled = false
    window.api
      .signals(symbol)
      .then((r) => {
        if (!cancelled) setReport(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    window.api
      .nextEarnings(symbol)
      .then((ev) => {
        if (!cancelled) setEarnings(ev)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [symbol])

  if (error) return <div style={{ padding: 16, color: T.down, fontSize: 12.5 }}>Signals failed: {error}</div>
  if (!report) return <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>Computing signals for {symbol}…</div>

  const recentPatterns = [...patterns].slice(-6).reverse()
  const recentTf = tfPatterns ? [...tfPatterns].slice(-6).reverse() : null

  return (
    <div style={{ display: 'flex', gap: 24, padding: '12px 16px', fontSize: 12.5, boxSizing: 'border-box' }}>
      <div style={{ minWidth: 360, maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Bull/bear tilt
          </span>
          <span style={{ fontSize: 16, fontWeight: 700, color: tiltColor(report.tilt) }}>{report.label}</span>
          <Chip text={`confidence: ${report.confidence}`} color={T.muted} />
          <InfoTip width={360}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>How to read this</div>
            <div style={{ color: T.muted }}>
              A weighted blend of the few signal families with documented replication evidence (momentum, earnings
              drift, analyst revisions). It is a probabilistic tilt over months, not a forecast — confidence is
              deliberately capped at "medium". The Buffett engine ignores this tab entirely, by design.
            </div>
          </InfoTip>
        </div>

        {/* Gauge: -100 (bearish) … +100 (bullish) */}
        <div style={{ position: 'relative', height: 10, background: T.panelHover, borderRadius: 5, marginBottom: 14 }}>
          <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: T.faint }} />
          {report.tilt != null && (
            <div
              style={{
                position: 'absolute',
                left: `calc(${(report.tilt + 100) / 2}% - 5px)`,
                top: -3,
                width: 10,
                height: 16,
                borderRadius: 3,
                background: tiltColor(report.tilt)
              }}
            />
          )}
        </div>

        {report.inputs.map((inp) => (
          <div key={inp.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
            <span style={{ width: 150, color: T.text }}>{inp.label}</span>
            <span style={{ width: 130, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{inp.value}</span>
            <div style={{ position: 'relative', width: 90, height: 6, background: T.panelHover, borderRadius: 3 }}>
              <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: T.faint }} />
              {inp.contribution != null && (
                <div
                  style={{
                    position: 'absolute',
                    left: inp.contribution >= 0 ? '50%' : `${50 + inp.contribution * 50}%`,
                    width: `${Math.abs(inp.contribution) * 50}%`,
                    top: 0,
                    bottom: 0,
                    borderRadius: 3,
                    background: inp.contribution >= 0 ? T.up : T.down
                  }}
                />
              )}
            </div>
            <InfoTip width={340}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                {inp.label} · horizon {inp.horizon}
              </div>
              <div style={{ color: T.muted, marginBottom: 5 }}>{inp.detail}</div>
              <div style={{ color: T.faint }}>{inp.evidence}</div>
            </InfoTip>
          </div>
        ))}

        <div style={{ marginTop: 10 }}>
          {report.regime && (
            <>
              <Chip
                text={`price ${report.regime.aboveSma200 ? 'above' : 'below'} 200-day MA`}
                color={report.regime.aboveSma200 ? T.up : T.down}
              />
              {report.regime.goldenCross != null && (
                <Chip
                  text={report.regime.goldenCross ? '50d MA above 200d' : '50d MA below 200d'}
                  color={report.regime.goldenCross ? T.up : T.down}
                />
              )}
              <InfoTip width={340}>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>Regime description, not a signal</div>
                <div style={{ color: T.muted }}>
                  {`Price ${fmtPrice(report.regime.price)} vs 50-day ${fmtPrice(report.regime.sma50)} and 200-day ${fmtPrice(report.regime.sma200)}. Where price sits relative to long moving averages describes the current regime; the evidence says using it as a timing signal is systematically overstated (Zakamulin 2014), so it is deliberately excluded from the tilt.`}
                </div>
              </InfoTip>
            </>
          )}
        </div>
        {earnings && (
          <div style={{ marginTop: 8 }}>
            <Chip
              text={`next earnings ${earnings.date}${earnings.hour ? ' ' + earnings.hour.toUpperCase() : ''} (${earnings.daysUntil}d)`}
              color={earnings.daysUntil <= 7 ? T.warn : T.muted}
            />
            <InfoTip width={340}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Why the earnings date matters here</div>
              <div style={{ color: T.muted }}>
                The earnings-drift (PEAD) input measures drift AFTER the last report — it resets at the next one. BMO =
                before market open, AMC = after close. Dates come from Finnhub&apos;s earnings calendar; the free tier
                sees roughly a month ahead, so no chip doesn&apos;t always mean no upcoming report.
              </div>
            </InfoTip>
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
          Recent candle patterns (annotations, not signals) — click one to jump to it on the chart
          <span style={{ marginLeft: 8, display: 'inline-flex', verticalAlign: 'middle' }}>
            <InfoTip width={360}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Why "not signals"?</div>
              <div style={{ color: T.muted }}>
                The canonical study (Marshall/Young/Rose 2006, J. Banking &amp; Finance) tested 28 candlestick
                strategies on Dow stocks and found no value for investors. Patterns are shown to help you read charts —
                toggle markers with the Patterns button above the chart. Clicking a row centers the chart on the
                pattern, boxes the candles that form it, and opens the inspector with the trend context, shape
                measurements and confirmation status behind the annotation.
              </div>
            </InfoTip>
          </span>
        </div>
        {recentPatterns.length === 0 && <div style={{ color: T.muted }}>No patterns detected in the recent window.</div>}
        {recentPatterns.map((p, i) => (
          <PatternRow key={`d${i}`} p={p} timeWidth={90} onClick={onJump ? () => onJump(p, 'daily') : undefined} />
        ))}

        {recentTf && (
          <>
            <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, margin: '14px 0 8px' }}>
              Patterns on your selected timeframe ({tfLabel})
            </div>
            {recentTf.length === 0 && <div style={{ color: T.muted }}>No patterns in the recent intraday window.</div>}
            {recentTf.map((p, i) => (
              <PatternRow key={`t${i}`} p={p} timeWidth={120} onClick={onJump ? () => onJump(p, 'tf') : undefined} />
            ))}
          </>
        )}
        <div style={{ marginTop: 10, color: T.faint, fontSize: 10.5, lineHeight: 1.5 }}>
          {report.disclosures.map((d, i) => (
            <div key={i}>• {d}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
