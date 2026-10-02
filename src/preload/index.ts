import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { RendererApi, StreamBar, StreamStatus, StreamTrade } from '../shared/types'

function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: RendererApi = {
  keysStatus: () => ipcRenderer.invoke('keys:status'),
  setKey: (name, value) => ipcRenderer.invoke('keys:set', name, value),
  watchlist: () => ipcRenderer.invoke('watchlist:list'),
  watchlistAdd: (symbol) => ipcRenderer.invoke('watchlist:add', symbol),
  watchlistRemove: (symbol) => ipcRenderer.invoke('watchlist:remove', symbol),
  setFavorite: (symbol, favorite) => ipcRenderer.invoke('watchlist:favorite', symbol, favorite),
  runCollector: () => ipcRenderer.invoke('collector:run'),
  collectorSchedule: () => ipcRenderer.invoke('schedule:get'),
  collectorScheduleSet: (input) => ipcRenderer.invoke('schedule:set', input),
  collectorScheduleRemove: () => ipcRenderer.invoke('schedule:remove'),
  recentSnapshots: (limit) => ipcRenderer.invoke('snapshots:recent', limit),
  snapshotsFor: (symbol, limit) => ipcRenderer.invoke('snapshots:for', symbol, limit),
  recentJobs: (limit) => ipcRenderer.invoke('jobs:recent', limit),
  bars: (symbol) => ipcRenderer.invoke('bars:get', symbol),
  intradayBars: (symbol, span) => ipcRenderer.invoke('bars:intraday', symbol, span),
  quotesWatchlist: () => ipcRenderer.invoke('quotes:watchlist'),
  runCrawl: () => ipcRenderer.invoke('crawl:run'),
  score: (symbol) => ipcRenderer.invoke('score:get', symbol),
  signals: (symbol) => ipcRenderer.invoke('signals:get', symbol),
  optionsAnalytics: (symbol) => ipcRenderer.invoke('options:get', symbol),
  nextEarnings: (symbol) => ipcRenderer.invoke('earnings:next', symbol),
  discovery: (force) => ipcRenderer.invoke('discovery:get', force),
  runBacktest: (config) => ipcRenderer.invoke('backtest:run', config),
  runBootstrap: (config) => ipcRenderer.invoke('backtest:bootstrap', config),
  paperSnapshot: () => ipcRenderer.invoke('paper:snapshot'),
  paperPlaceOrder: (input) => ipcRenderer.invoke('paper:place', input),
  paperCancelOrder: (orderId) => ipcRenderer.invoke('paper:cancel', orderId),
  paperHistory: (period) => ipcRenderer.invoke('paper:history', period),
  selfTest: () => ipcRenderer.invoke('selftest:get'),
  askCopilot: (symbol, question, history) => ipcRenderer.invoke('copilot:ask', symbol, question, history),
  marketBrief: (force) => ipcRenderer.invoke('brief:get', force),
  macro: (force) => ipcRenderer.invoke('macro:get', force),
  qarpLeaderboard: () => ipcRenderer.invoke('qarp:leaderboard'),
  alertsList: () => ipcRenderer.invoke('alerts:list'),
  alertsAdd: (rule) => ipcRenderer.invoke('alerts:add', rule),
  alertsRemove: (id) => ipcRenderer.invoke('alerts:remove', id),
  journalList: () => ipcRenderer.invoke('journal:list'),
  journalAdd: (entry) => ipcRenderer.invoke('journal:add', entry),
  journalUpdate: (id, fields) => ipcRenderer.invoke('journal:update', id, fields),
  journalRemove: (id) => ipcRenderer.invoke('journal:remove', id),
  reviewDueHypotheses: () => ipcRenderer.invoke('journal:reviewDue'),
  trackRecord: () => ipcRenderer.invoke('predictions:trackRecord'),
  aiRetrospective: (force) => ipcRenderer.invoke('predictions:retro', force),
  newsDigest: (symbol, force) => ipcRenderer.invoke('news:digest', symbol, force),
  news: (symbol) => ipcRenderer.invoke('news:get', symbol),
  profile: (symbol) => ipcRenderer.invoke('profile:get', symbol),
  stance: (symbol) => ipcRenderer.invoke('stance:get', symbol),
  fearGreed: (force) => ipcRenderer.invoke('feargreed:get', force),
  reverseDcf: (symbol) => ipcRenderer.invoke('valuation:get', symbol),
  portfolioReport: () => ipcRenderer.invoke('portfolio:report'),
  portfolioAdd: (input) => ipcRenderer.invoke('portfolio:add', input),
  portfolioUpdate: (id, fields) => ipcRenderer.invoke('portfolio:update', id, fields),
  portfolioRemove: (id) => ipcRenderer.invoke('portfolio:remove', id),
  setActiveSymbol: (symbol) => ipcRenderer.invoke('stream:setActive', symbol),
  streamStatus: () => ipcRenderer.invoke('stream:status'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onStreamTrade: subscribe<StreamTrade>('stream:trade'),
  onStreamBar: subscribe<StreamBar>('stream:bar'),
  onStreamStatus: subscribe<StreamStatus>('stream:status')
}

contextBridge.exposeInMainWorld('api', api)
