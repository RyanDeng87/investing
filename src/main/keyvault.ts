import { safeStorage } from 'electron'
import { getDb } from './db'

export type SecretName = 'alpaca_key_id' | 'alpaca_secret' | 'fmp_key' | 'finnhub_key' | 'anthropic_key' | 'fred_key'

export const SECRET_NAMES: SecretName[] = ['alpaca_key_id', 'alpaca_secret', 'fmp_key', 'finnhub_key', 'anthropic_key', 'fred_key']

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function setSecret(name: SecretName, value: string): void {
  const db = getDb()
  if (!value) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(name)
    return
  }
  // 'raw:' fallback keeps the app usable if DPAPI is broken; the UI surfaces a warning.
  const stored = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(value).toString('base64')
    : 'raw:' + Buffer.from(value, 'utf8').toString('base64')
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(name, stored)
}

export function getSecret(name: SecretName): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(name) as
    | { value: string }
    | undefined
  if (!row) return null
  if (row.value.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(row.value.slice(4), 'base64'))
  }
  if (row.value.startsWith('raw:')) {
    return Buffer.from(row.value.slice(4), 'base64').toString('utf8')
  }
  return null
}

export function hasSecret(name: SecretName): boolean {
  try {
    return getSecret(name) !== null
  } catch {
    return false
  }
}
