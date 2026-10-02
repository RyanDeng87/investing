import { ipcMain, shell } from 'electron'
import { getDb } from './db'
import { encryptionAvailable, getSecret, hasSecret, SECRET_NAMES, setSecret, type SecretName } from './keyvault'
import { runCollector } from './collector'
import { getCollectorSchedule, removeCollectorSchedule, setCollectorSchedule } from './scheduler'
import { getBars, getIntradayBars } from './bars'
import { crawlFundamentals, getCompanyProfile } from './fmp'
import { getStance } from './stance'
import { getFearGreed } from './feargreed'
import { getReverseDcf } from './valuation'
import { addPosition, getPortfolioReport, removePosition, updatePosition } from './portfolio'
import type { PositionInput } from '../shared/types'
import { fetchQuotes } from './alpaca'
import { scoreSymbol, invalidateScoreCache, qarpLeaderboard as buildQarpLeaderboard } from './scoring'
import { backfillEdgar } from './edgar'
import { getSignals, invalidateSignalsCache } from './signals'
import { getOptionsAnalytics } from './options'
import { getNextEarnings } from './earnings'
import { getDiscovery } from './discovery'
import { runBacktest, runBootstrap } from './backtest'
import { cancelOrder, getPaperHistory, getPaperSnapshot, placePaperOrder } from './paper'
import { getSelfTest } from './selftest'
import { askCopilot, getMarketBrief, getNewsDigest, getRetrospective, reviewDueHypotheses } from './llm'
import { getTrackRecord } from './predictions'
import { getMacro } from './fred'
import { addAlert, checkPriceAlerts, listAlerts, removeAlert } from './alerts'
import { addJournal, listJournal, removeJournal, updateJournal } from './journal'
import { getNews } from './news'
import type { AlertKind, BacktestConfig, CopilotTurn, JournalEntry, PaperOrderInput } from '../shared/types'
import { getStreamStatus, refreshStreamSubscriptions, restartStream, setActiveSymbol } from './stream'
import type { KeyStatus, QuoteRow, WatchItem } from '../shared/types'

function listWatchlist(): WatchItem[] {
  return (
    getDb().prepare('SELECT symbol, favorite FROM watchlist ORDER BY symbol').all() as {
      symbol: string
      favorite: number
    }[]
  ).map((r) => ({ symbol: r.symbol, favorite: r.favorite === 1 }))
}

function cleanSymbol(symbol: unknown): string {
  return String(symbol ?? '').trim().toUpperCase()
}

let lastAlertSweep = 0

export function registerIpc(): void {
  ipcMain.handle('keys:status', (): KeyStatus => ({
    alpacaKeyId: hasSecret('alpaca_key_id'),
    alpacaSecret: hasSecret('alpaca_secret'),
    fmpKey: hasSecret('fmp_key'),
    finnhubKey: hasSecret('finnhub_key'),
    anthropicKey: hasSecret('anthropic_key'),
    fredKey: hasSecret('fred_key'),
    encryptionAvailable: encryptionAvailable()
  }))

  ipcMain.handle('keys:set', (_e, name: string, value: string) => {
    if (!SECRET_NAMES.includes(name as SecretName)) throw new Error(`unknown key name: ${name}`)
    setSecret(name as SecretName, String(value ?? '').trim())
    restartStream() // keys changed — clear any auth failure and reconnect fresh
    invalidateSignalsCache() // degraded no-key reports must not linger
  })

  ipcMain.handle('watchlist:list', () => listWatchlist())

  ipcMain.handle('watchlist:add', (_e, symbol: string) => {
    const s = cleanSymbol(symbol)
    if (/^[A-Z.]{1,6}$/.test(s)) {
      getDb().prepare('INSERT OR IGNORE INTO watchlist(symbol) VALUES (?)').run(s)
    }
    return listWatchlist()
  })

  ipcMain.handle('watchlist:remove', (_e, symbol: string) => {
    getDb().prepare('DELETE FROM watchlist WHERE symbol = ?').run(cleanSymbol(symbol))
    refreshStreamSubscriptions()
    return listWatchlist()
  })

  ipcMain.handle('watchlist:favorite', (_e, symbol: string, favorite: boolean) => {
    getDb().prepare('UPDATE watchlist SET favorite = ? WHERE symbol = ?').run(favorite ? 1 : 0, cleanSymbol(symbol))
    refreshStreamSubscriptions()
    return listWatchlist()
  })

  ipcMain.handle('collector:run', () => runCollector())

  ipcMain.handle('schedule:get', () => getCollectorSchedule())

  ipcMain.handle('schedule:set', (_e, input: { enabled: boolean; days: string[]; time: string }) =>
    setCollectorSchedule(input)
  )

  ipcMain.handle('schedule:remove', () => removeCollectorSchedule())

  ipcMain.handle('crawl:run', async () => {
    const result = await crawlFundamentals()
    const edgar = await backfillEdgar()
    invalidateScoreCache()
    if (edgar.symbols.length > 0) {
      result.message = `${result.message ? result.message + ' · ' : ''}EDGAR backfill: ${edgar.symbols.join(', ')}`
    }
    return result
  })

  ipcMain.handle('bars:get', (_e, symbol: string) => getBars(cleanSymbol(symbol)))

  ipcMain.handle('bars:intraday', (_e, symbol: string, span?: string) =>
    getIntradayBars(cleanSymbol(symbol), span === '1W' ? '1W' : '1D')
  )

  ipcMain.handle('score:get', (_e, symbol: string) => scoreSymbol(cleanSymbol(symbol)))

  ipcMain.handle('signals:get', (_e, symbol: string) => getSignals(cleanSymbol(symbol)))

  ipcMain.handle('options:get', (_e, symbol: string) => getOptionsAnalytics(cleanSymbol(symbol)))

  ipcMain.handle('earnings:next', (_e, symbol: string) => getNextEarnings(cleanSymbol(symbol)))

  ipcMain.handle('discovery:get', (_e, force?: boolean) => getDiscovery(force === true))

  ipcMain.handle('backtest:run', (_e, config: BacktestConfig) => runBacktest(config))

  ipcMain.handle('backtest:bootstrap', (_e, config: BacktestConfig) => runBootstrap(config))

  ipcMain.handle('paper:snapshot', () => getPaperSnapshot())

  ipcMain.handle('paper:place', (_e, input: PaperOrderInput) => placePaperOrder(input))

  ipcMain.handle('paper:cancel', (_e, orderId: string) => cancelOrder(orderId))

  ipcMain.handle('paper:history', (_e, period?: string) =>
    getPaperHistory(period === '3M' ? '3M' : period === '1A' ? '1A' : '1M')
  )

  ipcMain.handle('selftest:get', () => getSelfTest())

  ipcMain.handle('copilot:ask', (_e, symbol: string, question: string, history: CopilotTurn[]) =>
    askCopilot(cleanSymbol(symbol), String(question ?? ''), Array.isArray(history) ? history : [])
  )

  ipcMain.handle('brief:get', (_e, force?: boolean) => getMarketBrief(force === true))

  ipcMain.handle('macro:get', (_e, force?: boolean) => getMacro(force === true))

  ipcMain.handle('qarp:leaderboard', () => buildQarpLeaderboard())

  ipcMain.handle('alerts:list', () => listAlerts())

  ipcMain.handle('alerts:add', (_e, rule: { symbol: string; kind: AlertKind; threshold: number }) => addAlert(rule))

  ipcMain.handle('alerts:remove', (_e, id: number) => removeAlert(id))

  ipcMain.handle('journal:list', () => listJournal())

  ipcMain.handle('journal:add', (_e, entry: Omit<JournalEntry, 'id' | 'createdAt'>) => addJournal(entry))

  ipcMain.handle('journal:update', (_e, id: number, fields: Partial<Pick<JournalEntry, 'thesis' | 'outcome'>>) =>
    updateJournal(id, fields)
  )

  ipcMain.handle('journal:remove', (_e, id: number) => removeJournal(id))

  ipcMain.handle('journal:reviewDue', () => reviewDueHypotheses())

  ipcMain.handle('predictions:trackRecord', () => getTrackRecord())

  ipcMain.handle('predictions:retro', (_e, force?: boolean) => getRetrospective(force === true))

  ipcMain.handle('news:digest', (_e, symbol: string, force?: boolean) => getNewsDigest(cleanSymbol(symbol), force === true))

  ipcMain.handle('news:get', (_e, symbol: string) => getNews(cleanSymbol(symbol)))

  ipcMain.handle('profile:get', (_e, symbol: string) => getCompanyProfile(cleanSymbol(symbol)))

  ipcMain.handle('stance:get', (_e, symbol: string) => getStance(cleanSymbol(symbol)))

  ipcMain.handle('feargreed:get', (_e, force?: boolean) => getFearGreed(force === true))

  ipcMain.handle('valuation:get', (_e, symbol: string) => getReverseDcf(cleanSymbol(symbol)))

  ipcMain.handle('portfolio:report', () => getPortfolioReport())

  ipcMain.handle('portfolio:add', (_e, input: PositionInput) => {
    addPosition(input)
    return getPortfolioReport()
  })

  ipcMain.handle('portfolio:update', (_e, id: number, fields: Partial<PositionInput>) => {
    updatePosition(Number(id), fields ?? {})
    return getPortfolioReport()
  })

  ipcMain.handle('portfolio:remove', (_e, id: number) => {
    removePosition(Number(id))
    return getPortfolioReport()
  })

  ipcMain.handle('stream:setActive', (_e, symbol: string) => setActiveSymbol(cleanSymbol(symbol)))

  ipcMain.handle('stream:status', () => getStreamStatus())

  ipcMain.handle('open:external', (_e, url: string) => {
    const u = String(url ?? '')
    if (u.startsWith('https://') || u.startsWith('http://')) return shell.openExternal(u)
    return Promise.resolve()
  })

  ipcMain.handle('quotes:watchlist', async (): Promise<QuoteRow[]> => {
    // Piggyback price-alert checks on the app's quote poll (throttled — the
    // alert check batches its own quote call for alert symbols only).
    if (Date.now() - lastAlertSweep > 120_000) {
      lastAlertSweep = Date.now()
      void checkPriceAlerts()
    }
    const keyId = getSecret('alpaca_key_id')
    const secret = getSecret('alpaca_secret')
    const symbols = listWatchlist().map((w) => w.symbol)
    if (!keyId || !secret || symbols.length === 0) {
      return symbols.map((symbol) => ({ symbol, price: null, prevClose: null }))
    }
    try {
      return await fetchQuotes(symbols, { keyId, secret })
    } catch {
      return symbols.map((symbol) => ({ symbol, price: null, prevClose: null }))
    }
  })

  ipcMain.handle('snapshots:recent', (_e, limit?: number) =>
    getDb()
      .prepare('SELECT * FROM iv_snapshots ORDER BY snapshot_date DESC, symbol ASC LIMIT ?')
      .all(Math.min(Math.max(Number(limit) || 50, 1), 500))
  )

  ipcMain.handle('snapshots:for', (_e, symbol: string, limit?: number) =>
    getDb()
      .prepare('SELECT * FROM iv_snapshots WHERE symbol = ? ORDER BY snapshot_date DESC LIMIT ?')
      .all(cleanSymbol(symbol), Math.min(Math.max(Number(limit) || 90, 1), 500))
  )

  ipcMain.handle('jobs:recent', (_e, limit?: number) =>
    getDb()
      .prepare('SELECT * FROM jobs_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(Number(limit) || 20, 1), 200))
  )
}
