// Phase 8 Market Discovery universe (PLAN.md §Phase 8): a curated ~50-symbol
// set tracked BARS-ONLY (no IV collection, no streaming) to widen the app's
// cross-sectional view beyond the watchlist. Focused on Ryan's stated lanes:
// tech (including quantum), broad baskets, and gold/currency trackers, plus
// the 11 sector SPDRs for rotation context.
//
// Side benefit ("supplement previous work"): every symbol here lands in
// daily_bars, and the Signals tab's 12-1 momentum percentile ranks against
// ALL bars-bearing symbols — so this universe makes that percentile
// meaningfully cross-sectional (~70 names instead of ~20). Non-ETF names are
// also seeded into the fundamentals-crawl universe so Buffett percentiles
// widen over time.

export type DiscoveryCategory = 'sector' | 'broad' | 'tech' | 'quantum' | 'goldfx'

export interface DiscoveryEntry {
  symbol: string
  name: string
  category: DiscoveryCategory
  etf: boolean
}

const e = (symbol: string, name: string, category: DiscoveryCategory, etf = true): DiscoveryEntry => ({
  symbol,
  name,
  category,
  etf
})

export const DISCOVERY_UNIVERSE: DiscoveryEntry[] = [
  // --- Sector rotation set: the 11 SPDR sector ETFs ---
  e('XLK', 'Technology', 'sector'),
  e('XLC', 'Communication Services', 'sector'),
  e('XLY', 'Consumer Discretionary', 'sector'),
  e('XLP', 'Consumer Staples', 'sector'),
  e('XLE', 'Energy', 'sector'),
  e('XLF', 'Financials', 'sector'),
  e('XLV', 'Health Care', 'sector'),
  e('XLI', 'Industrials', 'sector'),
  e('XLB', 'Materials', 'sector'),
  e('XLRE', 'Real Estate', 'sector'),
  e('XLU', 'Utilities', 'sector'),
  // --- Broad baskets ---
  e('SPY', 'S&P 500 (SPDR)', 'broad'),
  e('VOO', 'S&P 500 (Vanguard)', 'broad'),
  e('VTI', 'Total US Market', 'broad'),
  e('QQQ', 'Nasdaq-100', 'broad'),
  e('IWM', 'Russell 2000', 'broad'),
  e('DIA', 'Dow 30', 'broad'),
  e('VXUS', 'Total International ex-US', 'broad'),
  e('EFA', 'Developed Markets ex-US', 'broad'),
  e('EEM', 'Emerging Markets', 'broad'),
  // --- Tech (stocks + focused ETFs) ---
  e('AAPL', 'Apple', 'tech', false),
  e('MSFT', 'Microsoft', 'tech', false),
  e('NVDA', 'NVIDIA', 'tech', false),
  e('AMD', 'AMD', 'tech', false),
  e('AVGO', 'Broadcom', 'tech', false),
  e('GOOGL', 'Alphabet', 'tech', false),
  e('AMZN', 'Amazon', 'tech', false),
  e('META', 'Meta Platforms', 'tech', false),
  e('TSM', 'TSMC (ADR)', 'tech', false),
  e('QCOM', 'Qualcomm', 'tech', false),
  e('MU', 'Micron', 'tech', false),
  e('MRVL', 'Marvell', 'tech', false),
  e('ADBE', 'Adobe', 'tech', false),
  e('CRM', 'Salesforce', 'tech', false),
  e('ORCL', 'Oracle', 'tech', false),
  e('PLTR', 'Palantir', 'tech', false),
  e('SMH', 'Semiconductors ETF', 'tech'),
  e('SOXX', 'Semiconductors ETF (iShares)', 'tech'),
  e('IGV', 'Software ETF', 'tech'),
  // --- Quantum computing ---
  e('IONQ', 'IonQ', 'quantum', false),
  e('RGTI', 'Rigetti Computing', 'quantum', false),
  e('QBTS', 'D-Wave Quantum', 'quantum', false),
  e('ARQQ', 'Arqit Quantum', 'quantum', false),
  e('QTUM', 'Quantum Computing ETF (Defiance)', 'quantum'),
  // --- Gold / currency trackers ---
  e('GLD', 'Gold (SPDR)', 'goldfx'),
  e('IAU', 'Gold (iShares)', 'goldfx'),
  e('SLV', 'Silver', 'goldfx'),
  e('GDX', 'Gold Miners', 'goldfx'),
  e('UUP', 'US Dollar Index (bull)', 'goldfx'),
  e('FXE', 'Euro Trust', 'goldfx'),
  e('FXY', 'Japanese Yen Trust', 'goldfx'),
  e('IBIT', 'Bitcoin (iShares ETF)', 'goldfx')
]
