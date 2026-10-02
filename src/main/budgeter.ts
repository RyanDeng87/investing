import { getDb } from './db'

// Rate budgets across the free tiers (PLAN.md §2.3). Alpaca/Finnhub are per-minute
// windows held in memory; FMP's 250/day is the scarce resource and is persisted so
// headless collector runs and the UI share one daily count.

function nyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

class MinuteBudget {
  private windowStart = 0
  private used = 0
  constructor(private capacity: number) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now()
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now
        this.used = 0
      }
      if (this.used < this.capacity) {
        this.used++
        return
      }
      await sleep(this.windowStart + 60_000 - now + 50)
    }
  }
}

// Slightly under the published caps to leave headroom.
export const alpacaBudget = new MinuteBudget(180)
export const finnhubBudget = new MinuteBudget(50)

const FMP_DAILY_CAP = 250

export const fmpBudget = {
  usedToday(): number {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('fmp_calls_' + nyDate()) as { value: string } | undefined
    return row ? Number(row.value) || 0 : 0
  },
  remainingToday(): number {
    return Math.max(0, FMP_DAILY_CAP - this.usedToday())
  },
  consume(n: number): void {
    const key = 'fmp_calls_' + nyDate()
    const used = this.usedToday() + n
    getDb()
      .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(used))
  }
}
