import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { UNIVERSE_SEED } from './universe-seed'

// Schema v1. fundamentals_snapshots is append-only on purpose: it accumulates
// point-in-time data that later makes backtests honest. Never prune it.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  favorite INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS iv_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  spot REAL,
  atm_iv_30d REAL,
  expirations TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, snapshot_date)
);
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS fundamentals_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_symbol ON fundamentals_snapshots(symbol, fetched_at);
CREATE TABLE IF NOT EXISTS jobs_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS universe (
  symbol TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS backtest_trials (
  config_hash TEXT PRIMARY KEY,
  first_run TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS daily_bars_adj (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS selftest_anchors (
  config_hash TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  anchor_date TEXT NOT NULL,
  expectation_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  threshold REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at TEXT,
  last_value REAL
);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL,
  price REAL,
  account TEXT NOT NULL DEFAULT '',
  thesis TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'user',
  horizon_date TEXT,
  status TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  value REAL NOT NULL,
  horizon_days INTEGER NOT NULL,
  meta TEXT,
  UNIQUE(snapshot_date, symbol, kind)
);
CREATE TABLE IF NOT EXISTS news_digests (
  symbol TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fear_greed (
  date TEXT PRIMARY KEY,
  score REAL NOT NULL,
  rating TEXT NOT NULL DEFAULT '',
  components TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  qty REAL NOT NULL,
  cost_basis REAL,
  account TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

const DEFAULT_WATCHLIST = ['QQQ', 'SPY', 'XLK', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AMD']

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    const file = join(app.getPath('userData'), 'investing.db')
    db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA)
    // Migration for databases created before the favorites feature.
    try {
      db.exec('ALTER TABLE watchlist ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0')
    } catch {
      /* column already exists */
    }
    // Migrations for journals created before hypothesis tracking.
    for (const ddl of [
      "ALTER TABLE journal ADD COLUMN author TEXT NOT NULL DEFAULT 'user'",
      'ALTER TABLE journal ADD COLUMN horizon_date TEXT',
      "ALTER TABLE journal ADD COLUMN status TEXT NOT NULL DEFAULT ''"
    ]) {
      try {
        db.exec(ddl)
      } catch {
        /* column already exists */
      }
    }
    const count = db.prepare('SELECT COUNT(*) AS c FROM watchlist').get() as { c: number }
    if (count.c === 0) {
      const insert = db.prepare('INSERT INTO watchlist(symbol) VALUES (?)')
      for (const s of DEFAULT_WATCHLIST) insert.run(s)
    }
    const uCount = db.prepare('SELECT COUNT(*) AS c FROM universe').get() as { c: number }
    if (uCount.c === 0) {
      const insert = db.prepare('INSERT OR IGNORE INTO universe(symbol) VALUES (?)')
      for (const s of UNIVERSE_SEED) insert.run(s)
    }
  }
  return db
}

export function logJob(job: string, status: string, detail?: string): void {
  getDb().prepare('INSERT INTO jobs_log(job, status, detail) VALUES (?, ?, ?)').run(job, status, detail ?? null)
}
