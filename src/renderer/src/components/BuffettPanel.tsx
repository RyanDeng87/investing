import { useEffect, useState } from 'react'
import type { BuffettScore, MetricScore, ReverseDcf } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T } from '../theme'

const PCT_KEYS = new Set([
  'earningsYield',
  'fcfYield',
  'bookYield',
  'roe',
  'roic',
  'grossMargin',
  'netMargin',
  'revenueCagr',
  'epsCagr',
  'volatility'
])

function fmtMetric(m: MetricScore): string {
  if (m.value == null) return '—'
  if (PCT_KEYS.has(m.key)) return (m.value * 100).toFixed(1) + '%'
  if (m.key === 'marginStability') return (-m.value * 100).toFixed(1) + 'pt σ'
  return m.value.toFixed(2)
}

function barColor(pct: number): string {
  return pct >= 60 ? T.up : pct >= 40 ? T.warn : T.down
}

function Bar({ pct }: { pct: number | null }): React.JSX.Element {
  return (
    <div style={{ background: T.panelHover, borderRadius: 3, height: 8, width: 120, overflow: 'hidden' }}>
      {pct != null && (
        <div style={{ width: `${Math.max(2, Math.min(100, pct))}%`, height: '100%', background: barColor(pct), borderRadius: 3 }} />
      )}
    </div>
  )
}

const PILLAR_LABELS: { key: keyof BuffettScore['pillars']; label: string }[] = [
  { key: 'quality', label: 'Quality' },
  { key: 'value', label: 'Value' },
  { key: 'growth', label: 'Growth' },
  { key: 'safety', label: 'Safety' }
]

function FallbackBadge(): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          fontSize: 10,
          color: T.warn,
          border: `1px solid ${T.warn}`,
          borderRadius: 4,
          padding: '1px 6px',
          letterSpacing: 0.4
        }}
      >
        FALLBACK DATA · SEC EDGAR + FINNHUB
      </span>
      <InfoTip>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          FMP's free tier gates this symbol, so its score uses free fallback sources.
        </div>
        <div style={{ color: T.up, fontWeight: 600, marginTop: 6 }}>Pros</div>
        <div style={{ color: T.muted }}>
          • SEC EDGAR is official, as-filed 10-K data — the primary source everyone else repackages
          <br />• Covers every US filer; can never be paywalled; $0 and uses no FMP quota
          <br />• Finnhub adds fresh TTM ratios (ROE, margins, debt/equity, P/E) the filings can't
        </div>
        <div style={{ color: T.down, fontWeight: 600, marginTop: 6 }}>Cons</div>
        <div style={{ color: T.muted }}>
          • EDGAR figures are fiscal-year, not trailing-twelve-month — they can lag up to ~12 months
          <br />• Some metrics unavailable (ROIC) or from mixed sources with slightly different definitions
          <br />• XBRL tag differences across companies can leave gaps — treat close percentile calls with skepticism
          <br />• Upgrade path if this ever matters: FMP Starter (~$22/mo) unlocks the full universe (see README)
        </div>
      </InfoTip>
    </span>
  )
}

export default function BuffettPanel({ symbol }: { symbol: string }): React.JSX.Element {
  const [score, setScore] = useState<BuffettScore | null>(null)
  const [dcf, setDcf] = useState<ReverseDcf | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setScore(null)
    setDcf(null)
    let cancelled = false
    window.api
      .reverseDcf(symbol)
      .then((d) => {
        if (!cancelled) setDcf(d)
      })
      .catch(() => undefined)
    window.api
      .score(symbol)
      .then((s) => {
        if (!cancelled) setScore(s)
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setScore({
            symbol,
            scoredAt: '',
            universeScored: 0,
            universeSize: 0,
            pillars: {
              value: { percentile: null, metrics: [] },
              quality: { percentile: null, metrics: [] },
              growth: { percentile: null, metrics: [] },
              safety: { percentile: null, metrics: [] }
            },
            qarp: null,
            lynch: [],
            caveats: [],
            available: false,
            message: `Scoring failed: ${e instanceof Error ? e.message : String(e)}`
          })
      })
    return () => {
      cancelled = true
    }
  }, [symbol])

  if (!score) return <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>Scoring {symbol}…</div>

  if (!score.available) {
    return (
      <div style={{ padding: 16, color: T.muted, fontSize: 12.5, lineHeight: 1.6 }}>
        <div style={{ color: T.text, fontWeight: 600, marginBottom: 4 }}>No Buffett score for {symbol} yet</div>
        {score.message}
        <div style={{ marginTop: 6 }}>
          Universe progress: {score.universeScored} of {score.universeSize} symbols crawled (a few more each day within
          the free FMP budget, or run the crawl from Settings).
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 24, padding: '12px 16px', fontSize: 12.5, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ minWidth: 320 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            QARP composite
          </span>
          <span style={{ fontSize: 22, fontWeight: 700, color: score.qarp != null ? barColor(score.qarp) : T.muted }}>
            {score.qarp != null ? score.qarp.toFixed(0) : '—'}
          </span>
          <span style={{ color: T.muted, fontSize: 11 }}>percentile · 65% quality / 35% value</span>
          {score.dataSource === 'fallback' && <FallbackBadge />}
        </div>
        {PILLAR_LABELS.map(({ key, label }) => {
          const p = score.pillars[key]
          return (
            <div key={key} style={{ marginBottom: 6 }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                onClick={() => setExpanded(expanded === key ? null : key)}
              >
                <span style={{ width: 60, color: T.text }}>{label}</span>
                <Bar pct={p.percentile} />
                <span style={{ width: 34, textAlign: 'right', color: p.percentile != null ? T.text : T.muted }}>
                  {p.percentile != null ? p.percentile.toFixed(0) : '—'}
                </span>
                <span style={{ color: T.faint, fontSize: 10 }}>{expanded === key ? '▾' : '▸'}</span>
              </div>
              {expanded === key && (
                <div style={{ margin: '4px 0 8px 70px', color: T.muted }}>
                  {p.metrics.map((m) => (
                    <div key={m.key} style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 190 }}>{m.label}</span>
                      <span style={{ width: 70, color: T.text }}>{fmtMetric(m)}</span>
                      <span>{m.percentile != null ? `p${m.percentile.toFixed(0)}` : 'n/a'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
          Lynch screen
        </div>
        {score.lynch.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'baseline' }}>
            <span style={{ color: c.verdict === 'pass' ? T.up : c.verdict === 'fail' ? T.down : T.muted, width: 14 }}>
              {c.verdict === 'pass' ? '✓' : c.verdict === 'fail' ? '✗' : '○'}
            </span>
            <div>
              <div style={{ color: T.text }}>{c.label}</div>
              <div style={{ color: T.muted, fontSize: 11.5 }}>{c.detail}</div>
            </div>
          </div>
        ))}

        {dcf && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
              Reverse DCF — what today&apos;s price implies
              <InfoTip width={400}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Price → assumption, not assumption → price</div>
                <div style={{ color: T.muted, marginBottom: 6 }}>
                  The percentile scores above are RELATIVE — they can never say &quot;everything is expensive.&quot; This
                  inverts the price instead: what 10-year {dcf.basis === 'fcf' ? 'free-cash-flow' : 'earnings'} growth
                  makes a two-stage DCF (terminal 2.5%/yr) equal today&apos;s market cap? Judge the implied number
                  against the trailing record — the model makes no forecast of its own.
                </div>
                {dcf.caveats.map((c, i) => (
                  <div key={i} style={{ color: T.faint, marginTop: 3 }}>
                    • {c}
                  </div>
                ))}
              </InfoTip>
            </div>
            {dcf.available ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontSize: 19, fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
                    {dcf.impliedGrowth != null ? `${(dcf.impliedGrowth * 100).toFixed(1)}%/yr` : '>100%/yr'}
                  </span>
                  <span style={{ color: T.muted, fontSize: 11.5 }}>
                    implied {dcf.basis === 'fcf' ? 'FCF' : 'earnings'} growth for 10y at a 10% required return
                    {dcf.sensitivity[0]?.impliedGrowth != null && dcf.sensitivity[2]?.impliedGrowth != null
                      ? ` (8% → ${(dcf.sensitivity[0].impliedGrowth * 100).toFixed(1)}%, 12% → ${(dcf.sensitivity[2].impliedGrowth * 100).toFixed(1)}%)`
                      : ''}
                  </span>
                </div>
                <div style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                  Trailing record: revenue CAGR{' '}
                  <span style={{ color: T.text }}>{dcf.histRevenueCagr != null ? (dcf.histRevenueCagr * 100).toFixed(1) + '%' : 'n/a'}</span>, EPS
                  CAGR <span style={{ color: T.text }}>{dcf.histEpsCagr != null ? (dcf.histEpsCagr * 100).toFixed(1) + '%' : 'n/a'}</span> · TTM{' '}
                  {dcf.basis === 'fcf' ? 'FCF' : 'earnings'} yield {(dcf.yieldUsed * 100).toFixed(2)}%
                  {dcf.basis === 'earnings' ? ' · earnings-yield basis (FCF unavailable)' : ''}
                </div>
              </>
            ) : (
              <div style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.5 }}>{dcf.message}</div>
            )}
          </div>
        )}

        <div style={{ marginTop: 10, color: T.faint, fontSize: 10.5, lineHeight: 1.5 }}>
          {score.caveats.map((c, i) => (
            <div key={i}>• {c}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
