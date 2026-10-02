# Investing App — Research Report & Feature Design

**Date:** 2026-07-07 · **Produced by:** deep-research workflow (105 agents: 5 search angles → 23 sources fetched → 107 claims extracted → top 25 adversarially verified by 3-vote panels: 23 confirmed, 2 refuted) plus a 3-agent supplemental pass (candlesticks, backtesting, options pedagogy — lean, not adversarially verified; flagged ⚠️ where sources are weak).

**Locked-in context:** Electron + React + TypeScript · Free data stack: Alpaca (quotes, options chains with Greeks/IV), Financial Modeling Prep free tier + SEC EDGAR (fundamentals), Finnhub free tier (news, quotes) · User focus: tech-sector stocks and ETFs · Options level: intermediate + advanced education tab.

---

## 0. Governing architecture principle: two engines, honestly labeled

The research's strongest cross-cutting conclusion. Buffett-style **stock selection is codifiable and evidence-backed**; **short-term prediction is mostly a graveyard** and what little survives is weak and probabilistic. Berkshire's own factor loadings show *no* momentum exposure — Buffett does not chase trends ([Buffett's Alpha, NBER w19681](https://www.nber.org/system/files/working_papers/w19681/w19681.pdf)). So the app has:

1. **The Buffett Engine** — fundamentals scoring, no timing, long horizon.
2. **The Signal Monitor** (bull/bear module) — clearly labeled probabilistic tilts with confidence bands and a plain-language "most published predictors fail out-of-sample" disclosure.

They never blend into a single "buy/sell" number.

---

## 1. The Buffett Engine (verified findings)

### 1.1 Buffett is decodable — the core scoring model *(high confidence, 3-0 verified)*

[Frazzini, Kabiller & Pedersen, "Buffett's Alpha"](https://www.nber.org/system/files/working_papers/w19681/w19681.pdf) (Financial Analysts Journal 2018): Berkshire's alpha — the highest Sharpe (0.76) of any US stock or fund with 30+ year history — becomes **statistically insignificant** (~0.3%/yr) once regressed on Betting-Against-Beta and Quality-Minus-Junk factors. His selection reduces to three screenable characteristics:

| Dimension | Definition | Computable from |
|---|---|---|
| **Cheap** | Value: low price-to-book | FMP fundamentals + price |
| **Safe** | Low beta, low volatility | Alpaca price history |
| **Quality** | Profitable, stable, growing, high payout | FMP/EDGAR statements |

A rules-based portfolio on these themes performed comparably to Berkshire. **Caveat (authors' own):** simulated, gross of costs, hindsight-fit — this proves *codifiability*, not that the engine will beat the market.

### 1.2 Quality: the best-documented pillar *(high confidence, verified)*

[Asness, Frazzini & Pedersen, "Quality Minus Junk"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2312432) (Rev. Accounting Studies 2019): long-quality/short-junk earned 55–68 bps/month abnormal US returns 1956–2012 (t up to 11.2), positive in 23 of 24 countries, IR > 1. [AQR publishes the factor data monthly](https://www.aqr.com/Insights/Datasets/Quality-Minus-Junk-Factors-Monthly) — use it to **validate our implementation**.

- Build the quality score at the **pillar level**: Profitability, Growth, Safety (+ Payout as a variant). ⚠️ The exact sub-variable z-score recipe circulating online was **refuted in verification (0-3)** — implement pillars from statement data and calibrate against AQR's published factor returns rather than trusting any one blog's variable list.
- **QARP ("quality at a reasonable price")** beats quality or value alone (Sharpe ~0.7 US / ~0.9 global), optimal mix ~60–70% quality. The authors trace the idea to Graham & Dodd 1934. → Show separate Value and Quality sub-scores plus a QARP composite.

### 1.3 The Lynch screen *(high confidence, 3-0 verified — AAII's codification, not Lynch's own)*

From [AAII's codified Lynch strategy](https://www.aaii.com/journal/article/10631-peter-lynch-and-investing-in-what-you-know):
- **Dividend-adjusted PEG** = P/E ÷ (EPS growth + dividend yield); pass ≤ 0.50, poor > 1.0.
- **Growth bounded both sides:** target 20–25% EPS growth; **exclude >50%** five-year average growth as unsustainable — directly relevant to hot tech names.
- **Relative P/E:** below both the company's own 5-year average and its industry median (needs 5 years of positive earnings + price history, and industry-peer medians — FMP provides peers/ratios).

### 1.4 Piotroski F-score: input, not screen *(high confidence, verified)*

Under value-weighted testing the F-score long-short earns only 0.29%/month (t = 1.11) vs the famous 1.96% equal-weighted result ([Hou/Xue/Zhang 2020](https://global-q.org/uploads/1/2/2/6/122679606/houxuezhang2020rfs.pdf)). Include as **one labeled input with an on-screen caveat**; prefer the **quarterly variant** (0.52%/month, t = 2.32 — replicates).

### 1.5 Supporting concepts (⚠️ not adversarially verified — extracted claims from sources fetched before a rate-limit interruption; formulas are well-established in primary texts)

- **Owner earnings** (Buffett's 1986 letter): reported earnings + depreciation/amortization/non-cash charges − *maintenance* capex. Differs from FCF, which subtracts *total* capex — naive FCF understates owner earnings for growing companies. Maintenance capex is rarely disclosed; standard estimators: depreciation as proxy, or asset-turnover method. → Show owner earnings with the estimation method labeled.
- **Graham's defensive/enterprising screens** reduce to exact rules (current ratio ≥ 2, ten years positive earnings, P/E ≤ 15 on 3-yr average earnings, P/E × P/B ≤ 22.5, etc.) — implementable as an educational "Graham view," with the caveat that a Portfolio123 backtest shows decay in the most recent decade and almost no mega-cap tech passes.
- **Expectation-setting (important):** Validea's live mechanically-codified Buffett portfolio since 2003 returned ~9.2%/yr vs S&P 500's ~9.1% — market-like, not market-beating. The app should display this honesty note in the Buffett Engine's "About" panel.

---

## 2. The Signal Monitor — bull/bear rating (verified findings)

### 2.1 What the evidence allows *(high confidence, all 3-0 verified)*

- **Market/ETF-level prediction is near-impossible:** re-testing 46 predictor variables through 2021, over a third fail even in-sample; of survivors, half fail out-of-sample; monthly OOS R² < 1% even in pro-predictability studies ([Goyal, Welch & Zafirov, RFS 2024](https://academic.oup.com/rfs/article/37/11/3490/7749383)).
- **Stock-level anomaly ordering:** 65% of 452 published anomalies fail replication (82% under multiple-testing hurdles), **but momentum (63% replicate) and investment/profitability fundamentals (74%/44%) are the robust categories**; liquidity/microstructure signals fail 96% of the time ([Hou/Xue/Zhang 2020](https://global-q.org/uploads/1/2/2/6/122679606/houxuezhang2020rfs.pdf)). Counterpoint to cite in-app: Jensen/Kelly/Pedersen (JF 2023) find better replication under Bayesian methods — with the *same* category ordering.
- **Market-timing backtests are systematically overstated** (data-mining bias + ignored frictions): [Zakamulin 2014](https://link.springer.com/article/10.1057/jam.2014.25); momentum technical-rule profits on DJIA stocks were confined mainly to the mid-1960s–mid-1980s ([Taylor 2014](https://www.sciencedirect.com/science/article/abs/pii/S0378426613004664)).

### 2.2 Candlesticks & historical analogues (supplemental pass — the user's question)

**Verdict: education and annotation, not prediction.**

- The canonical test — [Marshall, Young & Rose 2006](https://www.sciencedirect.com/science/article/abs/pii/S0378426605002116), 28 candlestick strategies, DJIA stocks, bootstrap methods — found **no value for investors**; their Japanese-market replication agreed. Scattered later exceptions (Taiwan/Thailand, Gravestone Doji contrarian ⚠️) are market-specific and likely data-snooped.
- [Lo, Mamaysky & Wang 2000](https://www.nber.org/papers/w7613): chart patterns carry *some statistical information* about return distributions but no demonstrated net-of-cost profits.
- A 2023 test of [6,406 technical rules](https://link.springer.com/article/10.1007/s11408-023-00433-2): in-sample winners largely disappear out-of-sample; recent best performers subsequently underperform buy-and-hold. Nearest-neighbor/historical-analogue prediction lacks robust cost-adjusted validation ⚠️.
- Industry practice matches: thinkorswim and TradingView render candle patterns as **chart annotations/studies**, not signals.

→ **App behavior:** detect and label patterns on the chart with an explainer ("what this pattern is, what the evidence says"), never as a buy/sell trigger. The "similar past episodes" idea lives in the education layer as context, not in the rating.

### 2.3 What goes into the rating (and how it's shown)

| Input | Evidence | Horizon |
|---|---|---|
| 12-1 month momentum | HXZ replicating category | 3–12 mo |
| Profitability/investment fundamentals | HXZ replicating category | quarters |
| Post-earnings-announcement drift (SUE) | [Bernard & Thomas 1989](https://ideas.repec.org/a/bla/joares/v27y1989ip1-36.html): ~2%/side over 60 trading days | ~3 mo |
| Analyst revision momentum | drift in revision direction ~1–6 months | 1–6 mo |
| News sentiment (Finnhub) | short-horizon only, days–2 months, fades/reverses ⚠️ | days–wks |
| MA regime state | **descriptive only** ("price above 200-day MA"), with base rates | n/a |

**Presentation rules (evidence-mandated):** probabilistic tilt (e.g., "weak bullish tilt"), confidence bands, per-input attribution, the "most published predictors fail" disclosure, and a visible wall between this module and the Buffett Engine.

---

## 3. Options Section

### 3.1 Core metrics *(verified 3-0 against tastytrade/Alpaca primary docs)*

- **IV Rank** = (current IV − 52-wk low) / (52-wk high − 52-wk low). **IV Percentile** = % of past ~252 trading days with IV below current. They diverge after IV spikes — **show both, labeled**.
- **Expected move:** ~ price × IV × √(DTE/365), rendered as a shaded one-standard-deviation (~68%) band, explicitly labeled "statistical range, not a prediction" (tastytrade's documented pedagogical framing).
- **Data constraint (verified):** Alpaca's free chain snapshots include per-contract Greeks + IV but **no historical-IV endpoint** → the app must persist a daily underlying-level IV snapshot (~30-DTE ATM) in SQLite. IV Rank shows "partial history" labeling during the ~1-year cold start. **Start the collector on day one.**

### 3.2 Probability of profit & strategy screening (supplemental ⚠️ unless noted)

- **PoP** (tastytrade definition, primary doc): probability the position makes ≥ $0.01, from the distribution over the P/L graph. **P50** (prob. of reaching 50% max profit) is Monte-Carlo, not closed form.
- **Delta vs N(d2):** delta always overstates the probability of expiring ITM; N(d2) is the risk-neutral ITM probability. Teach the distinction; compute both.
- **Strategy screener defaults** (documented practice, not advice ⚠️): ~45 DTE entry, ~20–30 delta short strikes, manage at 50% max profit or 21 DTE; backtests report ~70–75% win rates for 25–30Δ / 45 DTE held-to-expiry ⚠️. Screen covered calls, cash-secured puts, verticals against IV Rank + these mechanics.

### 3.3 Advanced / professional education tab

- **IV skew:** 25-delta risk reversal = IV(25Δ call) − IV(25Δ put); equity indexes typically negative (put smirk from crash-protection demand). 25Δ is the standard reference (ATM measures level; 5–10Δ wings are noisy ⚠️).
- **Term structure:** ATM IV by expiration; contango normal, inversion (front > back) = event risk — e.g., earnings IV spike.
- **Dealer gamma exposure (GEX)** *(formula verified 3-0; single non-peer-reviewed source — medium confidence)*: GEX = Γ × OI × 100 (calls) + Γ × OI × (−100) (puts), summed over all strikes/expirations ([SqueezeMetrics white paper](https://squeezemetrics.com/monitor/download/pdf/white_paper.pdf)). Computable from Alpaca Greeks + open interest (~1-day OCC lag). Ship as a **pedagogical "naive GEX" visualization with the explicit disclosure** that dealer positioning is an unobservable assumption; no verified evidence of predictive value.

---

## 4. Backtesting (supplemental pass — the user's question)

**Verdict: favorable — build it — but as the app's honesty instrument, not a prediction booster.** Its job is to show how any signal or screen *would have* performed, with bias controls that keep it from lying to you.

### 4.1 Methodology (the part that matters)

- **Event-driven engine over daily bars, custom TypeScript.** The JS/TS library ecosystem is thin and dormant (Grademark ⚠️) — nothing near Python's vectorbt/zipline. An event-driven loop (process bar t → decide → fill at t+1 open or t close + haircut) is modest effort and **structurally prevents lookahead bias**.
- **Walk-forward / out-of-sample splits** (Pardo); 2024 research finds combinatorial purged CV even better at false-discovery control — walk-forward is the pragmatic v1.
- **Overfitting control:** track the number of strategy configurations tried and report a [deflated Sharpe ratio](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551) (Bailey & López de Prado) — overfitted backtests systematically fail live.
- **Costs:** haircut every round trip ~15–30 bps (commission + slippage) ⚠️; fills at close + fixed slippage is the accepted daily-bar convention ⚠️.

### 4.2 Data constraints on $0 (verified against Alpaca docs)

- Alpaca Basic: **daily/intraday bars back to ~2016, IEX-feed-only** (~8–10% of volume), 200 calls/min, last 15 min restricted. Fine for daily-bar strategies on liquid tech names/ETFs; do not trust for minute-bar backtests ⚠️.
- **Survivorship bias is the real limit:** a survivorship-biased universe is missing most stocks that traded 10 years ago ⚠️, and FMP/EDGAR don't reliably cover delisted price history. Mitigations: backtest **broad index ETFs** (QQQ/XLK/SPY — immune by construction), keep single-stock tests to recent years, and stamp every single-stock backtest with a visible **"current-universe bias: results overstated"** warning.

### 4.3 Historical analogues

Not favorable as a prediction input (§2.2). Favorable as *context education*: "here are past episodes with similar regime characteristics and the distribution of what followed" — shown with base rates, never as a forecast.

---

## 5. App design & Claude integration

- **Stock dashboard template:** Simply Wall St's scoring model is [open-sourced](https://github.com/SimplyWallSt/Company-Analysis-Model/blob/master/MODEL.markdown) — checks/thresholds across Value, Future, Past, Health, Dividend, each 0–6. Adapt the radial "snowflake" pattern for our five axes: **Value, Quality, Safety, Growth, Buffett-fit (QARP)**.
- **Options analyzer pattern:** OptionStrat/thinkorswim-style strategy builder with P/L diagram, PoP, Greeks per leg.
- **Claude copilot (optional module):** Claude API via the official TypeScript SDK from the Electron main process; the copilot's prompts are **grounded in the app's computed metrics** (it explains and cross-examines the numbers; it never generates its own predictions), inheriting the honest-labeling rules. Expose app data through a small local MCP server so Claude Code can query the same engines during development and analysis sessions. Verify current model/pricing details at implementation time.

### Feature list (mapped to evidence and data source)

| # | Feature | Research basis | Data |
|---|---|---|---|
| 1 | Buffett Score: Value + Quality + Safety sub-scores → QARP composite | §1.1–1.2 (verified) | FMP/EDGAR + Alpaca prices |
| 2 | Lynch screen (div-adj PEG, growth band, relative P/E) | §1.3 (verified) | FMP (5-yr history, peers) |
| 3 | Owner-earnings & intrinsic-value panel, margin-of-safety slider | §1.5 (⚠️ education) | FMP/EDGAR |
| 4 | Quarterly F-score as labeled input | §1.4 (verified) | FMP quarterly |
| 5 | Honest-expectations "About" panel (Validea track record, costs caveat) | §1.5 (⚠️) | static |
| 6 | Snowflake-style 5-axis stock visual | §5 | computed |
| 7 | Bull/bear tilt: momentum + fundamentals + PEAD + revisions + sentiment, probabilistic display with attribution & disclosures | §2.1, 2.3 (verified core) | Alpaca + FMP + Finnhub |
| 8 | Candle-pattern detection as chart annotations + explainers | §2.2 | Alpaca bars |
| 9 | Options chain + Greeks/IV browser | §3.1 (verified) | Alpaca free |
| 10 | IV Rank & IV Percentile with local daily IV store (cold-start labeled) | §3.1 (verified) | Alpaca + SQLite |
| 11 | Expected-move band on charts | §3.1 (verified) | Alpaca |
| 12 | PoP/P50/N(d2)-vs-delta panel | §3.2 (⚠️ practice) | computed |
| 13 | CC/CSP/vertical screener with mechanics defaults | §3.2 (⚠️ practice) | Alpaca chains |
| 14 | Advanced tab: skew (25Δ RR), term structure, naive GEX — all pedagogical | §3.3 | Alpaca chains |
| 15 | Backtester: event-driven TS engine, walk-forward, deflated Sharpe, cost haircuts, survivorship warnings | §4 | Alpaca bars 2016+ |
| 16 | Historical-analogue explorer (education, base rates) | §2.2, §4.3 | Alpaca bars |
| 17 | Watchlist/dashboard (tech ETFs + stocks), Finnhub news feed | user profile | Finnhub |
| 18 | Claude copilot + local MCP server for Claude Code | §5 | Claude API |

---

## 6. Refuted claims (do not build on these)

1. The exact QMJ sub-variable z-score recipe (0-3 refuted) — implement at pillar level, validate against AQR data.
2. "Technical-rule profits strictly required short-selling" (1-2 refuted) — not relied on.

## 7. Open questions

- Exact quality-pillar variable selection → resolve empirically by calibrating to AQR's downloadable monthly factor returns.
- Sector adjustment: P/B-based value is unkind to asset-light tech — consider earnings/FCF-yield variants alongside P/B, clearly labeled (the research verified P/B as *Buffett's* documented metric; alternatives are our extension).
- Alpaca/FMP/Finnhub free-tier terms are vendor policies verified as of 2026-07 — re-verify at build time.

## 8. Sources (primary, verified)

Buffett's Alpha (NBER w19681/FAJ 2018) · Quality Minus Junk (RAS 2019 + AQR dataset) · Goyal/Welch/Zafirov (RFS 2024) · Hou/Xue/Zhang (RFS 2020) · Zakamulin (JAM 2014) · Taylor (JBF 2014) · Marshall/Young/Rose (JBF 2006) · Lo/Mamaysky/Wang (NBER w7613) · Bailey & López de Prado (2014) · Bernard & Thomas (1989) · AAII Lynch codification · tastytrade support docs · SqueezeMetrics white paper · Alpaca market-data docs · Simply Wall St open model · Claude TypeScript SDK docs. Supplemental single-source facts are marked ⚠️ throughout.
