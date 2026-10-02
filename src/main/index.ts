import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { getDb, logJob } from './db'
import { registerIpc } from './ipc'
import { runCollector } from './collector'
import { deepBackfillFor, ensureAdjBars, refreshWatchlistBars } from './bars'
import { DISCOVERY_UNIVERSE } from './discovery-universe'
import { crawlFundamentals } from './fmp'
import { scoreSymbol } from './scoring'
import { backfillEdgar } from './edgar'
import { getSignals } from './signals'
import { getOptionsAnalytics } from './options'
import { getNextEarnings } from './earnings'
import { ensureDiscoveryBars } from './discovery'
import { runBacktest } from './backtest'
import { getSelfTest } from './selftest'
import { startMcpServer } from './mcp'
import { getTrackRecord, recordPredictionSnapshots } from './predictions'
import { refreshFearGreed } from './feargreed'
import { recordStanceSnapshots } from './stance'
import type { StrategyKind } from '../shared/types'
import { ensureStream, stopStream } from './stream'

// `electron . --collector` runs the daily IV snapshot headlessly (Task Scheduler
// entry point) and exits without opening a window.
const collectorMode = process.argv.includes('--collector')

// Screenshot harness: software rendering makes capturePage reliable (GPU
// compositing returns empty captures when another instance holds the GPU
// cache). Must be called before app ready.
if (process.argv.includes('--uitest')) app.disableHardwareAcceleration()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Investing App',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  getDb()

  if (collectorMode) {
    try {
      const results = await runCollector()
      console.log('[collector]', JSON.stringify(results, null, 2))
      const bars = await refreshWatchlistBars()
      console.log('[collector] bars refreshed:', JSON.stringify(bars))
      const disc = await ensureDiscoveryBars()
      console.log('[collector] discovery bars:', JSON.stringify(disc))
      // One-time per symbol: extend discovery-seeded histories to 2016 so
      // backtests see full history (no-op once every symbol is flagged deep).
      const deepFill = await deepBackfillFor(DISCOVERY_UNIVERSE.map((d) => d.symbol))
      console.log('[collector] deep backfill:', JSON.stringify(deepFill))
      // Total-return (dividend-adjusted) series the backtester AND the
      // prediction scoring run on — kept fresh daily. Watchlist symbols are
      // included so every snapshot-bearing symbol scores on total return
      // (excess vs SPY must not mix dividend bases).
      const wl = (getDb().prepare('SELECT symbol FROM watchlist').all() as { symbol: string }[]).map((r) => r.symbol)
      const adjFill = await ensureAdjBars([...new Set([...DISCOVERY_UNIVERSE.map((d) => d.symbol), 'EFA', 'AGG', 'BIL', ...wl])])
      console.log('[collector] adjusted bars:', JSON.stringify(adjFill))
      const crawl = await crawlFundamentals()
      console.log('[collector] fundamentals crawl:', JSON.stringify(crawl))
      const edgar = await backfillEdgar()
      console.log('[collector] edgar backfill:', JSON.stringify(edgar))
      // Timestamp today's engine outputs so they can be scored later — the
      // prediction track record only exists if forecasts are written down.
      const preds = await recordPredictionSnapshots()
      console.log('[collector] prediction snapshots:', JSON.stringify(preds))
      // Fear & Greed BEFORE the stance sweep — today's stances read today's reading.
      const fng = await refreshFearGreed()
      console.log('[collector] fear&greed:', JSON.stringify(fng))
      const st = await recordStanceSnapshots()
      console.log('[collector] stance snapshots:', JSON.stringify(st))
    } catch (e) {
      console.error('[collector] failed:', e)
      logJob('iv_collect', 'error', e instanceof Error ? e.message : String(e))
      app.exit(1) // non-zero so Task Scheduler history surfaces the failure
      return
    }
    app.exit(0)
    return
  }

  // `electron . --score SYMBOL` prints a Buffett score headlessly (smoke testing).
  const scoreIdx = process.argv.indexOf('--score')
  if (scoreIdx !== -1) {
    try {
      const symbol = process.argv[scoreIdx + 1] ?? 'AAPL'
      console.log(JSON.stringify(scoreSymbol(symbol), null, 2))
      app.exit(0)
    } catch (e) {
      // Without this, a sqlite throw leaves a headless process alive forever.
      console.error('[score] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --signals SYMBOL` prints a signal report headlessly (smoke testing).
  const signalsIdx = process.argv.indexOf('--signals')
  if (signalsIdx !== -1) {
    try {
      const report = await getSignals(process.argv[signalsIdx + 1] ?? 'AAPL')
      console.log(JSON.stringify(report, null, 2))
      app.exit(0)
    } catch (e) {
      console.error('[signals] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --options SYMBOL` prints options analytics headlessly (smoke testing).
  const optionsIdx = process.argv.indexOf('--options')
  if (optionsIdx !== -1) {
    try {
      const analytics = await getOptionsAnalytics(process.argv[optionsIdx + 1] ?? 'AAPL')
      console.log(JSON.stringify(analytics, null, 2))
      app.exit(0)
    } catch (e) {
      console.error('[options] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --uitest "symbol=QQQ&range=3M&patterns=1&pin=daily:0" --shot out.png [--delay ms]`
  // Screenshot harness: drives the renderer into a deterministic state (via the
  // uitest query param App.tsx understands) and captures the window — the only
  // way to VERIFY chart-drawing changes without eyeballs on the live app.
  // Deliberately does NOT start the websocket (one connection per account —
  // must not kick a live app session off the stream).
  const uitestIdx = process.argv.indexOf('--uitest')
  if (uitestIdx !== -1) {
    try {
      registerIpc()
      startMcpServer() // lets the harness exercise the MCP endpoint too
      const query = process.argv[uitestIdx + 1] ?? ''
      const shotIdx = process.argv.indexOf('--shot')
      const shotPath = shotIdx !== -1 ? process.argv[shotIdx + 1] : join(app.getPath('temp'), 'uitest.png')
      const delayIdx = process.argv.indexOf('--delay')
      const delay = delayIdx !== -1 ? Number(process.argv[delayIdx + 1]) || 9000 : 9000
      const win = new BrowserWindow({
        width: 1400,
        height: 900,
        backgroundColor: '#0f1115',
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      await win.loadFile(join(__dirname, '../renderer/index.html'), { query: { uitest: query } })
      win.show()
      await new Promise((r) => setTimeout(r, delay))
      // `scroll=N` in the query scrolls overflow views (backtest/paper) before
      // capture so below-the-fold sections can be verified.
      const scrollN = Number(new URLSearchParams(query).get('scroll') ?? '')
      if (Number.isFinite(scrollN) && scrollN > 0) {
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('[data-scroll-container]').forEach((el) => el.scrollTo(0, ${scrollN}))`
        )
        await new Promise((r) => setTimeout(r, 600))
      }
      // capturePage can return an empty image before the first real paint —
      // retry until it produces pixels.
      let png: Uint8Array = Buffer.alloc(0)
      for (let attempt = 0; attempt < 6 && png.length === 0; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000))
        const img = await win.webContents.capturePage()
        png = img.toPNG()
      }
      writeFileSync(shotPath, png)
      // Ground-truth diagnostics: what pattern-highlight rects actually exist
      // in the DOM (screenshots alone can hide sub-pixel/alpha issues).
      const diag = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rects: [...document.querySelectorAll('[data-pattern-rect]')].map((e) => e.getAttribute('data-pattern-rect')), debug: window.__rectsDebug ?? null })`
      )) as string
      console.log(`[uitest] wrote ${shotPath} (${png.length} bytes) diag=${diag}`)
      app.exit(png.length > 0 ? 0 : 1)
    } catch (e) {
      console.error('[uitest] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --earnings SYMBOL` prints the next earnings event headlessly.
  const earningsIdx = process.argv.indexOf('--earnings')
  if (earningsIdx !== -1) {
    try {
      const ev = await getNextEarnings(process.argv[earningsIdx + 1] ?? 'AAPL')
      console.log(JSON.stringify(ev, null, 2))
      app.exit(0)
    } catch (e) {
      console.error('[earnings] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --backtest [strategy] [topN] [symbolsCsv|-] [start|-] [end|-] [benchmark]`
  // runs a backtest headlessly. '-' skips a positional. For fixed-allocation,
  // symbolsCsv takes "VOO=60,QQQ=40" weight pairs (no ':' — Windows Electron arg trap).
  const backtestIdx = process.argv.indexOf('--backtest')
  if (backtestIdx !== -1) {
    try {
      const arg = (o: number): string => {
        const v = process.argv[backtestIdx + o]
        return v == null || v === '-' || v.startsWith('--') ? '' : v
      }
      const strategy = (arg(1) || 'momentum-12-1') as StrategyKind
      const symbolPairs = arg(3) ? arg(3).split(',').map((s) => s.trim()).filter(Boolean) : []
      const result = await runBacktest({
        strategy,
        // NaN for an omitted arg → normalizeConfig owns the default (5);
        // an explicit 0 reaches the engine and clamps to 1 like the UI.
        topN: Number(arg(2) || NaN),
        costBps: 5,
        start: arg(4),
        end: arg(5),
        symbols: symbolPairs.map((p) => p.split('=')[0]),
        weights: symbolPairs.some((p) => p.includes('=')) ? symbolPairs.map((p) => Number(p.split('=')[1]) || 0) : [],
        benchmark: arg(6) || 'SPY',
        rebalance: strategy === 'fixed-allocation' ? 'quarterly' : 'monthly',
        initialCapital: 10_000,
        contribMonthly: Number(arg(7)) || 0
      })
      // Points are huge — print the decision-relevant parts only.
      console.log(JSON.stringify({ ...result, points: `${result.points.length} daily points` }, null, 2))
      app.exit(0)
    } catch (e) {
      console.error('[backtest] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --predict` records today's prediction snapshots and prints
  // the track record (same code path the daily collector runs).
  if (process.argv.includes('--predict')) {
    try {
      const rec = await recordPredictionSnapshots()
      console.log('[predict] recorded:', JSON.stringify(rec))
      const fng = await refreshFearGreed()
      console.log('[predict] fear&greed:', JSON.stringify(fng))
      const st = await recordStanceSnapshots()
      console.log('[predict] stance recorded:', JSON.stringify(st))
      console.log(JSON.stringify(getTrackRecord(), null, 2))
      app.exit(0)
    } catch (e) {
      console.error('[predict] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --selftest` prints the Phase 6 Self-Test report headlessly
  // (anchors canonical strategies on first run).
  if (process.argv.includes('--selftest')) {
    try {
      const report = await getSelfTest()
      console.log(JSON.stringify(report, null, 2))
      app.exit(0)
    } catch (e) {
      console.error('[selftest] failed:', e)
      app.exit(1)
    }
    return
  }

  // `electron . --backfill-edgar` runs the EDGAR fallback fetch headlessly.
  if (process.argv.includes('--backfill-edgar')) {
    try {
      const result = await backfillEdgar()
      console.log('[edgar]', JSON.stringify(result))
      app.exit(0)
    } catch (e) {
      console.error('[edgar] failed:', e)
      app.exit(1)
    }
    return
  }

  registerIpc()
  createWindow()
  ensureStream()
  // Local MCP endpoint (127.0.0.1 only) — Claude Code queries the running
  // app's engines: claude mcp add --transport http investing http://127.0.0.1:48620/mcp
  startMcpServer()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopStream()
  if (process.platform !== 'darwin') app.quit()
})
