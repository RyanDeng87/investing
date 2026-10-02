// TradingView-inspired dark theme tokens. Up/down pair validated for CVD
// separation and 3:1 contrast against the surface (dataviz palette validator).
export const T = {
  bg: '#131722',
  panel: '#1e222d',
  panelHover: '#2a2e39',
  border: '#2a2e39',
  text: '#d1d4dc',
  muted: '#787b86',
  faint: '#50535e',
  up: '#26a69a',
  down: '#ef5350',
  accent: '#2962ff',
  warn: '#f7a600',
  grid: '#1c212e',
  crosshair: '#758696'
} as const

export function pctColor(pct: number | null): string {
  if (pct == null) return T.muted
  return pct >= 0 ? T.up : T.down
}

export function fmtPct(pct: number | null, digits = 2): string {
  if (pct == null) return '—'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`
}

export function fmtPrice(p: number | null): string {
  if (p == null) return '—'
  return p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p.toFixed(2)
}
