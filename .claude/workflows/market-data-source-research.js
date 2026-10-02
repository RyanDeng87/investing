export const meta = {
  name: 'market-data-source-research',
  description: 'Verify 2026 capabilities and pricing of market-data sources for a personal investing desktop app',
  phases: [
    { title: 'Research', detail: 'one agent per data-source family' },
    { title: 'Verify', detail: 'adversarial fact-check of each claim set' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'source_url'],
        properties: {
          claim: { type: 'string', description: 'One falsifiable fact, with exact prices/limits where applicable' },
          detail: { type: 'string', description: 'Supporting detail or caveats' },
          source_url: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', description: '2-3 sentence bottom line for this source family' },
  },
}

const VERIFY = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'verdict'],
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
          correction: { type: 'string', description: 'If refuted or uncertain, the corrected fact' },
          source_url: { type: 'string' },
        },
      },
    },
  },
}

const PREAMBLE = `Today is 2026-07-07. You are researching market-data sources for a personal Windows desktop investing app (tech stocks, ETFs, options analysis). The user's existing brokerages are Robinhood and Fidelity (Roth IRA). First load web tools: call ToolSearch with query "select:WebSearch,WebFetch". Run multiple searches; prefer OFFICIAL pricing and docs pages; anything may have changed in 2025-2026, so do not trust your training data for prices, rate limits, or product availability. Every fact needs a source URL. Return findings via the structured output schema only.`

const SOURCES = [
  {
    key: 'robinhood',
    prompt: `${PREAMBLE}
Research Robinhood specifically:
(a) Does Robinhood offer ANY official public API for retail users in 2026 for STOCKS or OPTIONS (trading or market data)? They launched an official crypto-only API around 2024 — check whether equities/options were ever added.
(b) Robinhood Gold in 2026: exact monthly price and full benefit list (Level II Nasdaq data, Morningstar research, margin terms, IRA match). Critically: is ANY Gold benefit accessible programmatically/via API, or is it all in-app only?
(c) Unofficial libraries (robin_stocks, robinhood-api etc.): are they still working in 2026, what is Robinhood's ToS stance, account-ban risk, 2FA/device-approval friction.
(d) Robinhood Legend desktop platform: does it expose any data export or integration surface?`,
  },
  {
    key: 'fidelity',
    prompt: `${PREAMBLE}
Research Fidelity specifically:
(a) Does Fidelity offer a public/retail developer API in 2026 for market data or trading? (Historically no — verify whether that changed.)
(b) Fidelity Access / Akoya: what third-party data sharing exists (positions/balances via aggregators like Plaid/SnapTrade), and could a personal app realistically use it to read a Roth IRA's positions?
(c) CSV/OFX export of portfolio positions from Fidelity — what is available?
(d) Any Fidelity integrations relevant to a personal analysis app (e.g. SnapTrade, Quicken feeds).`,
  },
  {
    key: 'brokerage-apis',
    prompt: `${PREAMBLE}
The user is open to opening a NEW account purely to get a free/cheap API. Research current 2026 state of:
(a) Charles Schwab Individual Trader API (TD Ameritrade successor): cost, account requirement (minimum balance?), approval wait time, real-time quotes, options chains with Greeks, streaming/websocket, known restrictions or pain points.
(b) Tradier: brokerage-account API access and standalone market-data plans — exact 2026 prices, options chains with Greeks (ORATS), real-time vs delayed.
(c) Alpaca: free tier (IEX data) vs paid SIP data pricing, and whether options market data/chains are available in 2026.
(d) Interactive Brokers (IBKR) Web API / IB Gateway: account cost, market-data subscription fees, setup complexity.
For each: exact current prices and what an options-analysis app would get.`,
  },
  {
    key: 'free-apis',
    prompt: `${PREAMBLE}
Research the current 2026 state of FREE market-data APIs:
(a) yfinance (Yahoo Finance scraper): does it still work, 2025-2026 rate-limiting/blocking incidents, data delay, options chains (does it return IV?), ToS/legal gray area.
(b) Alpha Vantage free tier: exact requests/day limit now, what data is included, any options data.
(c) Finnhub free tier: rate limits, US quotes real-time or delayed, fundamentals, news endpoints.
(d) Polygon.io free tier: calls/min limit, end-of-day only?, any options access.
(e) Financial Modeling Prep free tier: calls/day, what data.
(f) Other notable free sources for a personal app: SEC EDGAR (fundamentals/filings), stooq, marketdata.app free trial/tier, Yahoo alternatives.
For each: rate limits, data delay, options-chain availability, reliability for a daily-driver personal app.`,
  },
  {
    key: 'paid-apis',
    prompt: `${PREAMBLE}
Research current 2026 pricing of PAID market-data APIs at individual/hobbyist tiers (~$10-100/mo):
(a) Polygon.io: current stocks plans AND separate options plans — exact prices, real-time vs 15-min delayed, websockets, historical depth.
(b) Financial Modeling Prep: current tiers and prices, fundamentals depth, any options data.
(c) marketdata.app: current pricing, options chains with Greeks + IV included?
(d) EODHD: pricing, options data add-on.
(e) Briefly: Intrinio, Databento, Tiingo entry prices (likely above/below budget — confirm).
(f) Note which providers shut down or changed drastically (e.g. IEX Cloud shutdown 2024) so we do not recommend dead products.
For each: what an options-analysis app gets (Greeks/IV computed, or raw chains only).`,
  },
]

phase('Research')
const results = await pipeline(
  SOURCES,
  (s) => agent(s.prompt, { label: `research:${s.key}`, phase: 'Research', schema: FINDINGS }),
  (res, s) => {
    if (!res || !res.facts || !res.facts.length) return { key: s.key, facts: [], verdicts: [], summary: res ? res.summary : null }
    return agent(
      `Today is 2026-07-07. You are a skeptical fact-checker. First call ToolSearch with query "select:WebSearch,WebFetch" to load web tools. Below are claims about market-data source "${s.key}" gathered by another researcher. Independently verify EACH claim with fresh web searches against official pricing/docs pages — actively try to refute prices, rate limits, and availability claims (these change often; the researcher may have used stale info). Mark each confirmed/refuted/uncertain and supply a correction with source URL when refuted or uncertain.\n\nClaims:\n${JSON.stringify(res.facts, null, 2)}`,
      { label: `verify:${s.key}`, phase: 'Verify', schema: VERIFY }
    ).then((v) => ({ key: s.key, facts: res.facts, summary: res.summary, verdicts: v ? v.verdicts : [] }))
  }
)

return results.filter(Boolean)
