// Scoring universe seed: large-cap tech / Nasdaq-100-style names plus core ETFs.
// This is an editable approximation, not an official constituent list — the point
// is a stable peer group for percentile scoring (see PLAN.md §2.1). Symbols that
// stop resolving are skipped harmlessly by the crawler.
export const UNIVERSE_SEED: string[] = [
  // Mega-cap tech & communication
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'TSLA', 'ORCL',
  'CRM', 'ADBE', 'NFLX', 'AMD', 'QCOM', 'TXN', 'INTC', 'IBM', 'NOW', 'INTU',
  // Semis & equipment
  'MU', 'ADI', 'LRCX', 'AMAT', 'KLAC', 'ASML', 'NXPI', 'MRVL', 'MCHP', 'ON',
  'SWKS', 'TER', 'ENTG', 'ARM', 'SNPS', 'CDNS', 'SMCI', 'SNDK', 'WDC', 'STX',
  // Software & cloud
  'WDAY', 'SNOW', 'DDOG', 'NET', 'CRWD', 'PANW', 'FTNT', 'ZS', 'OKTA', 'MDB',
  'TEAM', 'HUBS', 'VEEV', 'ANSS', 'PLTR', 'U', 'RBLX', 'EA', 'TTWO', 'MTCH',
  // Internet, platforms, fintech
  'SHOP', 'PYPL', 'COIN', 'HOOD', 'ABNB', 'UBER', 'DASH', 'BKNG', 'EBAY', 'ETSY',
  'PINS', 'SNAP', 'RDDT', 'SPOT', 'TTD', 'APP', 'ROKU', 'DOCU', 'ZM',
  // Hardware, infra, networking
  'ANET', 'CSCO', 'DELL', 'HPQ', 'HPE', 'NTAP', 'PSTG', 'JNPR', 'VRT', 'MSTR',
  // Core ETFs (charting/context; fundamentals crawl skips ETFs automatically)
  'QQQ', 'SPY', 'XLK', 'SMH', 'IGV', 'VGT', 'SOXX', 'VOO', 'VTI'
]
