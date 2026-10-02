// Replicates getTrackRecord's per-row query pattern at 1-year scale.
const Database = require('better-sqlite3')
const db = new Database(':memory:')
db.exec(`
CREATE TABLE daily_bars_adj (symbol TEXT NOT NULL, date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY (symbol, date));
CREATE TABLE daily_bars (symbol TEXT NOT NULL, date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY (symbol, date));
CREATE TABLE prediction_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
  value REAL, horizon_days INTEGER, meta TEXT);
`)

// 30 symbols + SPY, 5 years (~1260 trading days) of bars each.
const symbols = []
for (let i = 0; i < 30; i++) symbols.push('SYM' + String(i).padStart(2, '0'))
const dates = []
const d = new Date('2021-07-01')
while (dates.length < 1260) {
  const dow = d.getDay()
  if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10))
  d.setDate(d.getDate() + 1)
}
const insBar = db.prepare('INSERT INTO daily_bars_adj(symbol,date,close) VALUES (?,?,?)')
db.transaction(() => {
  for (const s of [...symbols, 'SPY']) for (const dt of dates) insBar.run(s, dt, 100 + Math.random() * 50)
})()

// 1 year of daily snapshots: 250 days x 30 symbols x 3 kinds = 22,500 rows.
const snapDates = dates.slice(700, 950) // 250 days, most matured for 63d, some pending for 252d
const insSnap = db.prepare('INSERT INTO prediction_snapshots(snapshot_date,symbol,kind,value,horizon_days,meta) VALUES (?,?,?,?,?,?)')
db.transaction(() => {
  for (const dt of snapDates)
    for (const s of symbols) {
      insSnap.run(dt, s, 'signal_tilt', Math.random() * 200 - 100, 63, 'label')
      insSnap.run(dt, s, 'buffett_qarp', Math.random() * 100, 252, 'src')
      insSnap.run(dt, s, 'iv_rank', Math.random() * 100, 21, String(0.3))
    }
})()

// Exact forwardReturn from predictions.ts (prepare inside every call, both tables).
function forwardReturn(symbol, fromDate, h) {
  for (const table of ['daily_bars_adj', 'daily_bars']) {
    const rows = db
      .prepare(`SELECT close FROM ${table} WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT ?`)
      .all(symbol, fromDate, h + 1)
    if (rows.length >= h + 1 && rows[0].close > 0) return rows[h].close / rows[0].close - 1
    if (rows.length > 0) return null
  }
  return null
}

const t0 = process.hrtime.bigint()
let queries = 0
for (const kind of ['signal_tilt', 'buffett_qarp']) {
  const rows = db.prepare('SELECT snapshot_date, symbol, value, horizon_days, meta FROM prediction_snapshots WHERE kind = ? ORDER BY snapshot_date ASC').all(kind)
  for (const r of rows) {
    forwardReturn(r.symbol, r.snapshot_date, r.horizon_days); queries++
    forwardReturn('SPY', r.snapshot_date, r.horizon_days); queries++
  }
}
// iv_rank loop: prepare inside the loop, one .get each (iv_snapshots stand-in: reuse bars table shape)
db.exec(`CREATE TABLE iv_snapshots (symbol TEXT, snapshot_date TEXT, atm_iv_30d REAL, UNIQUE(symbol, snapshot_date))`)
db.transaction(() => {
  const ins = db.prepare('INSERT INTO iv_snapshots(symbol,snapshot_date,atm_iv_30d) VALUES (?,?,?)')
  for (const s of symbols) for (const dt of dates.slice(600)) ins.run(s, dt, 0.2 + Math.random() * 0.3)
})()
const ivRows = db.prepare('SELECT snapshot_date, symbol, value, horizon_days, meta FROM prediction_snapshots WHERE kind = ? ORDER BY snapshot_date ASC').all('iv_rank')
for (const r of ivRows) {
  db.prepare("SELECT atm_iv_30d FROM iv_snapshots WHERE symbol = ? AND atm_iv_30d IS NOT NULL AND snapshot_date >= date(?, '+' || ? || ' days') ORDER BY snapshot_date ASC LIMIT 1")
    .get(r.symbol, r.snapshot_date, Math.round(r.horizon_days * 1.45))
  queries++
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6
console.log(`as-written: ${queries} forwardReturn/iv calls, ${ms.toFixed(0)} ms`)

// Memoized variant: cache (symbol,date,h) results + hoisted prepares.
const t1 = process.hrtime.bigint()
const cache = new Map()
const stmts = {
  adj: db.prepare('SELECT close FROM daily_bars_adj WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT ?'),
  raw: db.prepare('SELECT close FROM daily_bars WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT ?')
}
function fwdMemo(symbol, fromDate, h) {
  const k = symbol + '|' + fromDate + '|' + h
  if (cache.has(k)) return cache.get(k)
  let out = null
  for (const st of [stmts.adj, stmts.raw]) {
    const rows = st.all(symbol, fromDate, h + 1)
    if (rows.length >= h + 1 && rows[0].close > 0) { out = rows[h].close / rows[0].close - 1; break }
    if (rows.length > 0) break
  }
  cache.set(k, out)
  return out
}
for (const kind of ['signal_tilt', 'buffett_qarp']) {
  const rows = db.prepare('SELECT snapshot_date, symbol, value, horizon_days, meta FROM prediction_snapshots WHERE kind = ? ORDER BY snapshot_date ASC').all(kind)
  for (const r of rows) { fwdMemo(r.symbol, r.snapshot_date, r.horizon_days); fwdMemo('SPY', r.snapshot_date, r.horizon_days) }
}
const ivStmt = db.prepare("SELECT atm_iv_30d FROM iv_snapshots WHERE symbol = ? AND atm_iv_30d IS NOT NULL AND snapshot_date >= date(?, '+' || ? || ' days') ORDER BY snapshot_date ASC LIMIT 1")
for (const r of ivRows) ivStmt.get(r.symbol, r.snapshot_date, Math.round(r.horizon_days * 1.45))
const ms1 = Number(process.hrtime.bigint() - t1) / 1e6
console.log(`memoized+hoisted: ${ms1.toFixed(0)} ms`)
