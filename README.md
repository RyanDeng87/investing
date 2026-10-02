# Investing App

A personal Windows desktop app for Buffett-style stock analysis, honest market signals, and options analytics — built on evidence, not hype. Electron + React + TypeScript, free-tier data, designed to be maintained and extended with Claude Code.

**Companion documents:** [`RESEARCH.md`](RESEARCH.md) (the cited evidence base — read this to understand *why* every feature works the way it does) · [`PLAN.md`](PLAN.md) (architecture decisions, problem analysis, phased build plan).

---

## The philosophy (what the research taught us)

1. **Two engines.** Buffett-style stock *selection* is codifiable and evidence-backed (Berkshire's alpha is explained by screenable value + quality + safety factors — "Buffett's Alpha," FAJ 2018). Short-term *prediction* is mostly a graveyard (most published predictors fail out-of-sample — RFS 2024/2020). So the **Buffett Engine** (fundamentals, no timing) and the **Signal Monitor** (probabilistic tilts with confidence bands and disclosures) are separate, clearly labeled modules.
2. **Honest labeling everywhere.** Expected moves are "statistical ranges, not predictions." Candlestick patterns are chart annotations with education, never signals (the evidence says they don't predict). Backtests display deflated Sharpe ratios and survivorship-bias warnings. The app tells you what it *can't* know.
3. **Scores are relative and say so.** Quality/value scores are percentiles within a defined tech-focused universe (~150–200 tickers), because that's what the free data budget honestly supports.
4. **The app tests itself.** Backtesting answers "how would this have done" (with overfitting controls); Alpaca paper trading (Phase 6) answers "how is it doing from today forward." Divergence between the two is a first-class metric.

## Current status

**All planned phases (0–9) are shipped**, plus the prediction track record / hypothesis engine and the stance + Fear & Greed wave (see Roadmap). The app is now in **accumulation mode** — most of its remaining value grows with time, not code:

- **IV history** matures ~mid-2027 (IV Rank needs ~1 year; collected daily since 2026-07-07 — a missed collector day is data gone forever).
- **Self-Test forward metrics** unlock late Sept 2026 (60 trading days past the 2026-07-07 anchors).
- **First prediction grades** (signal tilt, 63-day horizon) mature ~Oct 2026; QARP grades July 2027; stance grades trail their own timeframes.
- The **fundamentals crawl** widens Buffett-percentile coverage a few symbols per day under FMP's 250-call budget.

Remaining work is verification, selective expansion (see *Project assessment* below), and resisting the urge to trust scoreboards before they have data.

## Architecture

```
Electron main process ── API clients (Alpaca/FMP/Finnhub) · rate budgeter
                         SQLite (better-sqlite3, %APPDATA% userData) · job log
                         key vault (safeStorage/DPAPI) · IPC · [MCP server, Phase 7]
worker_threads ───────── backtester · Monte Carlo · bulk scoring (later phases)
renderer (React) ─────── UI only; typed IPC bridge; no keys, no network
headless collector ───── `npm run collect` via Windows Task Scheduler, weekdays near the close
```

### Data sources (free tier limits as verified 2026-07)

| Provider | Used for | Limits to respect |
|---|---|---|
| Alpaca (Basic) | quotes, daily bars (2016+, IEX feed), options chains w/ Greeks+IV (indicative feed), **real-time websocket stream** | 200 req/min REST; websocket is separate (1 connection, ~30 symbol subs → favorites ★ + active symbol); no historical IV; IEX ≈ 8–10% of volume |
| Financial Modeling Prep | fundamentals, ratios, peers | **250 req/day** — the scarce resource; universe refresh is a rolling crawl |
| SEC EDGAR | filings, XBRL facts | free, be polite (declared User-Agent) |
| Finnhub | news, real-time quotes | 60 req/min |

## Setup to Run

1. **Install Node.js LTS** (v20+): `winget install OpenJS.NodeJS.LTS` (or nodejs.org).
2. `npm install` in this directory (postinstall rebuilds better-sqlite3 for Electron's ABI; if it fails, see Troubleshooting).
3. **Get API keys** (all free):
   - **Alpaca**: sign up at alpaca.markets → generate *paper* API key + secret (paper keys are fine for market data, and are what Phase 6 paper trading uses).
   - **FMP**: financialmodelingprep.com → free API key.
   - **Finnhub**: finnhub.io → free API key.
4. `npm run dev` → opens the app → enter keys in **Settings** (stored encrypted via Windows DPAPI, never in plaintext files).
5. Adjust the **watchlist** (seeded with QQQ, SPY, XLK, AAPL, MSFT, NVDA, GOOGL, AMZN, META, AMD).
6. **Register the daily collector**: `npm run register-collector` (creates a Scheduled Task, weekdays 3:50 PM ET / 2:50 PM Central). Test it once with the "Run collector now" button in the app.

## Setup to-dos (pending — also shown as a card in Settings until done)

- [ ] **Anthropic API key** — console.anthropic.com (pay-as-you-go, ~cents/day at normal use) → paste in Settings. Unlocks: ✦ Copilot + hypothesis logging, AI verdicts on due hypotheses, the AI retrospective, the Discover market brief, and the per-symbol news digest. Everything is wired; it all lights up the moment the key lands.
- [ ] **FRED API key** — fredaccount.stlouisfed.org/apikeys (free) → paste in Settings. Unlocks the macro panel in Discover (fed funds, 10y, CPI YoY, dollar index).
- [ ] **MCP registration** (optional, one-time, any terminal): `claude mcp add --transport http investing http://127.0.0.1:48620/mcp` — lets Claude Code query the running app's engines. Mark it done on the Settings card afterwards.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | run the app with hot reload |
| `npm run build` | production build to `out/` |
| `npm run collect` | build + run the headless IV collector once |
| `npm run register-collector` | register the Task Scheduler job |
| `npm run typecheck` | TypeScript checks for both node and web code |
| `npx electron . --uitest "symbol=QQQ&range=6M&patterns=1&tab=signals&pin=daily.0" --shot out.png` | screenshot harness: drives the UI into a deterministic state and captures it (add `&scroll=N` to capture below-the-fold sections; NEVER put a `:` inside a CLI arg — it silently kills Electron's Windows arg parsing) |
| `npx electron . --backtest fixed-allocation - VOO=60,QQQ=20,GLD=20 2022 - SPY` | headless backtest: strategy, topN, symbols (weights via `=`), start, end, benchmark; `-` skips a positional |
| `npx electron . --selftest` | headless Phase 6 Self-Test report (anchors canonical strategies on first run) |
| `claude mcp add --transport http investing http://127.0.0.1:48620/mcp` | register the app's MCP server with Claude Code (one-time; the app must be running when used; `INVESTING_MCP_PORT` overrides the port for test instances) |
| `npx electron . --predict` | record today's prediction, stance, and Fear & Greed snapshots + print the track record (also runs in the daily collector) |

## Roadmap (from PLAN.md)

- [x] Research + plan (`RESEARCH.md`, `PLAN.md`)
- [x] **Phase 0:** scaffold, SQLite schema, key vault, IV collector + scheduled task
- [x] **Phase 1:** data layer, rate budgeter, Universe Manager (rolling fundamentals crawl), TradingView-style UI, live websocket streaming
- [x] **Phase 2:** Buffett Engine — quality/value/growth/safety percentiles → QARP composite (65/35), Lynch checks, SEC EDGAR + Finnhub fallback for FMP-gated symbols. *Deferred from the original scope: Piotroski F-score, owner-earnings DCF, snowflake visual — see Project assessment; the DCF is the highest-value absentee.*
- [x] **Phase 3:** charts + Signal Monitor — candle annotations w/ pattern inspector (evidence-labeled, not signals), MA regime descriptor, momentum/PEAD/revisions tilt with attribution and confidence capped at medium
- [x] **Phase 4:** Options tab — IV Rank/Percentile (from locally collected history, maturity labeled), expected move, delta-approx PoP, covered-call/CSP/put-credit-spread screener (~30–45 DTE, ~30Δ documented mechanics), 25Δ skew + IV term structure + naive GEX with explainers. GEX is live: open interest comes from the trading API's `/v2/options/contracts` endpoint (OCC-reported once daily, prior session) and is also stored in the daily IV snapshots. **Next earnings** tile + event-risk warning when a report lands before the screener's expiry (Finnhub calendar, free tier sees ~1 month+ out). **Click any strategy row** to expand the full reasoning: expiry choice among candidates, the actual delta/bid/ask behind the strike and credit, return math, PoP derivation, management mechanics, IV-Rank context, and earnings event risk.
- [x] **Phase 5:** backtester (v2) — the **⧗ Backtest** button opens a full pro-style tearsheet engine running on **total-return bars** (`adjustment=all`, dividends reinvested — stored in `daily_bars_adj`, separate from the charts' split-only bars; backward-adjustment staleness is detected by overlap-comparing closes and triggers a full refetch). Five strategies: Momentum 12-1 rotation (custom universe or the tracked ~55), **Antonacci dual momentum** (GEM: 12-mo absolute gate on leg 1 vs BIL total return, relative momentum between risk legs, defensive fallback), **fixed allocation** (your ETFs + weights; rebalance monthly/quarterly/yearly/never or on Swedroe **5/25 bands**), 200-day MA timing on any symbol (Zakamulin teaching example), and buy-hold of any symbol. Custom **date range**, **benchmark**, and start-clamp warnings that name the binding ticker. Metrics follow the cross-tool consensus (Portfolio Visualizer/quantstats/Morningstar, verified 2026-07): CAGR (calendar-basis), Sharpe/**Sortino** (full-sample downside denominator)/**Calmar**/**Ulcer**, PSR + **deflated Sharpe** (every config ever run registers in `backtest_trials` and raises the bar), beta/alpha/R²/tracking error/**information ratio**, Morningstar **up/down capture**, historical **VaR/CVaR 95%**, skew/kurtosis, time-underwater stats. Views: log equity curve + **underwater chart**, **monthly-returns heatmap** (vs benchmark year column), **worst-drawdowns table** (peak/trough/recovery/durations), **rolling 12-month returns**, rebalance log, and a **path-luck bootstrap** (Politis–Romano stationary, 1,000 resamples, block 10 — percentile bands for CAGR/maxDD/Sharpe). Costs on every weight change, no lookahead, survivorship banner. Free-data limit: IEX history is dense from ~2020-07, so backtests effectively begin ~2021. Headless: `npx electron . --backtest <strategy> [topN] [symbolsCsv|-] [start|-] [end|-] [benchmark]` (fixed-allocation legs as `VOO=60,QQQ=40` — never use `:` in args).
- [x] **Phase 6:** paper trading + Self-Test — the **⚑ Paper** button opens the **Alpaca paper account** (base URL pinned to paper-api; no code path reaches a live account): equity/day-P&L/cash/buying-power tiles, equity history chart, positions (click → chart), an order ticket (market/limit, shares or fractional **dollar notional**, day/gtc, review-then-confirm), open-order cancel, recent fills. Below it, the **Self-Test dashboard**: the four canonical strategies (momentum top-5, GEM, MA timing, buy-hold SPY — all anchored on the dense 2021+ era) had their backtest expectations **frozen in `selftest_anchors` on first run (2026-07-07)**; from then on the same engine re-runs on post-anchor data only — true out-of-sample. Forward metrics unlock at 60 trading days; the research prediction (forward < backtest) is the thing being tested. Also shows **what each strategy says to hold right now**, with ✓ marks on holdings already in the paper account. Headless: `npx electron . --selftest`.
- [x] **Phase 7:** Claude copilot + local MCP server — the **✦ Copilot** bottom tab is a chat GROUNDED in the app's own engines: each question ships the active symbol's signals, Buffett score, options analytics, earnings date, discovery stats (+ FRED macro when keyed) as JSON context to `claude-opus-4-8` (adaptive thinking), with a system prompt that enforces the honest-labeling rules and forbids buy/sell advice; every answer shows its rough cost in cents. Requires an **Anthropic API key** in Settings (`console.anthropic.com`, pay-as-you-go — a question costs a few cents). The **local MCP server** runs inside the app on `http://127.0.0.1:48620/mcp` (streamable-HTTP; Electron's main process has no working stdin on Windows, and serving from the live instance shares its caches anyway). Register once: `claude mcp add --transport http investing http://127.0.0.1:48620/mcp` — then Claude Code can call `get_signals`, `get_buffett_score`, `get_options_analytics`, `get_next_earnings`, `get_discovery`, `run_backtest` (registers DSR trials like any run — don't sweep idly), `get_selftest`, `get_paper_snapshot` (read-only), `get_qarp_leaderboard`, `get_macro`, `get_bars`, `get_journal`. The app must be running.
- [x] **Phase 8:** Market Discovery — the **⌕ Discover** button swaps the main view for a broad-market dashboard: sector rotation (11 SPDRs vs SPY), 1-month movers, 12-1 momentum leaders (same signal family as the Signals tab), and focus panels for tech (incl. semis/software ETFs), quantum, broad baskets, and gold/currency — all computed from locally cached daily bars (~52-symbol universe, one-time backfill, daily refresh via the collector, zero marginal API cost). Clicking a symbol loads it into the engines. Side effects that strengthen earlier phases: the momentum percentile in the **Signals tab** now ranks across ~70 tracked symbols instead of ~20, and non-ETF discovery names are seeded into the fundamentals-crawl universe so **Buffett Score** percentiles widen over time. Remaining ideas: optional AI market brief (pairs with Phase 9's key infra), QARP leaderboard once more names have crawled fundamentals.
- [x] **Phase 9:** News Digest — the **News tab** now opens with an **✦ AI digest** over the recent Finnhub headlines: 3–5 main points, a sentiment chip, dated catalysts, and concrete risks — structured output (JSON schema) from `claude-opus-4-8`, seeded ONLY with the shown headlines (no outside facts), cached 12h per symbol in `news_digests`, labeled "AI summary — verify sources". Key-gated: it lights up when the Anthropic key lands in Settings. The **AI market brief** in Discover shares the same infra.
- [x] **Prediction track record + hypothesis engine (2026-07-12):** the app (and its AI) now write their forecasts down and get graded. (1) Every collector run TIMESTAMPS the engines' outputs per watchlist symbol into `prediction_snapshots` — signal tilt (scored vs 3-month excess return over SPY), Buffett QARP percentile (1-year), IV Rank extremes (1-month mean reversion); once a snapshot's horizon passes it's scored against the bar cache, misses kept forever — the **Track record** section in ⛁ Journal shows hit rates, average excess by call type, and the worst misses (survivorship-free by construction; expect humbler numbers than any backtest). (2) The **✦ Copilot can log hypotheses**: a `log_hypothesis` tool records falsifiable predictions (with horizon + confidence) as journal entries; when due, the **⚖ Review** button scores each against realized prices (+SPY excess) and — with a key — adds a blunt AI verdict: RIGHT/WRONG/MIXED and *why* (bad premise vs noise vs regime). (3) **✦ AI retrospective** reads the whole track record + resolved hypotheses and writes an honest "what's held up, what hasn't, what to adjust" (cached 24h). MCP gains `log_hypothesis` + `get_track_record`, so Claude Code can participate in the same accountability loop. `npx electron . --predict` runs a snapshot+score pass headlessly.

**Shipped (2026-07-12, second wave): stance engine + Fear & Greed + Description tab.**
- **Description tab** (bottom panel, next to Buffett Score) — what the symbol IS (FMP company/ETF profile: name, sector, industry, market cap, description; cache-first, one budgeted call for ETFs the crawl skips) and the **stance card**: a rule-based **BUY / HOLD / SELL** with a stated **timeframe** (6–18 months when quality/valuation dominates, 3–12 when momentum does) and a **confidence level** (low/medium/high from input agreement). The **(i)** popup shows the full arithmetic: QARP percentile (35%), signal tilt (35%), MA regime (15%), Fear & Greed contrarian at extremes (15%), renormalized over what's available, ±15 thresholds — every reason cites the actual values. Cautions cover earnings proximity and IV-rank entry timing. It is a synthesis of the app's own engines — labeled as such, never advice.
- **Stance accountability** — buy/sell stances on **★ starred** watchlist symbols are snapshotted daily (`stance` kind, graded vs SPY over each stance's own horizon) and appear as a card in the Journal's track record. Holds make no claim and are not recorded. Star a symbol to opt it in.
- **Fear & Greed (CNN)** — daily pull of CNN's composite (unofficial endpoint; browser UA required, cached in `fear_greed`, degrades to last reading if it breaks): a Discover panel with the 0–100 gauge + all seven components, an input to the stance engine (extremes only), context for the ✦ Copilot and market brief, and its own graded track-record card (`fear_greed` kind: extreme readings ≤25/≥75 vs SPY's next month — the contrarian thesis on its own scoreboard).
- **MCP** gains `get_stance` and `get_fear_greed` (16 tools total).
- *Audit fix (2026-07-12): SPY stances are graded on ABSOLUTE forward return — excess vs itself is identically zero and would have auto-failed every SPY call. Near-benchmark ETFs (VOO/VTI) are noted as low-information grades. Track-record disclosures now also flag that same-day snapshots share one market backdrop (effective sample < count).*

**Shipped (2026-07-12, third wave — the review's recommendations built out):**
- **⌂ Portfolio** — manual entry of REAL holdings (Fidelity/Robinhood expose no read API for individuals; SnapTrade-style aggregation is the future upgrade path): live-priced table with day/total P&L vs cost basis, weights, **concentration flags** (single name >25%, sector >40% across accounts), and each engine's read (QARP / tilt / stance) beside every position. Click-to-edit shares/cost, click symbol → chart. Keep-mounted view, refetches on activation. Data in the `positions` table; read-only `get_portfolio` MCP tool.
- **Realized vol + VRP** (Options tab) — RV21/RV63 from total-return bars (annualized close-to-close, log returns) next to IV30, and **IV − RV: the variance risk premium** — the "is premium actually rich vs reality?" check IV Rank can't be (it only compares IV to its own past). Negative VRP renders in caution color; every screener row's rationale carries the VRP line.
- **Screener liquidity + stress** — new **Spread column** (short-leg bid-ask as % of mid, warn >10%; the spread is crossed twice, and two-leg spreads pay it double — said explicitly in the rationale) and a **market-stress caution** on all rows when F&G ≤ 25 or IV Rank ≥ 90: premium is rich at extremes because crash risk is elevated; documented practice cuts size, never adds.
- **Reverse DCF** (Buffett tab) — the absolute-valuation anchor: solves the 10-year FCF growth rate that makes a two-stage DCF (terminal 2.5%) equal today's price, at 8/10/12% required returns, shown against trailing revenue/EPS CAGR. Only the FCF **yield** is needed (the market cap divides out). Earnings-yield fallback labeled; negative-FCF and ETF cases explained rather than silently blank. Verified live: AAPL price implies 15.6%/yr FCF growth vs a 7.4% trailing EPS CAGR. Deliberately display-only — **stance-engine inputs stay frozen** so recorded stance snapshots remain comparable. `get_reverse_dcf` MCP tool (18 total).

**Shipped alongside (2026-07-08):**
- **Backtester DCA modeling** — Start $ / Monthly $ inputs: contributions land at each month's first trading-day close, buy holdings pro-rata (costed), and the Contributions card reports **money-weighted (IRR) vs time-weighted** returns side by side with the GIPS-style explanation. Cashflow fields are excluded from the DSR trial hash (same strategy ≠ new trial). CLI: 7th positional arg of `--backtest` is monthly $.
- **⛁ Journal** — trade journal (thesis BEFORE, outcome AFTER — click an outcome cell to fill it in later) + **price/IV-Rank alerts**: one-shot thresholds checked on quote polls (~2 min while open) and each collector run, firing Windows notifications, then disarming.
- **Discover upgrades** — **QARP leaderboard** (top names by the Buffett engine's 65/35 quality/value composite among crawled fundamentals), **FRED macro panel** (fed funds, 10y, CPI YoY, dollar index — free `fred_key` in Settings), and the **✦ AI market brief**.

## Project assessment (2026-07-12 full review)

**Who it serves well today:** a self-directed investor building durable habits — every number ships with its derivation, its evidence base, and its caveat; predictions are graded; the journal forces thesis-before-outcome. The app's real product is *calibration*, not picks.

**For a Buffett-style investor, the biggest gap WAS an absolute valuation anchor** — every fundamental score is a percentile, *relative* to the tracked universe, and relative scores can't say "everything is expensive." *Addressed 2026-07-12:* the **Reverse DCF** section in the Buffett tab now inverts the price into an implied 10-year growth rate to judge against the trailing record. Still outside the app, by design or data limits: reading 10-Ks/proxies/transcripts (EDGAR facts ≠ filings), moat judgment (ROIC *persistence* — the app has levels, not 10-year trends), management/capital-allocation records (buyback history, insider ownership), and 10+ year statement history (free tiers give ~5).

**For an options trader, the biggest gap WAS realized volatility.** *Addressed 2026-07-12:* RV21/RV63 and **IV − RV (VRP)** now sit beside IV Rank in the Options tab, spread % is a screener column, and stress extremes add a sizing caution. Still beyond free data: OPRA-grade quotes, options flow, dealer positioning beyond naive GEX (vanna/charm), and portfolio Greeks (needs options positions).

**Structural limitations to keep in mind (all disclosed in-app):** IEX bars ≈ 8–10% of consolidated volume (prices can differ slightly from what a broker shows); the indicative options feed goes stale off-hours; momentum signals lag regime turns by construction (12-1 momentum stays bullish for months into a crash — the documented momentum-crash risk); the stance card is the *same* engines folded once more, so tab-agreement is not confirmation. The former "analyzes symbols, not your portfolio" gap is now covered by **⌂ Portfolio** (manual entry — a snapshot, not a broker sync; still tax/lot-blind).

**Calculation audit (this review):** conventions verified against their sources — percentile/QARP math, 12-1 momentum indexing, PEAD decay window, dividend-adjusted PEG, calendar-basis CAGR, full-sample Sortino, Bailey–López de Prado PSR/DSR (incl. expected-max-SR), Morningstar capture, type-7 VaR/CVaR, IRR bisection, tastytrade IV Rank, delta-approx PoP (labeled), naive GEX (share-gamma units, sign is the signal — labeled). One real defect found and fixed: SPY stance self-benchmark grading (above). Known acceptable approximations: expected move uses calendar-day √(30/365); options-tab IV Rank includes live IV in its bounds while alerts/predictions use snapshot-only history (they converge after each collector run).

## Future improvements (self-reference)

**Fundamentals gap coverage (researched 2026-07):** FMP's free tier gates certain symbols (list undocumented — observed: MU, MRVL, SNDK). Current solution is the **free fallback bundle**: SEC EDGAR companyfacts (official as-filed 10-K history; requires declared User-Agent, ≤10 req/s) + Finnhub `/stock/metric` basic financials (free, ~117 TTM ratios, NOT symbol-gated — margins/ROE/growth arrive in PERCENT units). Other free options evaluated: Alpha Vantage free covers full statements for all US symbols but at 25 req/day (usable only as a slow drip); yfinance still works but is an unofficial scraper with 429s. Not viable free: Tiingo (fundamentals paid), EODHD free (20 calls/day), Polygon/Massive free (price-only). **If the fallback ever falls short, the cheapest full unlock is FMP Starter at ~$22/mo** (EODHD Fundamentals ~$50–60/mo and Finnhub premium ~$50/mo are the alternatives).

**Data/API upgrade paths** (current stack is $0/month; hard ceiling for everything combined: **$100/month**):
- **marketdata.app Starter (~$12/mo)** — historical options data incl. IV/Greeks; would backfill IV Rank instantly instead of waiting out the cold start. Cheapest high-impact upgrade.
- **FMP Starter (~$22/mo, verified 2026-07)** — lifts the 250 req/day ceiling AND un-gates all symbols; faster universe refresh, deeper history.
- **Schwab Trader API ($0** + account) — real-time SIP quotes + options chains if Alpaca's indicative feed ever feels thin.
- **Large-scale factor research** (declared future goal): needs survivorship-bias-free history — Norgate Data or Sharadar (Nasdaq Data Link), historically ~$30–50/mo, delisted tickers included. Combined with FMP Starter this fits inside the $100 ceiling. Activating this is also the trigger to consider a Python sidecar (vectorbt) for research-scale backtests. ⚠️ Re-verify all prices at activation; they were last checked 2026-07.
- **Alpaca Algo Trader Plus (~$99/mo)** — full SIP + OPRA feeds; only if real-time precision ever matters. Would consume the entire ceiling; probably never worth it for analysis use.

**Feature ideas** (beyond the phased plan — the 2026-07 review's five recommendations all shipped 2026-07-12):
- **Dividend/DRIP tracking** — now feasible against the `positions` table: dividend history per holding (needs a data source — Alpaca corporate actions or budgeted FMP calls), income projection, DRIP share accrual for the Roth.
- **ETF look-through** — sector concentration currently counts single stocks only; decomposing QQQ/VOO/XLK into constituent sector weights would make the flags honest for ETF-heavy portfolios.
- **Portfolio options Greeks** — once options positions can be entered, aggregate delta/theta/vega across the account.
- **Earnings-implied move** — front-expiry straddle price vs the post-earnings expiry; the collected term structure already carries the raw ingredients.
- Earnings calendar is in (next-report tile + screener warning); a fuller IV-crush visualization around events remains open (term-structure inversion is already collected daily).
- FRED macro series (free API key) — rates/CPI/dollar index context for the gold/currency focus; natural fit for Phase 8 Discovery.
- Portfolio import: Fidelity/Robinhood positions are API-closed, but SnapTrade-style aggregators can read them — would enable "analyze what I actually own."
- Price/IV alerts (collector already runs daily; add threshold checks + Windows notifications).
- Dividend/DRIP tracking for the Roth IRA holdings.
- Position-sizing education module (Kelly criterion with the standard over-betting warnings).
- IV surface 3D visualization once enough snapshot history accumulates.
- CPCV (combinatorial purged cross-validation) as a backtester upgrade over walk-forward.
- Watch: Robinhood's "Agentic Trading" MCP beta (equities-only at launch) — could someday let the Claude copilot see the real account. Verified 2026-07: this is the ONLY sanctioned programmatic surface Robinhood has for equities; their official API remains crypto-only, and unofficial libraries (robin_stocks) violate ToS with documented account freezes.
- Robinhood Gold's **Morningstar research has no API/export** (in-app PDFs only; Morningstar's own API is enterprise-tier, ~$17.5k/yr+). Best workflow: read the report in Robinhood, then log the takeaway here — a journal note with the fair value estimate, or ask the ✦ Copilot to record it as a falsifiable hypothesis ("Morningstar FVE $X vs price $Y") so the ⚖ Review grades it later. Same for Gold's Nasdaq Level II data: UI-only, no programmatic access.

**Maintenance notes:**
- Version matrix is pinned conservatively (Electron 33 / Vite 5 / React 18); upgrade deliberately, re-run `npm run typecheck` + collector smoke test after.
- Provider adapters live behind interfaces — an API swap should touch one file.
- `fundamentals_snapshots` is append-only *on purpose* (point-in-time data for honest backtests). Never "clean it up."
- Free-tier terms drift: Alpaca/FMP/Finnhub capabilities were verified 2026-07; re-check before relying on them in new features.

**Chart behavior notes:**
- The dashed accent line + right-axis label is the **live current price**, updated on every streamed trade and visible wherever you pan/zoom.
- All chart times display in the **computer's local timezone, 12-hour clock**; "Open"/"Close" dots mark the 9:30am/4:00pm ET session boundaries on the 1D view.
- The 1D view loads the **last ~32 hours** so you can scroll back through after-hours into the prior session. Caveat: the free IEX feed covers ~4am–8pm ET — true overnight (8pm–4am) prints are sparse or absent; paid SIP/overnight data would be needed for full coverage.
- **Pattern inspector:** with Patterns on (default), every detected pattern's candles get a dashed tinted box; hovering any candle of a pattern (or clicking a pattern row in the Signals tab, which centers the chart ±40 bars and pins a solid brighter box) opens an inspector showing the prior-trend context, the measured shape criteria vs thresholds, volume vs its recent average, next-candle confirmation status, and the classical expectation — i.e., exactly the inputs classical candlestick analysis uses (Nison/Bulkowski), with the evidence caveat attached. Click the chart to dismiss a pinned pattern. Hover-inspection works even with the toggle off.
- **lightweight-charts v4 trap (cost a debugging session):** `timeScale().logicalToCoordinate()` silently returns `0` for any NON-INTEGER logical index — pass integer bar indices only and do half-bar padding in pixel space. Verified via the `--uitest` screenshot harness + `window.__rectsDebug` diagnostics.

## Troubleshooting

- **better-sqlite3 ABI errors on install/launch**: run `npx electron-rebuild -f -w better-sqlite3`. If it tries to compile from source, install "Visual Studio Build Tools" (C++ workload) first.
- **`safeStorage` unavailable**: keys fall back to obfuscated-but-unencrypted storage and the UI warns; fix Windows DPAPI (usually a domain/profile issue) before storing real keys.
- **Collector ran but no rows**: check `jobs_log` in the app's Status panel — most commonly missing Alpaca keys or a market holiday.
- **Scheduled task didn't fire**: it's registered with StartWhenAvailable, so a sleeping PC runs it on wake; check Task Scheduler → "InvestingApp IV Collector" → History.
- **FMP 402 "Premium Query Parameter"**: FMP's free plan gates some symbols entirely (seen: MRVL, MU, SNDK). The crawler marks them `fmp:unavailable` and moves on. Fixes: SEC EDGAR XBRL fallback (planned, Phase 2) or FMP Starter.
- **FMP legacy endpoints**: `/api/v3/` returns 403 for current accounts — the adapter uses `/stable/` with `?symbol=`; keep new endpoints in that style.
- **Stream shows "error 406"**: Alpaca allows ONE websocket connection per account — close other sessions using the same keys (including a second copy of this app).
- **Stream stuck on an auth error**: re-save the Alpaca keys in Settings; that clears the fatal-auth flag and reconnects.

## Disclaimers

Personal-use analysis tool. Nothing it displays is financial advice; strategy-screener defaults are *documented industry practice*, not recommendations. Data feeds are free tiers with known gaps (IEX-only bars, indicative options feed, survivorship bias) — the UI labels these, and so should any conclusions you draw.
