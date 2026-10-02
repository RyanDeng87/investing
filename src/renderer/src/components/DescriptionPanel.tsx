import { useEffect, useState } from 'react'
import type { CompanyProfile, StanceReport } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T } from '../theme'

// Description tab: what the symbol IS (FMP profile) and where the app's own
// engines land on it (the stance card). The (i) popup carries the full
// reasoning with the actual input values — the stance is never shown without
// its arithmetic one hover away.

function fmtMktCap(v: number | null): string {
  if (v == null) return ''
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}

function actionColor(action: StanceReport['action']): string {
  return action === 'buy' ? T.up : action === 'sell' ? T.down : T.muted
}

const MARK: Record<'for' | 'against' | 'neutral', { ch: string; color: string }> = {
  for: { ch: '+', color: T.up },
  against: { ch: '−', color: T.down },
  neutral: { ch: '·', color: T.muted }
}

export default function DescriptionPanel({ symbol }: { symbol: string }): React.JSX.Element {
  const [profile, setProfile] = useState<CompanyProfile | null>(null)
  const [stance, setStance] = useState<StanceReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setProfile(null)
    setStance(null)
    setError(null)
    let cancelled = false
    window.api
      .profile(symbol)
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    window.api
      .stance(symbol)
      .then((s) => {
        if (!cancelled) setStance(s)
      })
      .catch(() => {
        if (!cancelled) setStance(null)
      })
    return () => {
      cancelled = true
    }
  }, [symbol])

  if (error) return <div style={{ padding: 16, color: T.down, fontSize: 12.5 }}>Description failed: {error}</div>

  return (
    <div style={{ display: 'flex', gap: 24, padding: '12px 16px', fontSize: 12.5, boxSizing: 'border-box' }}>
      {/* --- Stance card --- */}
      <div style={{ minWidth: 400, maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>Stance</span>
          {stance ? (
            stance.available ? (
              <>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    letterSpacing: 0.8,
                    color: actionColor(stance.action),
                    border: `1px solid ${actionColor(stance.action)}`,
                    borderRadius: 5,
                    padding: '1px 10px'
                  }}
                >
                  {stance.action.toUpperCase()}
                </span>
                <span style={{ color: T.text }}>{stance.timeframe}</span>
                <span
                  style={{ fontSize: 11, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 4, padding: '1px 8px' }}
                >
                  confidence: {stance.confidence}
                </span>
                <InfoTip width={420}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>How this stance is computed</div>
                  <div style={{ color: T.muted, marginBottom: 6 }}>
                    A weighted blend of the app&apos;s own engines (quality/valuation 35%, momentum 35%, trend regime 15%,
                    market sentiment 15%), renormalized over what&apos;s available. Composite{' '}
                    {stance.composite >= 0 ? '+' : ''}
                    {stance.composite.toFixed(0)} on a −100…+100 scale; ≥ +15 reads buy, ≤ −15 reads sell.
                  </div>
                  {stance.reasons.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                      <span style={{ color: MARK[r.direction].color, fontWeight: 700, flexShrink: 0 }}>{MARK[r.direction].ch}</span>
                      <span style={{ color: T.text }}>{r.text}</span>
                    </div>
                  ))}
                  <div style={{ color: T.muted, marginTop: 6 }}>Confidence: {stance.confidenceDetail}.</div>
                  {stance.cautions.map((c, i) => (
                    <div key={i} style={{ color: T.warn, marginTop: 4 }}>⚠ {c}</div>
                  ))}
                </InfoTip>
              </>
            ) : (
              <span style={{ color: T.muted, fontSize: 12 }}>{stance.message}</span>
            )
          ) : (
            <span style={{ color: T.muted, fontSize: 12 }}>computing…</span>
          )}
        </div>

        {stance?.available && (
          <>
            {/* Composite gauge: -100 (sell) … +100 (buy) */}
            <div style={{ position: 'relative', height: 10, background: T.panelHover, borderRadius: 5, marginBottom: 10 }}>
              <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: T.faint }} />
              <div
                style={{
                  position: 'absolute',
                  left: `calc(${(stance.composite + 100) / 2}% - 5px)`,
                  top: -3,
                  width: 10,
                  height: 16,
                  borderRadius: 3,
                  background: actionColor(stance.action)
                }}
              />
            </div>

            <div style={{ fontSize: 11.5, color: stance.tracked ? T.up : T.muted, marginBottom: 8 }}>
              {stance.tracked
                ? '✓ Starred — this stance is recorded daily and graded against SPY in the Journal’s track record.'
                : '★ Star this symbol in the watchlist to have its buy/sell stances recorded daily and graded in the Journal’s track record.'}
            </div>

            {stance.cautions.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {stance.cautions.map((c, i) => (
                  <div key={i} style={{ color: T.warn, fontSize: 11.5, lineHeight: 1.5 }}>
                    ⚠ {c}
                  </div>
                ))}
              </div>
            )}

            <div style={{ color: T.faint, fontSize: 10.5, lineHeight: 1.5 }}>
              {stance.disclosures.map((d, i) => (
                <div key={i}>• {d}</div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* --- Company / fund profile --- */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!profile && <div style={{ color: T.muted }}>Loading profile…</div>}
        {profile && !profile.available && <div style={{ color: T.muted }}>{profile.message}</div>}
        {profile?.available && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: T.text }}>{profile.name}</span>
              {profile.isEtf && (
                <span style={{ fontSize: 10.5, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 4, padding: '0 6px' }}>
                  ETF
                </span>
              )}
              {profile.website && (
                <span
                  style={{ fontSize: 11, color: T.accent, cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
                  onClick={() => void window.api.openExternal(profile.website)}
                >
                  {profile.website.replace(/^https?:\/\/(www\.)?/, '')}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: T.muted, marginBottom: 8 }}>
              {[profile.exchange, profile.sector, profile.industry, fmtMktCap(profile.marketCap) && `mkt cap ${fmtMktCap(profile.marketCap)}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div style={{ maxHeight: 130, overflowY: 'auto', color: T.text, fontSize: 12, lineHeight: 1.65, paddingRight: 8 }}>
              {profile.description || 'No description on file for this symbol.'}
            </div>
            <div style={{ color: T.faint, fontSize: 10.5, marginTop: 8 }}>
              Profile from FMP{profile.fetchedAt ? ` · cached ${profile.fetchedAt.slice(0, 10)}` : ''} — figures update with the
              rolling fundamentals crawl, not in real time.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
