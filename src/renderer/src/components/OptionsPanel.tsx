import React, { useEffect, useState } from 'react'
import type { EarningsEvent, OptionsAnalytics } from '../../../shared/types'
import InfoTip from './InfoTip'
import { T, fmtPrice } from '../theme'

function fmtDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const HOUR_LABEL: Record<string, string> = { bmo: 'before open', amc: 'after close', dmh: 'during hours' }

function Stat({
  label,
  value,
  tip,
  color
}: {
  label: string
  value: string
  tip: React.ReactNode
  color?: string
}): React.JSX.Element {
  return (
    <div style={{ minWidth: 130 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
        <InfoTip width={340}>{tip}</InfoTip>
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color ?? T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

// Sample up to 8 points SPREAD ACROSS the term — symbols with daily expirations
// (SPY/QQQ) would otherwise show only 0-8 DTE and never the far end the
// contango/inversion comparison needs.
function sampleTerm(term: OptionsAnalytics['termStructure']): OptionsAnalytics['termStructure'] {
  const valid = term.filter((t) => t.atmIv != null && t.dte >= 1)
  if (valid.length <= 8) return valid
  const step = (valid.length - 1) / 7
  const out: typeof valid = []
  for (let i = 0; i < 8; i++) {
    const pick = valid[Math.round(i * step)]
    if (!out.includes(pick)) out.push(pick)
  }
  return out
}

export default function OptionsPanel({ symbol }: { symbol: string }): React.JSX.Element {
  const [a, setA] = useState<OptionsAnalytics | null>(null)
  const [earnings, setEarnings] = useState<EarningsEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    setA(null)
    setEarnings(null)
    setError(null)
    setExpanded(null)
    let cancelled = false
    window.api
      .optionsAnalytics(symbol)
      .then((r) => {
        if (!cancelled) setA(r)
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

  if (error) return <div style={{ padding: 16, color: T.down, fontSize: 12.5 }}>Options analytics failed: {error}</div>
  if (!a) return <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>Loading options chain for {symbol}…</div>
  if (!a.available)
    return (
      <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>
        {a.message ?? `No options analytics for ${symbol}.`}
      </div>
    )

  const em = a.expectedMove30d

  return (
    <div style={{ padding: '12px 16px', fontSize: 12.5 }}>
      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat
          label="ATM IV ~30d"
          value={a.iv30 != null ? (a.iv30 * 100).toFixed(1) + '%' : '—'}
          tip={
            <span>
              Implied volatility of ~30-day at-the-money options — the market's priced-in expectation of annualized
              movement. Higher IV = richer option premiums.
            </span>
          }
        />
        <Stat
          label={`IV Rank (${a.ivDays}d)`}
          value={a.ivRank != null ? a.ivRank.toFixed(0) : '—'}
          color={a.ivRank != null ? (a.ivRank >= 50 ? T.warn : T.text) : T.muted}
          tip={
            <span>
              <b>IV Rank</b> = (current IV − 52-week low) ÷ (52-week high − low) — tastytrade's formula. High rank
              historically favors premium-selling, low rank premium-buying.
              <br />
              <span style={{ color: T.warn }}>
                Based on {a.ivDays} days of locally collected IV history — matures at ~252 days (Alpaca provides no
                historical IV, so the app records it daily).
              </span>
            </span>
          }
        />
        <Stat
          label="IV Percentile"
          value={a.ivPercentile != null ? a.ivPercentile.toFixed(0) + '%' : '—'}
          tip={
            <span>
              % of collected days with IV <i>below</i> today's. Differs from IV Rank after single spikes — showing both
              prevents misleading premium-selling signals (RESEARCH.md §3.1).
            </span>
          }
        />
        <Stat
          label="Realized vol (21d)"
          value={a.rv21 != null ? (a.rv21 * 100).toFixed(1) + '%' : '—'}
          tip={
            <span>
              Annualized close-to-close volatility of the last 21 trading days (total-return bars) — how much the stock
              has ACTUALLY been moving{a.rv63 != null ? `; trailing quarter: ${(a.rv63 * 100).toFixed(1)}%` : ''}. The
              backward-looking twin of implied volatility.
            </span>
          }
        />
        <Stat
          label="IV − RV (VRP)"
          value={a.vrp != null ? `${a.vrp >= 0 ? '+' : ''}${(a.vrp * 100).toFixed(1)} pts` : '—'}
          color={a.vrp != null && a.vrp < 0 ? T.warn : undefined}
          tip={
            <span>
              The <b>variance risk premium</b>: IV30 minus 21-day realized vol. Persistently positive is the documented
              reason option selling has an edge at all — buyers overpay for insurance on average. <b>Negative</b> means
              options are pricing less movement than is actually happening: premium is thin for the risk. This is the
              single best &quot;is premium actually rich?&quot; check — IV Rank compares IV to its own past; VRP compares
              it to reality.
            </span>
          }
        />
        <Stat
          label="Expected move (30d)"
          value={em ? `±${fmtPrice(em.abs)} (${(em.pct * 100).toFixed(1)}%)` : '—'}
          tip={
            <span>
              One-standard-deviation range over ~30 days: price × IV × √(30/365). A <b>statistical ~68% range, not a
              prediction</b> — real markets have fatter tails.
            </span>
          }
        />
        <Stat
          label="25Δ skew (near)"
          value={a.skew25d != null ? `${a.skew25d >= 0 ? '+' : ''}${a.skew25d.toFixed(1)} pts` : '—'}
          color={a.skew25d != null && a.skew25d > 0 ? T.down : T.text}
          tip={
            <span>
              <b>Advanced:</b> 25-delta put IV minus call IV near 30 DTE (the risk-reversal). Positive = puts richer —
              crash-protection demand. Pros read big skew moves as positioning shifts.
            </span>
          }
        />
        <Stat
          label="Naive GEX"
          value={a.gexNaive != null ? Intl.NumberFormat('en', { notation: 'compact' }).format(a.gexNaive) : '—'}
          tip={
            <span>
              <b>Advanced:</b> Σ gamma × OI × 100 (calls +, puts −) — SqueezeMetrics' formula. Positive suggests
              dealer hedging dampens moves; negative amplifies. <b>Dealer positioning is an assumption</b> — pedagogical,
              not a signal. OI comes from Alpaca's contracts endpoint and updates once daily (prior session).
            </span>
          }
        />
        <Stat
          label="Next earnings"
          value={
            earnings
              ? `${fmtDay(earnings.date)} · ${earnings.daysUntil}d${earnings.hour ? ` · ${earnings.hour.toUpperCase()}` : ''}`
              : '—'
          }
          color={earnings && earnings.daysUntil <= 45 ? T.warn : undefined}
          tip={
            <span>
              Next confirmed report (Finnhub calendar; the free tier sees ~1 month out, so "—" doesn't guarantee none).
              BMO = before open, AMC = after close. Front-expiry IV inflates into a report and collapses after it ("IV
              crush") — the classic cause of the term-structure inversion below, and the reason premium sold across an
              earnings date is an event bet, not the standard mechanics.
            </span>
          }
        />
      </div>

      <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, margin: '4px 0 6px' }}>
        Strategy screener — documented practice (~30–45 DTE, ~30Δ), not advice · click a row for the reasoning
        <span style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
          <InfoTip width={360}>
            <span>
              Mechanics per tastytrade's documented approach: enter ~45 days to expiry, sell ~30-delta strikes, manage
              at 50% of max profit or 21 DTE. PoP is the delta approximation (1 − |Δ|): risk-neutral, ignores premium
              received. Mid prices from the free indicative feed can be stale off-hours.
            </span>
          </InfoTip>
        </span>
      </div>
      {a.strategies.length === 0 && <div style={{ color: T.muted }}>No liquid ~30Δ candidates found in the 25–60 DTE window.</div>}
      {earnings && a.strategies.length > 0 && a.strategies.some((s) => s.expiry >= earnings.date) && (
        <div style={{ color: T.warn, fontSize: 11.5, margin: '2px 0 6px' }}>
          ⚠ Earnings {fmtDay(earnings.date)} ({earnings.hour ? HOUR_LABEL[earnings.hour] : 'time TBA'}) lands before
          the {a.strategies[0].expiry} expiry — these credits include event premium; IV crush after the report cuts
          both ways, and a gap can move straight through a strike.
        </div>
      )}
      {a.strategies.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              {['Strategy', 'Expiry (DTE)', 'Strikes', 'Credit', 'Spread', 'Return', 'Annualized', '~PoP', ''].map((h) => (
                <th key={h} style={{ textAlign: 'left', color: T.muted, fontWeight: 600, padding: '4px 8px', borderBottom: `1px solid ${T.border}` }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.strategies.map((s, i) => (
              <React.Fragment key={i}>
                <tr
                  style={{ cursor: 'pointer', background: expanded === i ? T.panelHover : 'transparent' }}
                  title="Click to see the reasoning behind this row"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  <td style={{ padding: '5px 8px', color: T.text, borderBottom: `1px solid ${T.grid}` }}>
                    <span style={{ color: T.accent, marginRight: 6 }}>{expanded === i ? '▾' : '▸'}</span>
                    {s.label}
                  </td>
                  <td style={{ padding: '5px 8px', color: T.text, borderBottom: `1px solid ${T.grid}` }}>
                    {s.expiry} ({s.dte}d)
                  </td>
                  <td style={{ padding: '5px 8px', color: T.text, borderBottom: `1px solid ${T.grid}` }}>{s.strikes}</td>
                  <td style={{ padding: '5px 8px', color: T.up, borderBottom: `1px solid ${T.grid}` }}>{fmtPrice(s.credit)}</td>
                  <td
                    style={{ padding: '5px 8px', color: s.spreadPct != null && s.spreadPct > 0.1 ? T.warn : T.muted, borderBottom: `1px solid ${T.grid}` }}
                    title="Short-leg bid-ask spread as % of mid — what liquidity charges per crossing; wide spreads eat the credit"
                  >
                    {s.spreadPct != null ? (s.spreadPct * 100).toFixed(0) + '%' : '—'}
                  </td>
                  <td style={{ padding: '5px 8px', color: T.text, borderBottom: `1px solid ${T.grid}` }}>
                    {(s.creditPct * 100).toFixed(2)}%
                  </td>
                  <td style={{ padding: '5px 8px', color: T.text, borderBottom: `1px solid ${T.grid}` }}>
                    {(s.annualizedPct * 100).toFixed(1)}%
                  </td>
                  <td style={{ padding: '5px 8px', color: T.text, borderBottom: `1px solid ${T.grid}` }}>
                    {s.pop != null ? (s.pop * 100).toFixed(0) + '%' : '—'}
                  </td>
                  <td style={{ padding: '5px 8px', borderBottom: `1px solid ${T.grid}` }}>
                    <InfoTip width={340}>
                      <span>{s.detail}</span>
                    </InfoTip>
                  </td>
                </tr>
                {expanded === i && (
                  <tr>
                    <td colSpan={9} style={{ padding: '8px 14px 10px 26px', borderBottom: `1px solid ${T.grid}`, background: 'rgba(41,98,255,0.04)' }}>
                      <div style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>
                        Why this row — every number's origin
                      </div>
                      {s.rationale.map((line, j) => (
                        <div key={j} style={{ color: T.text, fontSize: 11.5, lineHeight: 1.55, marginBottom: 4, maxWidth: 900 }}>
                          <span style={{ color: T.accent }}>•</span> {line}
                        </div>
                      ))}
                      {earnings && earnings.date <= s.expiry && (
                        <div style={{ color: T.warn, fontSize: 11.5, lineHeight: 1.55, marginBottom: 4, maxWidth: 900 }}>
                          <span>⚠</span> Event risk — earnings on {fmtDay(earnings.date)} (
                          {earnings.hour ? HOUR_LABEL[earnings.hour] : 'time TBA'}) land before this expiry. The credit
                          includes inflated event premium; IV crush after the report helps a seller, but the gap risk
                          through the strike is exactly what that premium is paying for.
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 18, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: T.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          IV term structure
          <span style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
            <InfoTip width={340}>
              <span>
                <b>Advanced:</b> ATM IV by expiration. Upward-sloping (contango) is normal; inversion — near-term IV
                above far-term — flags event risk, classically an earnings IV spike in the front expiry.
              </span>
            </InfoTip>
          </span>
        </span>
        {sampleTerm(a.termStructure).map((t) => (
            <span key={t.expiry} style={{ color: T.text, fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
              {t.dte}d <span style={{ color: T.accent }}>{((t.atmIv as number) * 100).toFixed(1)}%</span>
            </span>
          ))}
      </div>

      <div style={{ marginTop: 10, color: T.faint, fontSize: 10.5, lineHeight: 1.5 }}>
        {a.caveats.map((c, i) => (
          <div key={i}>• {c}</div>
        ))}
      </div>
    </div>
  )
}
