export interface KeyStatus {
  alpacaKeyId: boolean
  alpacaSecret: boolean
  fmpKey: boolean
  finnhubKey: boolean
  anthropicKey: boolean
  fredKey: boolean
  encryptionAvailable: boolean
}

export interface ExpirationSummary {
  expiry: string
  dte: number
  atmIv: number | null
  call25dIv: number | null
  put25dIv: number | null
  callOi: number | null
  putOi: number | null
  gexNaive: number | null
}

export interface IvSnapshotRow {
  id: number
  symbol: string
  snapshot_date: string
  spot: number | null
  atm_iv_30d: number | null
  expirations: string
  created_at: string
}

export interface CollectorResult {
  symbol: string
  status: 'ok' | 'skipped' | 'error'
  message?: string
  atmIv30d?: number | null
}

// State of the Windows Scheduled Task that runs the headless daily collector.
// Managed from Settings → Scheduled collector (see main/scheduler.ts).
export interface CollectorScheduleInfo {
  supported: boolean // false off Windows
  registered: boolean
  enabled: boolean // false = task exists but is disabled
  days: string[] // full weekday names the task fires on, e.g. ['Monday', …]
  time: string // 'HH:mm' local time
  lastRun: string | null // ISO; null = never ran
  lastResult: number | null // Task Scheduler last result code (0 = success)
  nextRun: string | null // ISO
  message?: string // surfaced error / info note
}

export interface JobLogRow {
  id: number
  job: string
  ran_at: string
  status: string
  detail: string | null
}

export interface BarRow {
  symbol: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface IntradayBar {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface QuoteRow {
  symbol: string
  price: number | null
  prevClose: number | null
}

export interface WatchItem {
  symbol: string
  favorite: boolean
}

export interface CrawlSummary {
  symbols: string[]
  callsUsed: number
  remainingToday: number
  message?: string
}

export interface StreamStatus {
  state: 'off' | 'connecting' | 'live' | 'error'
  symbols: string[]
  detail?: string
}

export interface StreamTrade {
  symbol: string
  price: number
  size: number
  time: string
}

export interface StreamBar {
  symbol: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  time: string
}

export interface MetricScore {
  key: string
  label: string
  value: number | null
  percentile: number | null
}

export interface PillarScore {
  percentile: number | null
  metrics: MetricScore[]
}

export interface LynchCheck {
  label: string
  verdict: 'pass' | 'fail' | 'unknown'
  detail: string
}

export interface BuffettScore {
  symbol: string
  scoredAt: string
  universeScored: number
  universeSize: number
  pillars: {
    value: PillarScore
    quality: PillarScore
    growth: PillarScore
    safety: PillarScore
  }
  qarp: number | null
  lynch: LynchCheck[]
  caveats: string[]
  available: boolean
  dataSource?: 'fmp' | 'fallback'
  message?: string
}

export interface SignalInput {
  key: string
  label: string
  value: string
  contribution: number | null // -1..+1, null = unavailable
  horizon: string
  evidence: string
  detail: string
}

export interface SignalRegime {
  price: number
  sma50: number | null
  sma200: number | null
  aboveSma200: boolean
  goldenCross: boolean | null
}

export interface SignalReport {
  symbol: string
  asOf: string
  tilt: number | null // -100..+100
  label: string
  confidence: 'none' | 'low' | 'medium'
  inputs: SignalInput[]
  regime: SignalRegime | null
  disclosures: string[]
}

export interface StrategyIdea {
  kind: 'covered-call' | 'csp' | 'put-credit-spread'
  label: string
  expiry: string
  dte: number
  strikes: string
  credit: number
  creditPct: number
  annualizedPct: number
  pop: number | null
  spreadPct: number | null // short-leg bid-ask spread as a fraction of mid — fill-quality gauge
  detail: string
  rationale: string[] // step-by-step reasoning with the actual numbers used
}

export interface OptionsAnalytics {
  symbol: string
  asOf: string
  spot: number | null
  iv30: number | null
  ivRank: number | null
  ivPercentile: number | null
  ivDays: number
  rv21: number | null // realized (historical) vol, trailing 21 trading days, annualized
  rv63: number | null // trailing quarter
  vrp: number | null // IV30 − RV21: the variance risk premium, the premium-seller's edge gauge
  expectedMove30d: { abs: number; pct: number } | null
  skew25d: number | null
  termStructure: { expiry: string; dte: number; atmIv: number | null }[]
  gexNaive: number | null
  strategies: StrategyIdea[]
  caveats: string[]
  available: boolean
  message?: string
}

export interface DiscoverySymbolStat {
  symbol: string
  name: string
  category: 'sector' | 'broad' | 'tech' | 'quantum' | 'goldfx'
  last: number | null
  ret1m: number | null
  ret3m: number | null
  ret6m: number | null
  rel3m: number | null // 3M return minus SPY's
  mom121: number | null // 12-1 momentum
  momPct: number | null // cross-sectional percentile among tracked symbols
  above200d: boolean | null
  from52wHigh: number | null // % vs 52-week high (≤ 0)
  barsDays: number
}

export interface DiscoveryReport {
  asOf: string
  spyRet: { r1m: number | null; r3m: number | null; r6m: number | null }
  universeSize: number
  withHistory: number
  poolSize: number // symbols in the momentum-percentile cross-section
  sectors: DiscoverySymbolStat[]
  moversUp: DiscoverySymbolStat[]
  moversDown: DiscoverySymbolStat[]
  momentumLeaders: DiscoverySymbolStat[]
  focus: {
    tech: DiscoverySymbolStat[]
    quantum: DiscoverySymbolStat[]
    broad: DiscoverySymbolStat[]
    goldfx: DiscoverySymbolStat[]
  }
  refreshing: boolean
  caveats: string[]
}

// --- Phase 5 backtester (v2: custom universes, total-return bars, pro metrics) ---
// StrategyKind doubles as the Strategy Contract id shared with Phase 6 paper
// trading: the same signal definitions drive the forward Self-Tests.
export type StrategyKind = 'momentum-12-1' | 'ma-timing' | 'buy-hold' | 'fixed-allocation' | 'dual-momentum'

// 'bands' = Swedroe 5/25 tolerance bands, checked at month-ends: rebalance the
// whole portfolio when any leg drifts 5 pct-pts absolute OR 25% relative off
// target. 'none' = buy once, let it drift forever.
export type RebalanceFreq = 'monthly' | 'quarterly' | 'yearly' | 'none' | 'bands'

export interface BacktestConfig {
  strategy: StrategyKind
  topN: number // momentum only: names held per rebalance
  costBps: number // one-way transaction cost, basis points of traded value
  start: string // YYYY-MM-DD ('' = earliest possible)
  end: string // YYYY-MM-DD ('' = latest)
  // momentum: custom universe ([] = the app's tracked universe)
  // buy-hold / ma-timing: [symbol] ([] = SPY)
  // fixed-allocation: the legs, parallel to `weights`
  // dual-momentum: [risk1, risk2, defensive] ([] = SPY, EFA, AGG; cash hurdle BIL)
  symbols: string[]
  weights: number[] // fixed-allocation only; normalized to sum 1
  benchmark: string // comparison series for the curve and all relative stats
  rebalance: RebalanceFreq // momentum: monthly/quarterly; fixed-allocation: any
  // Cashflow modeling (Roth-style DCA). EXCLUDED from the trial-registry hash:
  // cashflows change the dollar outcome, not the strategy being tested.
  initialCapital: number // dollars at inception (default 10000)
  contribMonthly: number // dollars added on the first trading day of each month (0 = off)
}

// Money-weighted vs time-weighted outcome when contributions are modeled.
export interface ContributionResult {
  initialCapital: number
  monthly: number
  months: number // number of monthly contributions made
  totalContributed: number // initial + all contributions
  finalValue: number
  benchFinalValue: number // same cashflows DCA'd into the benchmark
  mwr: number | null // money-weighted return (IRR of the actual cashflows), annualized; null when outside the solvable range
  twr: number // time-weighted return (= CAGR above) for side-by-side education
}

export interface BacktestPoint {
  date: string
  equity: number // growth of $1, net of costs, total-return (dividends in)
  benchmark: number // benchmark growth of $1 (initial cost only)
}

export interface RebalanceRecord {
  date: string
  holdings: string[]
  turnover: number // one-way, 0..1
}

export interface DrawdownEpisode {
  peakDate: string
  troughDate: string
  recoveryDate: string | null // null = still underwater at sample end
  depth: number // negative fraction
  daysToTrough: number // calendar days peak → trough
  daysToRecover: number | null // calendar days trough → recovery
}

export interface BacktestMetrics {
  cagr: number
  vol: number // annualized
  sharpe: number // rf = 0, disclosed
  sortino: number // MAR = 0, full-sample denominator (Sortino/Forsey convention)
  calmar: number | null // CAGR / |maxDD|, full-period; null when maxDD = 0
  ulcer: number // RMS of the daily drawdown series (percent units)
  psr: number // probabilistic Sharpe ratio vs SR* = 0
  dsr: number // deflated Sharpe: PSR vs expected-max SR over `trials` variants
  trials: number
  maxDrawdown: number // negative fraction
  hitRateMonthly: number // fraction of positive months
  avgTurnover: number // per rebalance, one-way
  costDragAnnual: number // fraction of equity lost to modeled costs per year
  tradingDays: number
  // distribution shape (daily returns)
  skew: number
  kurtExcess: number
  var95: number // 5th-percentile daily return (negative fraction)
  cvar95: number // mean of the worst 5% of days (negative fraction)
  bestMonth: number
  worstMonth: number
  // drawdown texture
  longestUnderwaterDays: number // calendar days of the longest peak→recovery episode
  timeUnderwaterPct: number // fraction of days below a prior peak
  // vs benchmark (all daily, inner-joined dates)
  beta: number | null
  alphaAnnual: number | null // OLS intercept × 252
  r2: number | null
  trackingError: number | null // annualized
  informationRatio: number | null
  upCapture: number | null // Morningstar monthly-geometric convention, 1 = 100%
  downCapture: number | null
  benchCagr: number
  benchMaxDrawdown: number
  benchSharpe: number
  benchVol: number
}

export interface BacktestResult {
  config: BacktestConfig
  asOf: string
  available: boolean
  message?: string
  effectiveStart: string | null // first date with enough history for signals
  effectiveEnd: string | null
  points: BacktestPoint[]
  metrics: BacktestMetrics | null
  rebalances: RebalanceRecord[] // most recent first, capped
  drawdowns: DrawdownEpisode[] // worst 5, deepest first
  coverage: { eligibleAtStart: number; eligibleAtEnd: number; universeSize: number }
  fellBack: string[] // symbols that used price-only bars (adjusted history unavailable)
  contrib: ContributionResult | null // present when contribMonthly > 0
  warnings: string[]
}

// Stationary block bootstrap (Politis–Romano) of the backtest's daily returns:
// same returns, shuffled order — separates "robust process" from "one lucky
// path". Percentiles describe sampling variability, NOT out-of-sample odds.
export interface BootstrapPercentiles {
  p5: number
  p25: number
  p50: number
  p75: number
  p95: number
}

export interface BootstrapResult {
  available: boolean
  message?: string
  resamples: number
  blockLen: number // expected block length (trading days)
  tradingDays: number
  cagr: BootstrapPercentiles
  maxDrawdown: BootstrapPercentiles
  sharpe: BootstrapPercentiles
  probNegative: number // fraction of resamples ending below $1
  probWorseDD: number // fraction with a deeper max drawdown than realized
  realized: { cagr: number; maxDrawdown: number; sharpe: number }
  notes: string[]
}

// --- Phase 6: Alpaca paper trading + Self-Test ---
export interface PaperAccount {
  equity: number | null
  lastEquity: number | null // previous close equity → day P&L
  cash: number | null
  buyingPower: number | null
  longMarketValue: number | null
  status: string
}

export interface PaperPosition {
  symbol: string
  qty: number
  avgEntry: number | null
  currentPrice: number | null
  marketValue: number | null
  unrealizedPl: number | null
  unrealizedPlPct: number | null
  todayPlPct: number | null
  weight: number | null // fraction of account equity
}

export interface PaperOrder {
  id: string
  symbol: string
  side: string
  type: string
  qty: number | null
  notional: number | null
  limitPrice: number | null
  status: string
  filledQty: number | null
  filledAvgPrice: number | null
  submittedAt: string
  tif: string
}

export interface PaperOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  qty?: number
  notional?: number // dollar amount (market orders only)
  limitPrice?: number
  tif: 'day' | 'gtc'
}

export interface PaperSnapshot {
  available: boolean
  message?: string
  account: PaperAccount | null
  positions: PaperPosition[]
  openOrders: PaperOrder[]
  recentOrders: PaperOrder[] // last filled/cancelled, newest first
}

export interface PortfolioHistoryPoint {
  date: string
  equity: number
}

// Self-Test: the app grades itself. Each canonical strategy config is anchored
// on the first day it's seen; from then on, its realized forward performance
// (same engine, same bars, start = anchor) is compared against the backtest
// expectation frozen at the anchor. Divergence is the finding, not a failure.
export interface SelfTestExpectation {
  cagr: number
  sharpe: number
  dsr: number
  maxDrawdown: number
}

export interface SelfTestForward {
  totalReturn: number
  cagr: number
  sharpe: number
  maxDrawdown: number
}

export interface SelfTestEntry {
  strategy: StrategyKind
  label: string
  anchorDate: string
  calendarDaysElapsed: number
  tradingDaysForward: number
  expectation: SelfTestExpectation
  forward: SelfTestForward | null // null until 60 forward trading days exist
  benchForward: { totalReturn: number; maxDrawdown: number } | null
  status: 'accruing' | 'tracking'
  note: string
}

export interface StrategyTarget {
  strategy: StrategyKind
  label: string
  holdings: { symbol: string; weight: number }[]
  asOf: string
}

export interface SelfTestReport {
  available: boolean
  message?: string
  asOf: string
  entries: SelfTestEntry[]
  targets: StrategyTarget[]
  disclosures: string[]
}

export interface EarningsEvent {
  symbol: string
  date: string // YYYY-MM-DD
  hour: 'bmo' | 'amc' | 'dmh' | null // before open / after close / during hours
  epsEstimate: number | null
  revenueEstimate: number | null
  daysUntil: number
}

// --- Phase 7: Claude copilot + AI market brief ---
export interface CopilotTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface CopilotReply {
  ok: boolean
  text: string
  error?: string
  costCents?: number // rough spend for this answer, keeps costs visible
  logged?: number // hypotheses the copilot recorded into the journal this turn
}

export interface MarketBrief {
  available: boolean
  text: string
  generatedAt: string
  fresh: boolean // false = served from the 12h cache
  message?: string
}

// --- FRED macro context ---
export interface MacroSeries {
  id: string
  label: string
  units: string
  latest: number
  date: string
  yearAgo: number | null
}

export interface MacroReport {
  available: boolean
  series: MacroSeries[]
  asOf: string
  message?: string
}

// --- QARP leaderboard (Discover) ---
export interface QarpRow {
  symbol: string
  qarp: number | null
  quality: number | null
  value: number | null
  dataSource?: 'fmp' | 'fallback'
}

export interface QarpLeaderboard {
  available: boolean
  rows: QarpRow[]
  scoredCount: number
  universeSize: number
  asOf: string
  message?: string
}

// --- Price/IV alerts ---
export type AlertKind = 'price_above' | 'price_below' | 'iv_rank_above' | 'iv_rank_below'

export interface AlertRule {
  id: number
  symbol: string
  kind: AlertKind
  threshold: number
  active: boolean // one-shot: fires once, then deactivates
  createdAt: string
  firedAt: string | null
  lastValue: number | null
}

// --- Trade journal + hypothesis tracking ---
// A HYPOTHESIS is a journal entry with status 'open' and a horizon_date: a
// falsifiable prediction (from the user or the copilot) that gets scored
// against realized prices once the horizon passes. author records who made it.
export interface JournalEntry {
  id: number
  date: string // YYYY-MM-DD of the decision/trade/prediction
  symbol: string
  side: 'buy' | 'sell' | 'note'
  qty: number | null
  price: number | null
  account: string // e.g. 'roth', 'robinhood', 'paper'
  thesis: string // why / the falsifiable claim, written BEFORE the outcome is known
  outcome: string // filled in later — the review habit
  author: 'user' | 'copilot'
  horizonDate: string | null // when the hypothesis comes due (null = plain entry)
  status: '' | 'open' | 'resolved'
  createdAt: string
}

// --- Prediction track record: the app's own signals scored against reality ---
export interface TrackRecordStat {
  label: string
  value: string
}

export interface TrackRecordKind {
  kind: string // signal_tilt | buffett_qarp | iv_rank
  label: string
  matured: number // snapshots old enough to score
  pending: number // still waiting for their horizon
  stats: TrackRecordStat[]
  misses: string[] // worst wrong-way calls, human-readable (feeds the AI retrospective)
  note: string
}

export interface TrackRecord {
  available: boolean
  asOf: string
  kinds: TrackRecordKind[]
  disclosures: string[]
  message?: string
}

export interface Retrospective {
  available: boolean
  text: string
  generatedAt: string
  message?: string
}

// --- Phase 9: AI news digest ---
export interface NewsDigest {
  available: boolean
  symbol: string
  generatedAt: string
  fresh: boolean
  mainPoints: string[]
  sentiment: 'positive' | 'negative' | 'mixed' | 'neutral' | ''
  catalysts: string[]
  risks: string[]
  headlineCount: number
  message?: string
}

export interface NewsItem {
  headline: string
  source: string
  datetime: number
  url: string
  summary: string
}

// --- CNN Fear & Greed Index (unofficial endpoint; cached daily) ---
export interface FearGreedComponent {
  key: string
  label: string
  score: number | null
  rating: string
}

export interface FearGreed {
  available: boolean
  score: number | null // 0 (extreme fear) … 100 (extreme greed)
  rating: string
  asOf: string // date the reading belongs to
  fetchedAt: string
  stale: boolean // serving an old cached row after fetch failures
  weekAgo: number | null
  monthAgo: number | null
  yearAgo: number | null
  components: FearGreedComponent[]
  history: { date: string; score: number }[] // daily composite, ascending
  note: string
  message?: string
}

// --- Stance: rule-based buy/hold/sell synthesis (Description tab) ---
export type StanceAction = 'buy' | 'hold' | 'sell'

export interface StanceReason {
  text: string // includes the actual input values — the (i) popup IS the calculation
  direction: 'for' | 'against' | 'neutral' // relative to owning the symbol
}

export interface StanceReport {
  symbol: string
  asOf: string
  available: boolean
  action: StanceAction
  timeframe: string // e.g. '6–18 months'
  horizonDays: number // trading days used when the stance is graded
  confidence: 'low' | 'medium' | 'high'
  confidenceDetail: string // e.g. '3 of 4 directional inputs agree'
  composite: number // -100..+100 weighted blend behind the action
  reasons: StanceReason[]
  cautions: string[] // earnings proximity, IV timing, thin data
  isEtf: boolean // no fundamentals pillar
  tracked: boolean // ★ starred → recorded daily and graded in the track record
  disclosures: string[]
  message?: string
}

// --- Reverse DCF: the absolute-valuation anchor (Buffett tab) ---
// Solves for the FCF growth rate that makes a 10-year two-stage DCF equal
// today's market cap — "what growth is the price asking you to believe?".
// Makes NO forecast: it inverts the price into an assumption you can judge.
export interface ReverseDcf {
  symbol: string
  asOf: string
  available: boolean
  basis: 'fcf' | 'earnings' // earnings-yield fallback when FCF yield is missing
  yieldUsed: number // FCF (or earnings) / market cap, TTM
  impliedGrowth: number | null // 10y growth implied at the 10% required return; null = unsolvable
  sensitivity: { requiredReturn: number; impliedGrowth: number | null }[] // at 8% / 10% / 12%
  histRevenueCagr: number | null // trailing ~5y, for comparison
  histEpsCagr: number | null
  dataSource?: 'fmp' | 'fallback'
  explanation: string[] // the model, spelled out with the actual numbers
  caveats: string[]
  message?: string
}

// --- Portfolio (manual positions — what the user actually owns) ---
export interface PositionInput {
  symbol: string
  qty: number
  costBasis: number | null // average cost per share
  account: string // e.g. 'roth', 'robinhood'
}

export interface PortfolioPosition {
  id: number
  symbol: string
  qty: number
  costBasis: number | null
  account: string
  price: number | null
  prevClose: number | null
  marketValue: number | null
  dayPct: number | null
  gainPct: number | null // vs cost basis
  gainAbs: number | null
  weight: number | null // fraction of portfolio market value
  qarp: number | null
  tilt: number | null
  stance: StanceAction | null
  sector: string
}

export interface PortfolioReport {
  available: boolean
  asOf: string
  positions: PortfolioPosition[]
  totalValue: number
  totalCost: number | null // null when any position lacks a cost basis
  totalGainAbs: number | null
  totalGainPct: number | null
  dayGainAbs: number | null
  dayGainPct: number | null
  warnings: string[] // concentration flags
  disclosures: string[]
  message?: string
}

// --- Company profile (Description tab; FMP profile cache) ---
export interface CompanyProfile {
  symbol: string
  available: boolean
  name: string
  exchange: string
  sector: string
  industry: string
  marketCap: number | null
  description: string
  website: string
  isEtf: boolean
  fetchedAt: string
  message?: string
}

export interface RendererApi {
  keysStatus(): Promise<KeyStatus>
  setKey(name: string, value: string): Promise<void>
  watchlist(): Promise<WatchItem[]>
  watchlistAdd(symbol: string): Promise<WatchItem[]>
  watchlistRemove(symbol: string): Promise<WatchItem[]>
  setFavorite(symbol: string, favorite: boolean): Promise<WatchItem[]>
  runCollector(): Promise<CollectorResult[]>
  collectorSchedule(): Promise<CollectorScheduleInfo>
  collectorScheduleSet(input: { enabled: boolean; days: string[]; time: string }): Promise<CollectorScheduleInfo>
  collectorScheduleRemove(): Promise<CollectorScheduleInfo>
  recentSnapshots(limit?: number): Promise<IvSnapshotRow[]>
  snapshotsFor(symbol: string, limit?: number): Promise<IvSnapshotRow[]>
  recentJobs(limit?: number): Promise<JobLogRow[]>
  bars(symbol: string): Promise<BarRow[]>
  intradayBars(symbol: string, span?: '1D' | '1W'): Promise<IntradayBar[]>
  quotesWatchlist(): Promise<QuoteRow[]>
  runCrawl(): Promise<CrawlSummary>
  score(symbol: string): Promise<BuffettScore>
  signals(symbol: string): Promise<SignalReport>
  optionsAnalytics(symbol: string): Promise<OptionsAnalytics>
  nextEarnings(symbol: string): Promise<EarningsEvent | null>
  discovery(force?: boolean): Promise<DiscoveryReport>
  runBacktest(config: BacktestConfig): Promise<BacktestResult>
  runBootstrap(config: BacktestConfig): Promise<BootstrapResult>
  paperSnapshot(): Promise<PaperSnapshot>
  paperPlaceOrder(input: PaperOrderInput): Promise<PaperOrder>
  paperCancelOrder(orderId: string): Promise<void>
  paperHistory(period: '1M' | '3M' | '1A'): Promise<PortfolioHistoryPoint[]>
  selfTest(): Promise<SelfTestReport>
  askCopilot(symbol: string, question: string, history: CopilotTurn[]): Promise<CopilotReply>
  marketBrief(force?: boolean): Promise<MarketBrief>
  macro(force?: boolean): Promise<MacroReport>
  qarpLeaderboard(): Promise<QarpLeaderboard>
  alertsList(): Promise<AlertRule[]>
  alertsAdd(rule: { symbol: string; kind: AlertKind; threshold: number }): Promise<AlertRule[]>
  alertsRemove(id: number): Promise<AlertRule[]>
  journalList(): Promise<JournalEntry[]>
  journalAdd(entry: Omit<JournalEntry, 'id' | 'createdAt' | 'author' | 'horizonDate' | 'status'>): Promise<JournalEntry[]>
  journalUpdate(id: number, fields: Partial<Pick<JournalEntry, 'thesis' | 'outcome'>>): Promise<JournalEntry[]>
  journalRemove(id: number): Promise<JournalEntry[]>
  reviewDueHypotheses(): Promise<{ reviewed: number; entries: JournalEntry[] }>
  trackRecord(): Promise<TrackRecord>
  aiRetrospective(force?: boolean): Promise<Retrospective>
  newsDigest(symbol: string, force?: boolean): Promise<NewsDigest>
  news(symbol: string): Promise<NewsItem[]>
  profile(symbol: string): Promise<CompanyProfile>
  stance(symbol: string): Promise<StanceReport>
  fearGreed(force?: boolean): Promise<FearGreed>
  reverseDcf(symbol: string): Promise<ReverseDcf>
  portfolioReport(): Promise<PortfolioReport>
  portfolioAdd(input: PositionInput): Promise<PortfolioReport>
  portfolioUpdate(id: number, fields: Partial<PositionInput>): Promise<PortfolioReport>
  portfolioRemove(id: number): Promise<PortfolioReport>
  setActiveSymbol(symbol: string): Promise<void>
  streamStatus(): Promise<StreamStatus>
  openExternal(url: string): Promise<void>
  onStreamTrade(cb: (t: StreamTrade) => void): () => void
  onStreamBar(cb: (b: StreamBar) => void): () => void
  onStreamStatus(cb: (s: StreamStatus) => void): () => void
}
