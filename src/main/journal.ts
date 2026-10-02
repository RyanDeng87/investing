import { getDb, logJob } from './db'
import type { JournalEntry } from '../shared/types'

// Trade journal: the review habit. Thesis is written BEFORE the outcome is
// known; the outcome column gets filled in later — comparing the two is
// where the learning happens. Entries are user trades/notes OR hypotheses:
// falsifiable predictions (author 'user' or 'copilot') with a horizon_date,
// scored against realized prices once due. Manual entries only for trades
// (Fidelity/Robinhood have no read APIs).

function rowToEntry(r: Record<string, unknown>): JournalEntry {
  return {
    id: Number(r.id),
    date: String(r.date),
    symbol: String(r.symbol),
    side: r.side as JournalEntry['side'],
    qty: r.qty == null ? null : Number(r.qty),
    price: r.price == null ? null : Number(r.price),
    account: String(r.account ?? ''),
    thesis: String(r.thesis ?? ''),
    outcome: String(r.outcome ?? ''),
    author: r.author === 'copilot' ? 'copilot' : 'user',
    horizonDate: r.horizon_date == null ? null : String(r.horizon_date),
    status: r.status === 'open' || r.status === 'resolved' ? r.status : '',
    createdAt: String(r.created_at)
  }
}

export function listJournal(): JournalEntry[] {
  return (getDb().prepare('SELECT * FROM journal ORDER BY date DESC, id DESC').all() as Record<string, unknown>[]).map(rowToEntry)
}

interface AddOptions {
  author?: 'user' | 'copilot'
  horizonDate?: string | null
  status?: '' | 'open' | 'resolved'
}

// Inserts and returns the new row id (dates are user-editable, so "newest
// by date" is NOT a reliable way to find what was just inserted).
function insertJournal(raw: Omit<JournalEntry, 'id' | 'createdAt' | 'author' | 'horizonDate' | 'status'>, opts: AddOptions = {}): number {
  const symbol = String(raw?.symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z.]{1,6}$/.test(symbol)) throw new Error(`Invalid symbol "${symbol}".`)
  const side = raw?.side === 'buy' || raw?.side === 'sell' || raw?.side === 'note' ? raw.side : 'note'
  // Fallback uses the LOCAL calendar date ('sv' = ISO format) — UTC would
  // stamp an evening entry with tomorrow's date.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.date ?? '')) ? String(raw.date) : new Date().toLocaleDateString('sv')
  const qty = raw?.qty != null && Number.isFinite(Number(raw.qty)) && Number(raw.qty) > 0 ? Number(raw.qty) : null
  const price = raw?.price != null && Number.isFinite(Number(raw.price)) && Number(raw.price) > 0 ? Number(raw.price) : null
  const horizonDate = opts.horizonDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.horizonDate) ? opts.horizonDate : null
  const info = getDb()
    .prepare(
      'INSERT INTO journal(date, symbol, side, qty, price, account, thesis, outcome, author, horizon_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      date,
      symbol,
      side,
      qty,
      price,
      String(raw?.account ?? '').slice(0, 40),
      String(raw?.thesis ?? '').slice(0, 4000),
      String(raw?.outcome ?? '').slice(0, 4000),
      opts.author === 'copilot' ? 'copilot' : 'user',
      horizonDate,
      horizonDate ? (opts.status ?? 'open') : (opts.status ?? '')
    )
  return Number(info.lastInsertRowid)
}

export function addJournal(raw: Omit<JournalEntry, 'id' | 'createdAt' | 'author' | 'horizonDate' | 'status'>, opts: AddOptions = {}): JournalEntry[] {
  insertJournal(raw, opts)
  return listJournal()
}

// Copilot-facing helper: record a falsifiable prediction with a horizon.
export function logHypothesis(input: {
  symbol: string
  hypothesis: string
  horizonDays: number
  confidence: string
  author: 'user' | 'copilot'
}): JournalEntry {
  const days = Math.min(365, Math.max(5, Math.round(Number(input.horizonDays) || 30)))
  const horizon = new Date(Date.now() + days * 86_400_000).toLocaleDateString('sv')
  const conf = ['low', 'medium', 'high'].includes(input.confidence) ? input.confidence : 'low'
  const id = insertJournal(
    {
      date: new Date().toLocaleDateString('sv'),
      symbol: input.symbol,
      side: 'note',
      qty: null,
      price: null,
      account: '',
      thesis: `[hypothesis · ${conf} confidence · due ${horizon}] ${String(input.hypothesis ?? '').slice(0, 2000)}`,
      outcome: ''
    },
    { author: input.author, horizonDate: horizon, status: 'open' }
  )
  logJob('hypothesis', 'ok', `${input.author} logged ${input.symbol} (${days}d)`)
  const row = getDb().prepare('SELECT * FROM journal WHERE id = ?').get(id) as Record<string, unknown>
  return rowToEntry(row)
}

export function listDueHypotheses(): JournalEntry[] {
  const today = new Date().toLocaleDateString('sv')
  return (
    getDb()
      .prepare("SELECT * FROM journal WHERE status = 'open' AND horizon_date IS NOT NULL AND horizon_date <= ? ORDER BY horizon_date ASC")
      .all(today) as Record<string, unknown>[]
  ).map(rowToEntry)
}

export function resolveEntry(id: number, outcome: string): void {
  getDb().prepare("UPDATE journal SET outcome = ?, status = 'resolved' WHERE id = ?").run(outcome.slice(0, 4000), Number(id))
}

export function updateJournal(id: number, fields: Partial<Pick<JournalEntry, 'thesis' | 'outcome'>>): JournalEntry[] {
  const db = getDb()
  if (typeof fields?.thesis === 'string') db.prepare('UPDATE journal SET thesis = ? WHERE id = ?').run(fields.thesis.slice(0, 4000), Number(id))
  if (typeof fields?.outcome === 'string') db.prepare('UPDATE journal SET outcome = ? WHERE id = ?').run(fields.outcome.slice(0, 4000), Number(id))
  return listJournal()
}

export function removeJournal(id: number): JournalEntry[] {
  getDb().prepare('DELETE FROM journal WHERE id = ?').run(Number(id))
  return listJournal()
}
