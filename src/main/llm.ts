import Anthropic from '@anthropic-ai/sdk'
import { getDb, logJob } from './db'
import { getSecret, hasSecret } from './keyvault'
import { getSignals } from './signals'
import { scoreSymbol } from './scoring'
import { getOptionsAnalytics } from './options'
import { getNextEarnings } from './earnings'
import { getDiscovery } from './discovery'
import { getMacro } from './fred'
import { latestFearGreed } from './feargreed'
import { getNews } from './news'
import { getBars } from './bars'
import { listDueHypotheses, logHypothesis, resolveEntry, listJournal } from './journal'
import { getTrackRecord } from './predictions'
import type { CopilotReply, CopilotTurn, JournalEntry, MarketBrief, NewsDigest, Retrospective } from '../shared/types'

// Phase 7: Claude copilot (PLAN.md). The copilot is GROUNDED: it answers from
// the app's own computed engines (signals, Buffett score, options analytics,
// discovery), passed as JSON context — and it inherits the app's honest-
// labeling rules. It is a reading aid for numbers the app already shows,
// not an oracle. Model: claude-opus-4-8 with adaptive thinking.

const MODEL = 'claude-opus-4-8'

function client(): Anthropic | null {
  const key = getSecret('anthropic_key')
  return key ? new Anthropic({ apiKey: key }) : null
}

const COPILOT_SYSTEM = `You are the built-in copilot of a personal investing-analysis desktop app. The user is a retail investor (tech stocks + broad ETFs, Roth IRA at Fidelity, Robinhood account) learning professional habits.

You are given the app's COMPUTED data as JSON inside <app_data> tags: signal tilts, Buffett-style quality/value percentiles, options analytics, earnings dates, market discovery stats. Ground every claim in that data and name the field you used. If the data doesn't support an answer, say so plainly — do not fill gaps from general knowledge without labeling it as background knowledge.

Inherit the app's honest-labeling rules, always:
- Backtests describe one survivor-biased past; expect live results worse.
- Short-term signals are probabilistic tilts with weak evidence, not predictions.
- Candlestick patterns are chart annotations; the research says they don't predict.
- Expected moves are statistical ranges, not forecasts. IV Rank needs ~1 year of history to mean much.
- The Buffett score is a percentile within the app's tracked universe, not an absolute verdict.

NEVER give a buy/sell/hold instruction or personalized financial advice. Describe what the data shows, what the relevant framework (quality-at-a-reasonable-price, momentum evidence, options mechanics) would note, and the caveats. If asked "should I buy X", reframe: walk through what the app's data says and what questions the user should weigh.

HYPOTHESES: you have a log_hypothesis tool that records a falsifiable prediction into the user's journal, to be scored against real prices when its horizon passes (your misses are kept and reviewed — that accountability is the feature). Use it when your answer contains a genuine directional or falsifiable expectation, or when the user asks you to track one. At most one per answer; never log vague claims ("could go either way") — a hypothesis must be wrong-able. State in your reply that you logged it and when it comes due.

Style: compact and concrete — a few short paragraphs at most, plain language, numbers from the data. No headers, no bullet-list dumps unless listing is genuinely clearer.`

const COPILOT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'log_hypothesis',
    description:
      "Record a falsifiable prediction into the user's journal for later scoring against realized prices. Call when your answer states a directional/testable expectation with a timeframe, or the user asks to track one. The hypothesis text must be one wrong-able sentence plus its basis in the data.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker the prediction is about' },
        hypothesis: { type: 'string', description: 'One falsifiable sentence + the data-grounded basis' },
        horizon_days: { type: 'number', description: 'Calendar days until it should be evaluated (5-365)' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['symbol', 'hypothesis', 'horizon_days', 'confidence']
    }
  }
]

// Compact per-symbol context: hand-picked fields, not full engine dumps —
// keeps a copilot question to a few thousand input tokens.
async function buildContext(symbol: string): Promise<string> {
  const ctx: Record<string, unknown> = { symbol, asOf: new Date().toISOString() }
  try {
    const sig = await getSignals(symbol)
    ctx.signals = {
      tilt: sig.tilt,
      label: sig.label,
      confidence: sig.confidence,
      inputs: sig.inputs.map((i) => ({ key: i.key, value: i.value, contribution: i.contribution, evidence: i.evidence })),
      regime: sig.regime,
      disclosures: sig.disclosures
    }
  } catch (e) {
    ctx.signals = `unavailable: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    const score = await scoreSymbol(symbol)
    ctx.buffettScore = score.available
      ? {
          qarpPercentile: score.qarp,
          pillars: Object.fromEntries(Object.entries(score.pillars).map(([k, v]) => [k, v.percentile])),
          lynch: score.lynch.map((l) => `${l.label}: ${l.verdict}`),
          universeScored: score.universeScored,
          dataSource: score.dataSource,
          caveats: score.caveats
        }
      : `unavailable: ${score.message ?? 'no fundamentals yet'}`
  } catch (e) {
    ctx.buffettScore = `unavailable: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    const opt = await getOptionsAnalytics(symbol)
    ctx.options = opt.available
      ? {
          spot: opt.spot,
          iv30: opt.iv30,
          ivRank: opt.ivRank,
          ivHistoryDays: opt.ivDays,
          expectedMove30d: opt.expectedMove30d,
          skew25d: opt.skew25d,
          gexNaive: opt.gexNaive,
          screenerIdeas: opt.strategies.map((s) => `${s.label}: credit ${s.credit}, PoP ${s.pop}, ${s.dte} DTE`),
          caveats: opt.caveats
        }
      : `unavailable: ${opt.message ?? ''}`
  } catch (e) {
    ctx.options = `unavailable: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    ctx.nextEarnings = await getNextEarnings(symbol)
  } catch {
    ctx.nextEarnings = null
  }
  try {
    const disc = await getDiscovery(false)
    ctx.market = {
      spyReturns: disc.spyRet,
      momentumLeaders: disc.momentumLeaders.slice(0, 5).map((s) => `${s.symbol} ${s.mom121 != null ? (s.mom121 * 100).toFixed(0) + '%' : '?'}`),
      sectorLeaders: disc.sectors.slice(0, 3).map((s) => `${s.symbol} rel3m ${s.rel3m != null ? (s.rel3m * 100).toFixed(1) + '%' : '?'}`),
      caveats: disc.caveats
    }
  } catch {
    ctx.market = 'unavailable'
  }
  try {
    const macro = await getMacro()
    if (macro.available) {
      ctx.macro = Object.fromEntries(macro.series.map((s) => [s.label, `${s.latest}${s.units} (${s.date}, 1y ago: ${s.yearAgo ?? '?'})`]))
    }
  } catch {
    /* macro is optional */
  }
  try {
    const fg = latestFearGreed(5)
    if (fg) {
      ctx.fearGreed = {
        score: fg.score,
        rating: fg.rating,
        asOf: fg.date,
        caveat: 'CNN market-mood composite; contrarian evidence is weak outside extremes (≤25 / ≥75)'
      }
    }
  } catch {
    /* sentiment is optional */
  }
  return JSON.stringify(ctx)
}

function friendlyLlmError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic key rejected — re-check it in Settings.'
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit hit — wait a moment and retry.'
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API — check your connection.'
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

export async function askCopilot(symbol: string, question: string, history: CopilotTurn[]): Promise<CopilotReply> {
  const c = client()
  if (!c) {
    return { ok: false, text: '', error: 'Add an Anthropic API key in Settings to use the copilot (console.anthropic.com — pay as you go, cents per question).' }
  }
  const q = String(question ?? '').trim().slice(0, 4000)
  if (!q) return { ok: false, text: '', error: 'Empty question.' }
  const context = await buildContext(symbol)
  // Fresh context rides on the CURRENT question only; prior turns keep their
  // plain text (capped) so long chats don't accumulate stale data dumps.
  // The slice must START with a user turn — a leading assistant message
  // (possible when the renderer filtered out an errored exchange) is a 400.
  const trimmed = history.slice(-8)
  while (trimmed.length > 0 && trimmed[0].role !== 'user') trimmed.shift()
  const messages: Anthropic.MessageParam[] = [
    ...trimmed.map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
    { role: 'user' as const, content: `<app_data>${context}</app_data>\n\n${q}` }
  ]
  try {
    let logged = 0
    let inTok = 0
    let outTok = 0
    // Text accumulates ACROSS rounds — the narration often arrives in the
    // same round as the tool call, before the tool result comes back.
    const textParts: string[] = []
    let response: Anthropic.Message
    // Manual tool loop (≤3 rounds): the only tool is log_hypothesis, which
    // writes a journal row — the model narrates the log in its final text.
    for (let round = 0; ; round++) {
      response = await c.messages.create({
        model: MODEL,
        // max_tokens caps thinking + text together — leave adaptive thinking room.
        max_tokens: 6000,
        thinking: { type: 'adaptive' },
        system: COPILOT_SYSTEM,
        tools: COPILOT_TOOLS,
        messages
      })
      inTok += response.usage.input_tokens
      outTok += response.usage.output_tokens
      textParts.push(
        ...response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text)
      )
      if (response.stop_reason !== 'tool_use' || round >= 2) break
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        let resultText: string
        try {
          const input = block.input as { symbol?: string; hypothesis?: string; horizon_days?: number; confidence?: string }
          const entry = logHypothesis({
            symbol: String(input.symbol ?? symbol),
            hypothesis: String(input.hypothesis ?? ''),
            horizonDays: Number(input.horizon_days ?? 30),
            confidence: String(input.confidence ?? 'low'),
            author: 'copilot'
          })
          logged++
          resultText = `Logged as journal entry #${entry.id}; review due ${entry.horizonDate}.`
        } catch (e) {
          resultText = `Could not log: ${e instanceof Error ? e.message : String(e)}`
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: resultText })
      }
      if (results.length === 0) break
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: results })
    }
    if (response.stop_reason === 'refusal') {
      return { ok: false, text: '', error: 'The model declined this request.' }
    }
    let text = textParts.join('\n').trim()
    if (response.stop_reason === 'max_tokens') {
      if (!text) return { ok: false, text: '', error: 'The answer was cut off by the token limit before any text — try asking again.' }
      text += '\n\n[…answer truncated by the token limit]'
    }
    if (!text) return { ok: false, text: '', error: 'Empty response from the model — try again.' }
    // Rough cost note so spending stays visible ($5/M in, $25/M out).
    const cents = (inTok * 5 + outTok * 25) / 10_000
    return { ok: true, text, costCents: Math.round(cents * 100) / 100, logged }
  } catch (e) {
    logJob('copilot', 'error', friendlyLlmError(e))
    return { ok: false, text: '', error: friendlyLlmError(e) }
  }
}

// --- Hypothesis review: score due hypotheses against realized prices, with
// an AI verdict when a key exists (numbers-only otherwise). ---

// Return over [fromDate, toDate] — the GRADED window is the hypothesis's own
// horizon, not "to whenever the review button was clicked". Both legs read
// from the same table so dividend bases are never mixed.
function moveSince(symbol: string, fromDate: string, toDate: string): { ret: number; spyRet: number | null } | null {
  const db = getDb()
  for (const table of ['daily_bars_adj', 'daily_bars']) {
    const rows = db
      .prepare(`SELECT close FROM ${table} WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date ASC`)
      .all(symbol, fromDate, toDate) as { close: number }[]
    if (rows.length >= 2 && rows[0].close > 0) {
      const ret = rows[rows.length - 1].close / rows[0].close - 1
      const spy = db
        .prepare(`SELECT close FROM ${table} WHERE symbol = 'SPY' AND date >= ? AND date <= ? ORDER BY date ASC`)
        .all(fromDate, toDate) as { close: number }[]
      const spyRet = spy.length >= 2 && spy[0].close > 0 ? spy[spy.length - 1].close / spy[0].close - 1 : null
      return { ret, spyRet }
    }
  }
  return null
}

const pct1 = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

export async function reviewDueHypotheses(): Promise<{ reviewed: number; entries: JournalEntry[] }> {
  const due = listDueHypotheses()
  const c = client()
  let reviewed = 0
  for (const h of due) {
    // Backfill bars on demand so a symbol charted rarely can still score.
    await getBars(h.symbol).catch(() => [])
    const move = moveSince(h.symbol, h.date, h.horizonDate ?? new Date().toLocaleDateString('sv'))
    if (move == null) {
      // No price data — leave the hypothesis OPEN so a later review retries
      // once bars exist; resolving now would bury it unscored forever.
      logJob('hypothesis', 'partial', `${h.symbol} #${h.id}: no cached bars for the window — left open`)
      continue
    }
    const facts = `${h.symbol} moved ${pct1(move.ret)} from ${h.date} to ${h.horizonDate ?? 'today'}${move.spyRet != null ? ` (SPY ${pct1(move.spyRet)}, excess ${pct1(move.ret - move.spyRet)})` : ''}.`
    let verdict = ''
    if (c) {
      try {
        const r = await c.messages.create({
          model: MODEL,
          max_tokens: 2000,
          thinking: { type: 'adaptive' },
          system:
            'You grade a past market hypothesis against what actually happened. Verdict first — RIGHT, WRONG, or MIXED — then 2-3 blunt sentences on WHY, using only the supplied facts. If wrong, name the most likely reason the reasoning failed (bad premise, right premise but noise/timing, regime change). No hedging into vagueness, no advice.',
          messages: [{ role: 'user', content: `Hypothesis (logged ${h.date} by ${h.author}): ${h.thesis}\n\nRealized (graded over the hypothesis's own horizon): ${facts}` }]
        })
        verdict = r.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
      } catch (e) {
        // Transient API failure: leave OPEN for retry rather than resolving
        // with a misleading note — the key exists, the call just failed.
        logJob('hypothesis', 'error', friendlyLlmError(e))
        continue
      }
    }
    resolveEntry(h.id, verdict ? `${facts}\n\n${verdict}` : `${facts}\n\n(Add an Anthropic key for an AI verdict, or write your own — that works too.)`)
    reviewed++
  }
  return { reviewed, entries: listJournal() }
}

// --- AI retrospective over the prediction track record: what's been right,
// what's been wrong, and honestly WHY. Cached 24h. ---

const RETRO_TTL_MS = 24 * 60 * 60 * 1000

export async function getRetrospective(force = false): Promise<Retrospective> {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('prediction_retro') as { value: string } | undefined
  if (row && !force) {
    try {
      const cached = JSON.parse(row.value) as { at: number; text: string }
      if (Date.now() - cached.at < RETRO_TTL_MS) {
        return { available: true, text: cached.text, generatedAt: new Date(cached.at).toISOString() }
      }
    } catch {
      /* regenerate */
    }
  }
  const c = client()
  if (!c) return { available: false, text: '', generatedAt: '', message: 'Add an Anthropic key in Settings for the AI retrospective.' }
  const record = getTrackRecord()
  if (!record.available) return { available: false, text: '', generatedAt: '', message: record.message ?? 'No prediction snapshots yet.' }
  const resolved = listJournal()
    .filter((e) => e.status === 'resolved')
    .slice(0, 12)
    .map((e) => ({ date: e.date, symbol: e.symbol, author: e.author, thesis: e.thesis.slice(0, 300), outcome: e.outcome.slice(0, 300) }))
  try {
    const r = await c.messages.create({
      model: MODEL,
      max_tokens: 3000,
      thinking: { type: 'adaptive' },
      system:
        "You are reviewing the track record of an investing app's own signals plus logged hypotheses. Using ONLY the JSON, write: (1) one paragraph on what the record actually supports so far (mind the tiny sample sizes — say so); (2) one paragraph on the misses — the most likely REASONS they were wrong (bad premise vs noise vs regime), citing specific entries; (3) one line starting 'Adjust:' with the single most defensible process change. Blunt, concrete, no advice about buying anything. End with: 'Small samples — conclusions here are provisional by construction.'",
      messages: [{ role: 'user', content: JSON.stringify({ trackRecord: record.kinds, resolvedHypotheses: resolved }) }]
    })
    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) return { available: false, text: '', generatedAt: '', message: 'Empty response from the model.' }
    const at = Date.now()
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'prediction_retro',
      JSON.stringify({ at, text })
    )
    return { available: true, text, generatedAt: new Date(at).toISOString() }
  } catch (e) {
    const msg = friendlyLlmError(e)
    logJob('retrospective', 'error', msg)
    return { available: false, text: '', generatedAt: '', message: msg }
  }
}

// --- Phase 9: per-symbol AI news digest (structured output, cached 12h). ---

const DIGEST_TTL_MS = 12 * 60 * 60 * 1000
const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mainPoints', 'sentiment', 'catalysts', 'risks'],
  properties: {
    mainPoints: { type: 'array', items: { type: 'string' }, description: '3-5 one-line takeaways across the headlines' },
    sentiment: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'] },
    catalysts: { type: 'array', items: { type: 'string' }, description: 'upcoming dated events or decisions the news points to (may be empty)' },
    risks: { type: 'array', items: { type: 'string' }, description: 'concrete risks the news raises (may be empty)' }
  }
} as const

// Dedup concurrent generations per symbol (tab flips A→B→A within the TTL
// window must not double-spend on the same digest).
const digestInFlight = new Map<string, Promise<NewsDigest>>()

export async function getNewsDigest(symbol: string, force = false): Promise<NewsDigest> {
  const sym = symbol.trim().toUpperCase()
  const inFlight = digestInFlight.get(sym)
  if (inFlight && !force) return inFlight
  const p = doGetNewsDigest(sym, force).finally(() => {
    if (digestInFlight.get(sym) === p) digestInFlight.delete(sym)
  })
  digestInFlight.set(sym, p)
  return p
}

async function doGetNewsDigest(sym: string, force: boolean): Promise<NewsDigest> {
  const db = getDb()
  const empty: NewsDigest = { available: false, symbol: sym, generatedAt: '', fresh: false, mainPoints: [], sentiment: '', catalysts: [], risks: [], headlineCount: 0 }
  const row = db.prepare('SELECT generated_at, payload FROM news_digests WHERE symbol = ?').get(sym) as
    | { generated_at: number; payload: string }
    | undefined
  if (row && !force && Date.now() - row.generated_at < DIGEST_TTL_MS) {
    try {
      const cached = JSON.parse(row.payload) as NewsDigest
      return { ...cached, fresh: false }
    } catch {
      /* regenerate */
    }
  }
  if (!hasSecret('anthropic_key')) {
    return { ...empty, message: 'Add an Anthropic key in Settings for the AI news digest (on your to-do list).' }
  }
  const c = client()
  if (!c) return { ...empty, message: 'Anthropic key unavailable.' }
  try {
    const items = await getNews(sym)
    if (items.length < 3) return { ...empty, message: `Only ${items.length} recent headlines — not enough to digest.` }
    const headlines = items.slice(0, 25).map((n) => ({
      date: new Date(n.datetime * 1000).toISOString().slice(0, 10),
      source: n.source,
      headline: n.headline,
      summary: n.summary.slice(0, 240)
    }))
    const r = await c.messages.create({
      model: MODEL,
      // Caps thinking + JSON together — leave adaptive thinking room.
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system:
        'Digest news headlines about one stock for a retail investor. Use ONLY the supplied items; never invent facts, numbers, or events. mainPoints: the 3-5 takeaways that actually matter (deduplicate the noise); catalysts: only DATED or clearly upcoming items; risks: concrete, from the text. Sentiment reflects the set as a whole.',
      output_config: { format: { type: 'json_schema', schema: DIGEST_SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify({ symbol: sym, headlines }) }]
    })
    if (r.stop_reason === 'refusal') return { ...empty, message: 'The model declined to digest these headlines.' }
    if (r.stop_reason === 'max_tokens') return { ...empty, message: 'The digest was cut off by the token limit — reopen the tab to retry.' }
    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!text) return { ...empty, message: 'Empty response from the model — reopen the tab to retry.' }
    let parsed: Pick<NewsDigest, 'mainPoints' | 'sentiment' | 'catalysts' | 'risks'>
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      return { ...empty, message: 'The model returned malformed JSON — reopen the tab to retry.' }
    }
    const digest: NewsDigest = {
      available: true,
      symbol: sym,
      generatedAt: new Date().toISOString(),
      fresh: true,
      mainPoints: parsed.mainPoints ?? [],
      sentiment: parsed.sentiment ?? '',
      catalysts: parsed.catalysts ?? [],
      risks: parsed.risks ?? [],
      headlineCount: headlines.length
    }
    db.prepare(
      'INSERT INTO news_digests(symbol, generated_at, payload) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET generated_at = excluded.generated_at, payload = excluded.payload'
    ).run(sym, Date.now(), JSON.stringify(digest))
    logJob('news_digest', 'ok', `${sym}: ${headlines.length} headlines, ${r.usage.input_tokens}/${r.usage.output_tokens} tokens`)
    return digest
  } catch (e) {
    const msg = friendlyLlmError(e)
    logJob('news_digest', 'error', msg)
    return { ...empty, message: msg }
  }
}

// --- AI market brief (Discover): one compact narrative over the discovery
// stats + macro, cached 12h — the Phase 8 leftover, on Phase 7's key infra. ---

const BRIEF_TTL_MS = 12 * 60 * 60 * 1000

export async function getMarketBrief(force = false): Promise<MarketBrief> {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('market_brief') as { value: string } | undefined
  if (row && !force) {
    try {
      const cached = JSON.parse(row.value) as { at: number; text: string }
      if (Date.now() - cached.at < BRIEF_TTL_MS) {
        return { available: true, text: cached.text, generatedAt: new Date(cached.at).toISOString(), fresh: false }
      }
    } catch {
      /* fall through to regenerate */
    }
  }
  if (!hasSecret('anthropic_key')) {
    return { available: false, text: '', generatedAt: '', fresh: false, message: 'Add an Anthropic key in Settings for the AI market brief.' }
  }
  const c = client()
  if (!c) return { available: false, text: '', generatedAt: '', fresh: false, message: 'Anthropic key unavailable.' }
  try {
    const disc = await getDiscovery(false)
    const macro = await getMacro().catch(() => null)
    const data = {
      asOf: disc.asOf,
      spyReturns: disc.spyRet,
      sectors: disc.sectors.map((s) => ({ symbol: s.symbol, name: s.name, rel3m: s.rel3m, ret1m: s.ret1m })),
      moversUp: disc.moversUp.slice(0, 5).map((s) => ({ symbol: s.symbol, ret1m: s.ret1m })),
      moversDown: disc.moversDown.slice(0, 5).map((s) => ({ symbol: s.symbol, ret1m: s.ret1m })),
      momentumLeaders: disc.momentumLeaders.slice(0, 8).map((s) => ({ symbol: s.symbol, mom121: s.mom121, above200d: s.above200d })),
      quantum: disc.focus.quantum.map((s) => ({ symbol: s.symbol, ret1m: s.ret1m, from52wHigh: s.from52wHigh })),
      goldFx: disc.focus.goldfx.map((s) => ({ symbol: s.symbol, ret1m: s.ret1m, ret3m: s.ret3m })),
      macro: macro?.available ? macro.series : 'no FRED key',
      fearGreed: (() => {
        const fg = latestFearGreed(5)
        return fg ? { score: fg.score, rating: fg.rating, asOf: fg.date } : 'unavailable'
      })(),
      caveats: disc.caveats
    }
    const response = await c.messages.create({
      model: MODEL,
      // Caps thinking + text together; the brief itself is ~300 tokens.
      max_tokens: 2500,
      thinking: { type: 'adaptive' },
      system:
        'You summarize a retail investor\'s market dashboard. Use ONLY the JSON provided. Two short paragraphs: (1) what is leading/lagging — sectors vs SPY, momentum names, the gold/currency and quantum corners; (2) what changed or looks stretched, tied to numbers, plus macro context if present. Then one line starting "Watch:" with 2-3 concrete things the data flags. Plain language, no advice, no buy/sell wording, no headers. End with the sentence: "Computed stats, AI-worded — verify anything before acting on it."',
      messages: [{ role: 'user', content: JSON.stringify(data) }]
    })
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) return { available: false, text: '', generatedAt: '', fresh: false, message: 'Empty response from the model.' }
    if (response.stop_reason === 'max_tokens') {
      // Never CACHE a truncated brief — return it once, uncached, labeled.
      return { available: true, text: text + '\n[…truncated]', generatedAt: new Date().toISOString(), fresh: true }
    }
    const at = Date.now()
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'market_brief',
      JSON.stringify({ at, text })
    )
    logJob('market_brief', 'ok', `${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`)
    return { available: true, text, generatedAt: new Date(at).toISOString(), fresh: true }
  } catch (e) {
    const msg = friendlyLlmError(e)
    logJob('market_brief', 'error', msg)
    return { available: false, text: '', generatedAt: '', fresh: false, message: msg }
  }
}
