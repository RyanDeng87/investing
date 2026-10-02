# Implementation Plan

**Date:** 2026-07-07 · Companion to `RESEARCH.md` (evidence base and feature list). This document: architecture evaluation, problem analysis, revisions, phased build plan, and the paper-trading decision.

---

## 1. Framework evaluation: is Electron + React + TypeScript enough?

**Verdict: yes — no revision needed — with two structural additions** (worker threads for compute, a headless collector process for daily data). Feature-by-feature:

| Feature class | Demand | Electron/TS verdict |
|---|---|---|
| Dashboards, snowflake visual, chain browser | UI rendering | ✅ React + `lightweight-charts` (candles) + SVG/visx (analytics) |
| Buffett Engine scoring | arithmetic over ~100–600 cached fundamentals rows | ✅ trivial in TS |
| Options math (Black-Scholes, N(d2), IV solve, expected move, GEX) | closed-form + Newton's method | ✅ small hand-written `quant/` module, unit-tested against known values |
| P50 / probability panels | Monte Carlo ~10⁴–10⁵ paths | ✅ TS in a `worker_thread` (~ms–s); no Python needed |
| Backtester | event loop over ~2,500 daily bars × strategies | ✅ TS in a `worker_thread`; keeps UI responsive |
| Pattern detection (candles) | rule checks per bar | ✅ trivial |
| Local persistence | fundamentals cache, IV history, backtest runs | ✅ `better-sqlite3` (synchronous, fast, main process) |
| Daily IV snapshot | **must run even when app is closed** | ⚠️ needs a headless collector (see §3.1) |
| Claude copilot + MCP server | HTTP/stdio server + SDK calls | ✅ Node in main process |

The Python-sidecar question is settled: nothing in the feature list exceeds TS + worker threads.

**Large-scale factor research (declared future goal, hard budget ceiling: $100/month total across all subscriptions).** Feasible within the ceiling (⚠️ verify prices when activated): a survivorship-bias-free US equity history provider (Norgate Data or Sharadar via Nasdaq Data Link — historically the ~$30–50/mo class, delisted tickers included) plus FMP Starter (~$20–30/mo) for broad fundamentals, layered on the existing free stack. Architecture prep baked in now: `fundamentals_snapshots` is append-only point-in-time from day one, and provider adapters are swappable. If/when this activates, that is also the moment to consider a Python sidecar (vectorbt) for research-scale backtests — not before.

**Process architecture:**

```
┌─ Electron main process ─────────────────────────────┐
│ data layer: API clients (Alpaca/FMP/Finnhub)        │
│ rate-limit budgeter · SQLite (better-sqlite3)       │
│ job scheduler (refresh queues) · MCP server (later) │
├─ worker_threads ────────────────────────────────────┤
│ backtester · Monte Carlo · bulk scoring             │
├─ renderer (React) ──────────────────────────────────┤
│ typed IPC via contextBridge; no API keys in renderer│
└─────────────────────────────────────────────────────┘
+ headless collector script (node, Task Scheduler)    
```

Key storage: Electron `safeStorage` (DPAPI on Windows) — never plaintext config, never in the renderer.

---

## 2. Problems found & how to solve them

### 2.1 The cross-sectional scoring problem (the big one)

QMJ-style quality and value scores are **relative** — a stock is "high quality" versus a universe, via z-scores/percentiles. But FMP free tier = **250 requests/day**, so we cannot score the whole market. Naive per-ticker scoring would silently produce garbage ("z-score against what?").

**Solution: a Universe Manager.**
- Define a fixed scoring universe: **Nasdaq-100 + S&P 500 tech/communication constituents + user watchlist** (~150–200 tickers) — matches the user's focus.
- Fundamentals refresh is a **rolling crawl**: ~40–60 tickers/day within the FMP budget → full universe refreshes every ~3–4 days (fundamentals change quarterly; this is plenty).
- All scores displayed as **percentile within universe, labeled** ("Quality: 87th percentile of tech universe"), never as absolute universal claims.
- SQLite stores point-in-time fundamentals snapshots (append-only) — this doubles as the beginning of a point-in-time database for honest backtesting later.
- Calibration: monthly job compares our quality pillar ranks against AQR's downloadable QMJ factor data direction (RESEARCH.md §1.2, open question resolved empirically).

### 2.2 The daily IV collection problem

Alpaca has no historical IV; missed days are gone forever. A desktop app isn't reliably open at 3:50pm ET.

**Solution:** a small headless Node script (`collector.mjs`, shares the app's data layer) registered in **Windows Task Scheduler** (weekdays ~3:50pm ET): snapshot ~30-DTE ATM IV + chain summary (skew, term structure points, GEX inputs) for the watchlist into SQLite. The app also runs an on-launch catch-up ("no snapshot today and market open? collect now") and renders gap markers where days were missed. Install/verify the scheduled task from within the app's settings screen. **This ships in Phase 0.**

### 2.3 Rate-limit realities across all three APIs

One shared **budgeter** in the data layer: per-provider token buckets (FMP 250/day is the scarce one; Alpaca 200/min and Finnhub 60/min are generous), cache-first reads (SQLite TTLs: quotes seconds–minutes, chains minutes, fundamentals days), and a visible "data freshness" indicator per panel so stale never masquerades as live.

### 2.4 Smaller items

- **P/B for asset-light tech** (research caveat): show earnings-yield and FCF-yield value variants alongside P/B, labeled as our extension (RESEARCH.md §7).
- **IEX-feed quality:** fine for daily bars/liquid names; the app should not offer minute-bar backtests (grey the option out with the reason).
- **Vendor drift:** free-tier terms verified 2026-07; data layer isolates each provider behind an interface so a swap (e.g., to marketdata.app $12/mo) touches one adapter.

---

## 3. Paper trading: external vs internal — **decision: external, via Alpaca Paper Trading API**

The question: when the app can generate screens/signals, how does it *test itself* forward?

| Criterion | A. Alpaca Paper API (recommended) | B. Build internal simulator | C. Robinhood agentic/MCP beta |
|---|---|---|---|
| Cost | $0 (paper keys on existing account) | $0 but big build effort | $0 |
| Fill realism | Real-time simulated fills vs live quotes, server-side | Only as good as our fill model | unknown, beta |
| Stocks + ETFs | ✅ | ✅ (we'd build) | equities only at launch |
| Options | ✅ (paper supports options; **verify multi-leg level support at build time**) | would duplicate huge complexity (assignment, expiration) | ❌ |
| Bookkeeping (positions, P&L, history) | ✅ server-side, queryable API | we'd build & debug all of it | ❌ |
| Path to real trading someday | same API, swap base URL | none | immature |
| Independence | needs internet + Alpaca ToS | fully local | external + beta risk |

**Rationale:** we already have the Alpaca account for data; paper trading is the same SDK with paper keys; options paper trading exists (multi-leg support level to be verified when Phase 6 starts); and it gives *forward*, out-of-sample validation — which the research says is exactly what backtests systematically overstate (RESEARCH.md §4.1). Building an internal simulator would mostly duplicate the backtester while producing less realistic fills.

**Division of labor:** the **backtester** answers "how would this have done historically" (with bias controls); **Alpaca paper** answers "how does this actually do from today forward." Both consume the same **Strategy Contract** so a strategy is defined once:

```ts
interface Strategy {
  id: string;
  universe(): string[];                          // tickers
  onBar(ctx: MarketContext): Signal[];           // backtest + live paper share this
  sizing(signal: Signal, portfolio: Portfolio): Order[];
}
```

A "Self-Test" dashboard then shows, per strategy: backtest expectation (deflated Sharpe, drawdown) vs paper-trading reality, with divergence flagged. The app grades itself.

---

## 4. Phased build plan

Each phase ends runnable and verified (formula unit tests against known values; `npm run verify` grows per phase).

**Phase 0 — Scaffold + IV collector (the clock starts now)**
- electron-vite + React + TS + `better-sqlite3`; typed IPC scaffold; `safeStorage` key vault; settings screen (API keys, watchlist seed).
- SQLite schema v1: `tickers`, `fundamentals_snapshots` (point-in-time), `daily_bars`, `iv_snapshots`, `jobs_log`.
- `collector.mjs` + Task Scheduler registration + on-launch catch-up. **Exit criteria: IV snapshots accumulating daily.**

**Phase 1 — Data layer + Universe Manager**
- Alpaca/FMP/Finnhub adapters behind interfaces; rate budgeter; cache-first repository; rolling fundamentals crawl; freshness indicators.

**Phase 2 — Buffett Engine**
- Quality pillars (profitability/growth/safety), value variants (P/B + earnings/FCF yield), safety (beta/vol) → percentile scores → QARP composite; Lynch screen; quarterly F-score; owner-earnings panel (estimation method labeled); snowflake visual; honest-expectations About panel; AQR calibration job.

**Phase 3 — Charts + Signal Monitor**
- Candlestick charts (`lightweight-charts`); pattern annotations + explainers; MA regime descriptor with base rates; tilt gauge: momentum + fundamentals + PEAD + revisions + sentiment, with per-input attribution, confidence bands, disclosures. Hard visual separation from the Buffett Engine.

**Phase 4 — Options section**
- Chain browser (Greeks/IV); IV Rank & Percentile off the local store (cold-start labels); expected-move band; PoP/N(d2)/delta panel; CC/CSP/vertical screener (mechanics defaults, "documented practice, not advice"); advanced education tab: 25Δ risk reversal, term structure, naive GEX with assumption disclosure.

**Phase 5 — Backtester**
- Event-driven engine in a worker; walk-forward splits; trial counter + deflated Sharpe; 15–30 bps cost haircuts; ETF-first universes; survivorship warning stamped on single-stock results; results persisted for the Self-Test dashboard.

**Phase 6 — Paper trading (Alpaca)**
- Verify current options paper capabilities (multi-leg level); Strategy Contract; order routing to paper endpoint; positions/P&L sync; Self-Test dashboard (backtest expectation vs paper reality).

**Phase 7 — Claude copilot + MCP**
- Local MCP server exposing engines/data (also usable from Claude Code); copilot panel via Claude TS SDK, grounded in computed metrics only, inheriting honest-labeling rules. Verify current model/pricing at build time.

**Phase 8 — Market Discovery (broad-market recommendations)**
Purpose: surface *promising candidates* — stocks, ETFs, and sectors — from the broader market so the user isn't limited to the watchlist. Discovery ranks candidates using the SAME evidence-backed engines (momentum/signals, Buffett quality scores); it is a funnel into vetting, never a buy list. Tuned to the user's focus: tech (including quantum computing), broad basket ETFs (VOO/VTI/SPY/VXUS), and currency trackers (gold etc.).
- **Discovery universe** (bars-only tracking added to the daily job, ~50 extra Alpaca calls — free): 11 sector SPDRs (XLK…XLC), tech/thematic ETFs (SMH, SOXX, IGV, VGT, QTUM), quantum names (IONQ, RGTI, QBTS — verify tickers at build), broad ETFs (SPY, VOO, VTI, QQQ, IWM, VXUS), metals/currency (GLD, SLV, GDX, UUP, FXE), rates context (TLT). Store with a `kind` tag (sector/thematic/broad/currency/stock).
- **Screens** (new "Discover" view):
  1. *Sector rotation*: relative strength vs SPY over 1M/3M/6M/1Y per sector ETF — heatmap + rank changes (spot shifting sectors).
  2. *Movers*: top/bottom daily %, relative volume spikes, and 52-week-high proximity across all tracked symbols.
  3. *Signal leaderboard*: Signal Monitor tilt ranked across the universe (momentum from cached bars; Finnhub PEAD/revisions fetched on-demand for the top N within 60/min budget).
  4. *Quality leaders*: QARP top percentiles + "quality at the best price" screen from the Buffett engine.
  5. *Focus panels*: pinned tech/quantum watch, broad-ETF dashboard, gold/currency trackers.
  6. *AI market brief* (optional, uses Phase 9 key infra): computed tables sent to Claude → narrative context on movers/rotation/sentiment, with the standard disclosures.
- **Honesty rules**: every list is labeled "candidates ranked by <input> — evidence horizon <X>; start research here, not orders"; sector relative strength inherits the momentum-family evidence base and its caveats.

**Phase 9 — News Digest (AI summarization)**
Purpose: summarize pulled news stories into short main points, per symbol and per day.
- **Provider decision (researched via current API reference):** default to the **Claude API** with the official `@anthropic-ai/sdk` in the main process — it shares key/client infrastructure with Phase 7's copilot, so one key powers both. The digest module sits behind a small `LlmProvider` interface so an OpenAI-compatible key can be slotted in later if preferred; the user mentioned a GPT key — supported as an alternative adapter, but Claude-first keeps one integration surface.
- **Model & cost (estimated at ~30 headlines/day; verify pricing at build):** `claude-opus-4-8` ($5/$25 per MTok) ≈ **~$1.15/month** for daily digests; `claude-haiku-4-5` ($1/$5) ≈ ~$0.23/month. Default the digest model to `claude-opus-4-8` (cost is negligible at this scale); switch to Haiku only if scaling to full-article summarization across the whole universe (~5–10× volume). Model configurable in Settings.
- **Design:** API key stored in the existing DPAPI vault (`anthropic_key`); main-process `digest.ts` sends the cached Finnhub headlines+summaries for a symbol with **structured outputs** (`output_config.format` json_schema) returning `{mainPoints[], sentiment, catalysts[], risks[]}`; results cached in SQLite (`news_digests`, ~12h TTL). UI: "✦ Digest" button in the News tab renders the main points above the headline list with an "AI summary — verify against the linked sources" badge; optional daily digest for ★ favorites appended to the scheduled job.
- **Guardrails:** summaries cite which headlines they draw from (index references); no price predictions in the digest prompt; refusal/error paths degrade to the plain headline list.

**Sequencing note:** Phases 2–4 are independent after Phase 1 and can be reordered on interest; Phase 5 precedes 6 (Self-Test needs both). Phase 9's key/provider infrastructure is shared with Phase 7 — building 9 before 7 is fine and gives the copilot its plumbing; Phase 8's screens 1–5 need only Phases 1–3 engines and can come before 5/6.

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| FMP 250/day too tight even for rolling crawl | universe trim; FMP Starter (~$20–30/mo) or bulk EDGAR facts (free, more parsing) as escape hatches |
| Alpaca policy change (feed/paper terms) | adapter isolation; marketdata.app ($12/mo) fallback documented |
| IV cold start frustrates early options use | show IV% alongside partial-history IVR; label maturity date |
| Backtest overfitting despite controls | trial counter is mandatory, not optional; deflated Sharpe always displayed |
| Scope creep before data foundation exists | phase gates: no engine work until Phase 1 exit criteria met |
