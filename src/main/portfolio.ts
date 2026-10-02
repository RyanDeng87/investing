import { getDb } from './db'
import { getSecret } from './keyvault'
import { fetchQuotes } from './alpaca'
import { scoreSymbol } from './scoring'
import { getSignals } from './signals'
import { getStance } from './stance'
import type { PortfolioPosition, PortfolioReport, PositionInput } from '../shared/types'

// Manual portfolio — what the user ACTUALLY owns, entered by hand because
// Fidelity and Robinhood expose no read API for individuals (verified 2026-07;
// aggregators like SnapTrade are the future upgrade path). This is the piece
// that turns per-symbol analysis into "is MY portfolio okay": weights,
// concentration flags, and each holding's engine readings in one table.

interface PosRow {
  id: number
  symbol: string
  qty: number
  cost_basis: number | null
  account: string
}

const DISCLOSURES = [
  'A manual snapshot, not a broker sync — quantities and cost bases are only as current as your last edit (Fidelity/Robinhood have no read API for individuals).',
  'Prices are IEX (free feed, ~8–10% of consolidated volume) and can differ slightly from your brokerage statement.',
  'The QARP/tilt/stance chips are the same engines as the bottom tabs — one lens repeated, not independent opinions. Nothing here is advice, and the app cannot see taxes or lots.'
]

function validSymbol(s: string): boolean {
  return /^[A-Z.]{1,6}$/.test(s)
}

function listRows(): PosRow[] {
  return getDb()
    .prepare('SELECT id, symbol, qty, cost_basis, account FROM positions ORDER BY symbol, account')
    .all() as PosRow[]
}

export function addPosition(input: PositionInput): void {
  const sym = String(input.symbol ?? '').trim().toUpperCase()
  const qty = Number(input.qty)
  const cost = input.costBasis == null ? null : Number(input.costBasis)
  if (!validSymbol(sym)) throw new Error(`invalid symbol: ${sym}`)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('quantity must be a positive number')
  if (cost != null && (!Number.isFinite(cost) || cost < 0)) throw new Error('cost basis must be a non-negative number')
  getDb()
    .prepare('INSERT INTO positions(symbol, qty, cost_basis, account) VALUES (?, ?, ?, ?)')
    .run(sym, qty, cost, String(input.account ?? '').trim().toLowerCase().slice(0, 24))
}

export function updatePosition(id: number, fields: Partial<PositionInput>): void {
  const row = getDb().prepare('SELECT * FROM positions WHERE id = ?').get(id) as PosRow | undefined
  if (!row) throw new Error(`no position #${id}`)
  if (fields.qty !== undefined) {
    const q = Number(fields.qty)
    if (!Number.isFinite(q) || q <= 0) throw new Error('quantity must be a positive number')
    getDb().prepare('UPDATE positions SET qty = ? WHERE id = ?').run(q, id)
  }
  if (fields.costBasis !== undefined) {
    const c = fields.costBasis == null ? null : Number(fields.costBasis)
    if (c != null && (!Number.isFinite(c) || c < 0)) throw new Error('cost basis must be a non-negative number')
    getDb().prepare('UPDATE positions SET cost_basis = ? WHERE id = ?').run(c, id)
  }
  if (fields.account !== undefined) {
    getDb().prepare('UPDATE positions SET account = ? WHERE id = ?').run(String(fields.account ?? '').trim().toLowerCase().slice(0, 24), id)
  }
}

export function removePosition(id: number): void {
  getDb().prepare('DELETE FROM positions WHERE id = ?').run(id)
}

function lastTwoCloses(symbol: string): { close: number | null; prev: number | null } {
  const rows = getDb()
    .prepare('SELECT close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT 2')
    .all(symbol) as { close: number }[]
  return { close: rows[0]?.close ?? null, prev: rows[1]?.close ?? null }
}

function sectorOf(symbol: string): string {
  const row = getDb()
    .prepare("SELECT payload FROM fundamentals_snapshots WHERE symbol = ? AND source = 'fmp:profile' ORDER BY fetched_at DESC, id DESC LIMIT 1")
    .get(symbol) as { payload: string } | undefined
  if (!row) return ''
  try {
    const rec = JSON.parse(row.payload)
    const obj = Array.isArray(rec) ? rec[0] : rec
    const isEtf = obj?.isEtf === true || obj?.isFund === true
    return isEtf ? 'ETF/fund' : String(obj?.sector ?? '')
  } catch {
    return ''
  }
}

export async function getPortfolioReport(): Promise<PortfolioReport> {
  const asOf = new Date().toISOString()
  const rows = listRows()
  if (rows.length === 0) {
    return {
      available: false,
      asOf,
      positions: [],
      totalValue: 0,
      totalCost: null,
      totalGainAbs: null,
      totalGainPct: null,
      dayGainAbs: null,
      dayGainPct: null,
      warnings: [],
      disclosures: DISCLOSURES,
      message: 'No positions yet — add what you actually own (symbol, shares, average cost, account) and the app will keep it priced with each engine’s read alongside.'
    }
  }

  const symbols = [...new Set(rows.map((r) => r.symbol))]

  // Live quotes when keys exist; cached closes otherwise. Never fail the view.
  const quotes = new Map<string, { price: number | null; prevClose: number | null }>()
  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  if (keyId && secret) {
    try {
      for (const q of await fetchQuotes(symbols, { keyId, secret })) quotes.set(q.symbol, { price: q.price, prevClose: q.prevClose })
    } catch {
      /* fall through to cached closes */
    }
  }

  // Engine reads per distinct symbol, best-effort and parallel (all cached
  // main-side: signals 6h, score 10min, stance derives from both).
  const engine = new Map<string, { qarp: number | null; tilt: number | null; stance: PortfolioPosition['stance'] }>()
  await Promise.all(
    symbols.map(async (s) => {
      let qarp: number | null = null
      let tilt: number | null = null
      let stance: PortfolioPosition['stance'] = null
      try {
        const sc = scoreSymbol(s)
        if (sc.available) qarp = sc.qarp
      } catch {
        /* keep null */
      }
      try {
        const sig = await getSignals(s)
        if (sig.confidence !== 'none') tilt = sig.tilt
      } catch {
        /* keep null */
      }
      try {
        const st = await getStance(s)
        if (st.available) stance = st.action
      } catch {
        /* keep null */
      }
      engine.set(s, { qarp, tilt, stance })
    })
  )

  const positions: PortfolioPosition[] = rows.map((r) => {
    const q = quotes.get(r.symbol)
    const cached = lastTwoCloses(r.symbol)
    const price = q?.price ?? cached.close
    const prevClose = q?.prevClose ?? (q?.price != null ? cached.close : cached.prev)
    const marketValue = price != null ? r.qty * price : null
    const e = engine.get(r.symbol)
    return {
      id: r.id,
      symbol: r.symbol,
      qty: r.qty,
      costBasis: r.cost_basis,
      account: r.account,
      price,
      prevClose,
      marketValue,
      dayPct: price != null && prevClose ? price / prevClose - 1 : null,
      gainPct: price != null && r.cost_basis ? price / r.cost_basis - 1 : null,
      gainAbs: price != null && r.cost_basis != null ? (price - r.cost_basis) * r.qty : null,
      weight: null, // filled below once the total is known
      qarp: e?.qarp ?? null,
      tilt: e?.tilt ?? null,
      stance: e?.stance ?? null,
      sector: sectorOf(r.symbol)
    }
  })

  const totalValue = positions.reduce((a, p) => a + (p.marketValue ?? 0), 0)
  for (const p of positions) p.weight = p.marketValue != null && totalValue > 0 ? p.marketValue / totalValue : null

  const allCosted = positions.every((p) => p.costBasis != null && p.marketValue != null)
  const totalCost = allCosted ? positions.reduce((a, p) => a + (p.costBasis as number) * p.qty, 0) : null
  const totalGainAbs = totalCost != null ? totalValue - totalCost : null
  const totalGainPct = totalCost != null && totalCost > 0 ? totalValue / totalCost - 1 : null

  let dayBase = 0
  let dayGainAbs: number | null = 0
  for (const p of positions) {
    if (p.price != null && p.prevClose != null) {
      dayBase += p.qty * p.prevClose
      dayGainAbs = (dayGainAbs as number) + p.qty * (p.price - p.prevClose)
    }
  }
  if (dayBase === 0) dayGainAbs = null
  const dayGainPct = dayGainAbs != null && dayBase > 0 ? dayGainAbs / dayBase : null

  // Concentration flags — merged across accounts (the risk doesn't care which
  // account holds it). Broad-market ETFs still count: a 60% QQQ position is a
  // deliberate bet, and the flag just says so out loud.
  const warnings: string[] = []
  const bySymbol = new Map<string, number>()
  for (const p of positions) if (p.weight != null) bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + p.weight)
  for (const [s, w] of [...bySymbol.entries()].sort((a, b) => b[1] - a[1])) {
    if (w > 0.25) warnings.push(`${s} is ${(w * 100).toFixed(0)}% of the portfolio — beyond the ~25% where single-name risk starts dominating diversified outcomes.`)
  }
  const bySector = new Map<string, number>()
  for (const p of positions) {
    if (p.weight != null && p.sector && p.sector !== 'ETF/fund') bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + p.weight)
  }
  for (const [sec, w] of [...bySector.entries()].sort((a, b) => b[1] - a[1])) {
    if (w > 0.4) warnings.push(`${sec} is ${(w * 100).toFixed(0)}% of the portfolio (single stocks only, ETFs not looked through) — sector drawdowns will hit most of it at once.`)
  }
  const missingCost = positions.filter((p) => p.costBasis == null).length
  if (missingCost > 0) warnings.push(`${missingCost} position${missingCost === 1 ? ' is' : 's are'} missing a cost basis — gains show as n/a until filled in.`)

  return {
    available: true,
    asOf,
    positions,
    totalValue,
    totalCost,
    totalGainAbs,
    totalGainPct,
    dayGainAbs,
    dayGainPct,
    warnings,
    disclosures: DISCLOSURES
  }
}
