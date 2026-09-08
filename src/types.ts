// Global Types and Interfaces for Bybit Demo Trading Bot

export interface Candle {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleData {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface EmaData {
  time: number | string;
  value: number;
}

export interface Technicals {
  ema9: number;
  ema21: number;
  rsi: number;
  timestamp?: number;
}

export interface Settings {
  leverage: number;
  positionMarginUsdt: number;
  riskUsdt?: number;
  tpPercent: number;
  slPercent: number;
  trailingStopPercent: number;
  maxPositions: number;
  globalMaxLossUsdt?: number; // e.g. -100 USDT Net PnL circuit breaker
  maxLossUsdt?: number;
}

export interface Position {
  symbol: string;
  side: "Buy" | "Sell" | string;
  size: number | string;
  entryPrice?: number;
  avgPrice?: string | number;
  markPrice?: string | number;
  leverage: number | string;
  unrealizedPnl?: number;
  unrealisedPnl?: string | number;
  curRealisedPnl?: string;
  tpPrice?: number;
  slPrice?: number;
  stopLoss?: string;
  takeProfit?: string;
  liqPrice?: string;
  trailingStopPrice?: number;
  peakPrice?: number;
}

export interface TradeHistory {
  id: string;
  symbol: string;
  side: "Buy" | "Sell";
  entryPrice: number;
  exitPrice: number;
  size: number;
  qty?: string | number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  time: number;
}

export interface BotState {
  isRunning: boolean;
  activePositions: Record<string, Position>;
  currentPrices: Record<string, number>;
  technicals: Record<string, Technicals>;
  watchlist: string[];
  settings: Settings;
  history: TradeHistory[];
  totalPnl: number;
  winRate: number;
  dailyTradesCount: number;
}

export interface ServerToClientEvents {
  "bot-state": (state: BotState) => void;
  "kline-update": (data: KlineUpdatePayload) => void;
  "price-update": (prices: Record<string, number>) => void;
  "technicals-update": (technicals: Record<string, Technicals>) => void;
  "trade-event": (trade: TradeHistory) => void;
  "log": (message: string) => void;
}

export interface ClientToServerEvents {
  "start-bot": () => void;
  "stop-bot": () => void;
  "update-settings": (settings: Partial<Settings>) => void;
  "add-symbol": (symbol: string) => void;
  "remove-symbol": (symbol: string) => void;
  "close-position": (symbol: string) => void;
  "emergency-stop": () => void;
}

export interface KlineUpdatePayload {
  symbol: string;
  candle: Candle;
  ema9?: { time: number; value: number };
  ema21?: { time: number; value: number };
}

export interface ScannedMarketItem {
  symbol: string;
  price?: number;
  lastPrice: number;
  turnover24h: number;
  volume24h: number;
  price24hPcnt: number;
  highPrice24h: number;
  lowPrice24h: number;
  rsi: number;
  ema9: number;
  ema21: number;
  
  // New 6-Gate Fields
  trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral HTF";
  spreadPcnt: number;
  atrPcnt: number;
  oiPositive: boolean;
  gatePassed: number; // 0 to 6
  
  trend: "Bullish" | "Bearish" | "Neutral"; // Legacy
  signal: "BUY_SIGNAL" | "WAITING" | "IN_POSITION" | "SELL_SIGNAL";
  signalReason: string;
  lastScannedAt: number;
}

export interface ScannerState {
  markets: ScannedMarketItem[];
  autoTrade: boolean;
  maxConcurrent: number;
  isScanning: boolean;
  lastScanTime: number;
  topSymbols: string[];
}

export interface Scanner5mSignal {
  symbol: string;
  timeframe: string;
  candleTime: number;
  price: number;
  side: "LONG" | "SHORT";
  grade: "GRADE_A" | "GRADE_B";
  reason: string;
  technicals: {
    ema50: number;
    ema200: number;
    rsi14: number;
    prevRsi14: number;
    currentVolume: number;
    avgVolume20: number;
    volumeRatio: number;
  };
  timestamp: number;
}

export interface GateValidationResult {
  passed: boolean;
  valueDisplay: string;
  detail: string;
}

export interface GateResultSummary {
  gate1_volume: GateValidationResult;
  gate2_trend: GateValidationResult; // 15m EMA 50/200 Trend Structure
  gate3_spread: GateValidationResult; // Bid-Ask Spread <= 0.15%
  gate4_atr: GateValidationResult; // 5m ATR >= 0.3%
  gate5_oi: GateValidationResult; // 1h/4h OI expansion
  gate6_rsi: GateValidationResult; // 5m RSI (14) Momentum Entry Trigger
  passedAll: boolean;
  failedGateNumber: number | null; // 1 to 6, or null if passed all
  failedGateName: string | null;
}

export interface PipelineScannedSymbol {
  symbol: string;
  price: number;
  turnover24h: number; // in USDT
  turnoverFormatted: string;
  // Gate 2: 15m Trend Structure (EMA 50 / 200)
  ema50_15m: number;
  ema200_15m: number;
  trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral";
  isTrend15mValid: boolean;
  // Gate 3: Spread
  bidPrice: number;
  askPrice: number;
  spreadPercent: number; // e.g. 0.04%
  isSpreadValid: boolean; // <= 0.15%
  // Gate 4: 5m ATR
  atr5m: number;
  atr5mPercent: number; // e.g. 0.62%
  isAtrValid: boolean; // >= 0.3%
  // Gate 5: Open Interest
  openInterest: number;
  oiChangePercent1h: number; // e.g. +3.4%
  isOiValid: boolean; // >= 0%
  // Gate 6: 5m RSI (14) Entry Trigger
  rsi14_5m: number;
  rsiZone5m: "Long (50-65)" | "Short (35-50)" | "Overbought (>65)" | "Oversold (<35)" | "Neutral";
  isRsi5mValid: boolean;
  gates: GateResultSummary;
  pipelineStatus: "Passed All 6 Gates" | string;
  signalAction: "Grade A Long" | "Grade A Short" | "Standby";
  actionType: "LONG" | "SHORT" | "STANDBY";
  lastUpdated: number;
}

export interface PipelineGateSummary {
  gateNumber: number;
  name: string;
  ruleDescription: string;
  status: "Passed" | "Filtering" | "Active";
  inputCount: number;
  passCount: number;
  passRatePercent: number;
}

export interface PipelineState {
  totalDiscovered: number;
  passedAllCount: number;
  activeSignalsCount: number;
  gates: PipelineGateSummary[];
  symbols: PipelineScannedSymbol[];
  lastScanTimestamp: number;
  isScanning: boolean;
}

export interface Scanner5mResult {
  symbol: string;
  price: number;
  ema50: number;
  ema200: number;
  rsi: number;
  prevRsi: number;
  currentVolume: number;
  avgVolume20: number;
  volumeRatio: number;
  isVolumeConfirmed: boolean;
  isVolumeModerate: boolean;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  signal: "LONG" | "SHORT" | "NONE";
  grade: "GRADE_A" | "GRADE_B" | "NONE";
  signalReason: string;
  candleTime: number;
}

export interface ClosedTradeAuditItem {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  qty: string;
  pnl: number;
  pnlPercent: number;
  exitTrigger: string; // e.g. "Hard SL (-1%)", "TP1 (+1.5%)", "Trailing Stop", "Manual Close"
  time: number;
  slDiagnosticReason?: string;
}

export interface SlAuditSummary {
  primarySlCause: string;
  worstPerformingSymbol: string;
  slCountForWorst: number;
  averageTimeToSlSeconds: number;
  strategyFeedbackNote: string;
  totalLossUsdt: number;
}

export interface DailyTradeAnalytics {
  todayOpenedCount: number;
  todayClosedCount: number;
  activePositionsCount: number;
  maxSlots: number;
  tpHitCount: number;
  trailingStopCount: number;
  slHitCount: number;
  manualCloseCount: number;
  breakEvenCount: number;
  slAudit: SlAuditSummary;
  closedTrades: ClosedTradeAuditItem[];
}
