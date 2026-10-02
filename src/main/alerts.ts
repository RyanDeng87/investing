import { Notification } from 'electron'
import { getDb, logJob } from './db'
import { getSecret } from './keyvault'
import { fetchQuotes } from './alpaca'
import { ivRank370 } from './predictions'
import type { AlertKind, AlertRule } from '../shared/types'

// Price/IV alerts: one-shot threshold checks. Checked when the app polls
// quotes (~minutely while open) and once per collector run (daily, so a
// closed app still catches IV-rank triggers the next session). A fired rule
// deactivates itself — re-arm manually; no notification spam.

const KINDS: AlertKind[] = ['price_above', 'price_below', 'iv_rank_above', 'iv_rank_below']

function rowToRule(r: Record<string, unknown>): AlertRule {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    kind: r.kind as AlertKind,
    threshold: Number(r.threshold),
    active: Number(r.active) === 1,
    createdAt: String(r.created_at),
    firedAt: r.fired_at == null ? null : String(r.fired_at),
    lastValue: r.last_value == null ? null : Number(r.last_value)
  }
}

export function listAlerts(): AlertRule[] {
  return (getDb().prepare('SELECT * FROM alerts ORDER BY active DESC, id DESC').all() as Record<string, unknown>[]).map(rowToRule)
}

export function addAlert(raw: { symbol: string; kind: AlertKind; threshold: number }): AlertRule[] {
  const symbol = String(raw?.symbol ?? '').trim().toUpperCase()
  const threshold = Number(raw?.threshold)
  if (!/^[A-Z.]{1,6}$/.test(symbol)) throw new Error(`Invalid symbol "${symbol}".`)
  if (!KINDS.includes(raw?.kind)) throw new Error(`Invalid alert kind.`)
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('Threshold must be a positive number.')
  getDb().prepare('INSERT INTO alerts(symbol, kind, threshold) VALUES (?, ?, ?)').run(symbol, raw.kind, threshold)
  return listAlerts()
}

export function removeAlert(id: number): AlertRule[] {
  getDb().prepare('DELETE FROM alerts WHERE id = ?').run(Number(id))
  return listAlerts()
}

function fire(rule: AlertRule, value: number, label: string): void {
  const db = getDb()
  db.prepare('UPDATE alerts SET active = 0, fired_at = datetime(\'now\'), last_value = ? WHERE id = ?').run(value, rule.id)
  logJob('alert', 'ok', `${rule.symbol} ${rule.kind} ${rule.threshold} fired at ${value}`)
  try {
    if (Notification.isSupported()) {
      new Notification({ title: `${rule.symbol} alert`, body: label }).show()
    }
  } catch {
    /* headless collector run — the job log still records it */
  }
}

// Check price alerts against live quotes. Called from the renderer's quote
// poll (main-side) and the collector.
export async function checkPriceAlerts(): Promise<void> {
  const db = getDb()
  const rules = (db.prepare("SELECT * FROM alerts WHERE active = 1 AND kind IN ('price_above','price_below')").all() as Record<string, unknown>[]).map(rowToRule)
  if (rules.length === 0) return
  const keyId = getSecret('alpaca_key_id')
  const secret = getSecret('alpaca_secret')
  if (!keyId || !secret) return
  const symbols = [...new Set(rules.map((r) => r.symbol))]
  try {
    const quotes = await fetchQuotes(symbols, { keyId, secret })
    const priceOf = new Map(quotes.map((q) => [q.symbol, q.price]))
    for (const rule of rules) {
      const price = priceOf.get(rule.symbol)
      if (price == null) continue
      db.prepare('UPDATE alerts SET last_value = ? WHERE id = ?').run(price, rule.id)
      if (rule.kind === 'price_above' && price >= rule.threshold) {
        fire(rule, price, `Price ${price.toFixed(2)} crossed above ${rule.threshold}`)
      } else if (rule.kind === 'price_below' && price <= rule.threshold) {
        fire(rule, price, `Price ${price.toFixed(2)} crossed below ${rule.threshold}`)
      }
    }
  } catch (e) {
    logJob('alert', 'error', e instanceof Error ? e.message : String(e))
  }
}

// Check IV-rank alerts against the freshest IV snapshot + history. Called
// after the collector writes today's snapshots.
export function checkIvAlerts(): void {
  const db = getDb()
  const rules = (db.prepare("SELECT * FROM alerts WHERE active = 1 AND kind IN ('iv_rank_above','iv_rank_below')").all() as Record<string, unknown>[]).map(rowToRule)
  for (const rule of rules) {
    // Shared 370-day-window computation (predictions.ts) — alerts must fire
    // against the same IV Rank the Options tab displays.
    const iv = ivRank370(rule.symbol)
    if (!iv) continue // IV Rank meaningless on a cold history
    db.prepare('UPDATE alerts SET last_value = ? WHERE id = ?').run(iv.rank, rule.id)
    if (rule.kind === 'iv_rank_above' && iv.rank >= rule.threshold) {
      fire(rule, iv.rank, `IV Rank ${iv.rank.toFixed(0)} crossed above ${rule.threshold} (${iv.days}d history)`)
    } else if (rule.kind === 'iv_rank_below' && iv.rank <= rule.threshold) {
      fire(rule, iv.rank, `IV Rank ${iv.rank.toFixed(0)} crossed below ${rule.threshold} (${iv.days}d history)`)
    }
  }
}
