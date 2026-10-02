import { getDb, logJob } from './db'
import { getSecret } from './keyvault'
import type { MacroReport, MacroSeries } from '../shared/types'

// FRED macro context (free API key): rates / inflation / dollar index — the
// backdrop for the gold & currency focus panels. Cached 12h; macro moves slowly.

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'
const TTL_MS = 12 * 60 * 60 * 1000

const SERIES: { id: string; label: string; units: string; yoy?: boolean; windowDays: number }[] = [
  { id: 'DFF', label: 'Fed funds rate', units: '%', windowDays: 460 },
  { id: 'DGS10', label: '10y Treasury yield', units: '%', windowDays: 460 },
  // CPI YoY-of-a-year-ago needs ~25 monthly observations → ~800-day window.
  { id: 'CPIAUCSL', label: 'CPI inflation (YoY)', units: '%', yoy: true, windowDays: 830 },
  { id: 'DTWEXBGS', label: 'Dollar index (broad)', units: '', windowDays: 460 }
]

interface Obs {
  date: string
  value: string
}

async function fetchSeries(id: string, key: string, windowDays: number): Promise<Obs[]> {
  const url = new URL(FRED_BASE)
  url.searchParams.set('series_id', id)
  url.searchParams.set('api_key', key)
  url.searchParams.set('file_type', 'json')
  const start = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10)
  url.searchParams.set('observation_start', start)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`FRED ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const j = (await res.json()) as { observations?: Obs[] }
  return (j.observations ?? []).filter((o) => o.value !== '.')
}

// Nearest observation to a target date, or null if none within tolerance —
// the '.'-filter above de-holes the array, so index arithmetic is unsafe.
function obsNear(obs: Obs[], targetMs: number, tolDays: number): number | null {
  let best: number | null = null
  let bestGap = Infinity
  for (const o of obs) {
    const gap = Math.abs(Date.parse(o.date) - targetMs)
    if (gap < bestGap) {
      bestGap = gap
      best = Number(o.value)
    }
  }
  if (best == null || !Number.isFinite(best) || bestGap > tolDays * 86_400_000) return null
  return best
}

function latestAndYearAgo(obs: Obs[]): { latest: number; date: string; yearAgo: number | null } | null {
  if (obs.length === 0) return null
  const last = obs[obs.length - 1]
  const latest = Number(last.value)
  if (!Number.isFinite(latest)) return null
  // Only trust a "year ago" point within ~5 weeks of the target date.
  const yearAgo = obsNear(obs, Date.parse(last.date) - 365 * 86_400_000, 37)
  return { latest, date: last.date, yearAgo }
}

// CPI arrives as an index level; the number anyone recognizes is YoY %.
// All lookups are BY DATE — a missing month (e.g. a delayed report) must
// yield null, not silently stretch the "12-month" change to 13 months.
function cpiYoY(obs: Obs[]): { latest: number; date: string; yearAgo: number | null } | null {
  if (obs.length === 0) return null
  const last = obs[obs.length - 1]
  const lastIdx = Number(last.value)
  if (!Number.isFinite(lastIdx)) return null
  const lastMs = Date.parse(last.date)
  const YEAR = 365.25 * 86_400_000
  const yoyAt = (endIdx: number | null, startIdx: number | null): number | null =>
    endIdx != null && startIdx != null && startIdx > 0 ? Math.round((endIdx / startIdx - 1) * 1000) / 10 : null
  const latest = yoyAt(lastIdx, obsNear(obs, lastMs - YEAR, 20))
  if (latest == null) return null
  const yearAgo = yoyAt(obsNear(obs, lastMs - YEAR, 20), obsNear(obs, lastMs - 2 * YEAR, 20))
  return { latest, date: last.date, yearAgo }
}

export async function getMacro(force = false): Promise<MacroReport> {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('fred_macro') as { value: string } | undefined
  if (row && !force) {
    try {
      const cached = JSON.parse(row.value) as { at: number; series: MacroSeries[] }
      if (Date.now() - cached.at < TTL_MS) {
        return { available: true, series: cached.series, asOf: new Date(cached.at).toISOString() }
      }
    } catch {
      /* regenerate */
    }
  }
  const key = getSecret('fred_key')
  if (!key) {
    return { available: false, series: [], asOf: '', message: 'Add a free FRED API key in Settings for rates/inflation/dollar context.' }
  }
  const series: MacroSeries[] = []
  let failed = 0
  for (const s of SERIES) {
    try {
      const obs = await fetchSeries(s.id, key, s.windowDays)
      const v = s.yoy ? cpiYoY(obs) : latestAndYearAgo(obs)
      if (v) series.push({ id: s.id, label: s.label, units: s.units, latest: v.latest, date: v.date, yearAgo: v.yearAgo })
    } catch (e) {
      failed++
      logJob('fred', 'error', `${s.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (series.length === 0) {
    return { available: false, series: [], asOf: '', message: `FRED fetch failed for all series${failed ? ' — check the key' : ''}.` }
  }
  const at = Date.now()
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'fred_macro',
    JSON.stringify({ at, series })
  )
  return { available: true, series, asOf: new Date(at).toISOString() }
}
