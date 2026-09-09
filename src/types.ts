// Global Types and Interfaces for Bybit Demo Trading Bot

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
export interface CandleData { time: number | string; open: number; high: number; low: number; close: number; volume?: number; }
export interface EmaData { time: number | string; value: number; }
export interface Technicals { ema9: number; ema21: number; rsi: number; timestamp?: number; }

export interface Settings {
  leverage: number;
  positionMarginUsdt: number;
  riskUsdt?: number;
  tpPercent: number;
  slPercent: number;
  trailingStopPercent: number;
  maxPositions: number;
  globalMaxLossUsdt?: number;
  maxLossUsdt?: number;
  demoTrading?: boolean;
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
  createdTime?: number;
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
  type?: "buy" | "sell";
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

export interface KlineUpdatePayload { symbol: string; candle: Candle; ema9?: { time: number; value: number }; ema21?: { time: number; value: number }; }

export interface ExecutionEligibility {
  gateCandidate: boolean;
  riskEligible: boolean;
  executableNow: boolean;
  blockReason: string | null;
}

export interface GateValidationResult { passed: boolean; valueDisplay: string; detail: string; }
export interface GateResultSummary {
  gate1_volume: GateValidationResult;
  gate2_trend: GateValidationResult;
  gate3_spread: GateValidationResult;
  gate4_atr: GateValidationResult;
  gate5_oi: GateValidationResult;
  gate6_rsi: GateValidationResult;
  gate6_candle: GateValidationResult;
  gate6FailureReason: "RSI_OUT_OF_RANGE" | "DIRECTIONAL_CANDLE_FAILED" | "RSI_AND_CANDLE_FAILED" | "NO_DIRECTIONAL_TREND" | null;
  passedAll: boolean;
  failedGateNumber: number | null;
  failedGateName: string | null;
}

export type RsiZone5m = "Long (50-64)" | "Short (36-50)" | "Overbought (>64)" | "Oversold (<36)" | "Neutral";

export interface ScannedMarketItem {
  symbol: string;
  price: number;
  lastPrice: number;
  turnover24h: number;
  volume24h: number;
  price24hPcnt: number;
  highPrice24h: number;
  lowPrice24h: number;
  bidPrice: number;
  askPrice: number;
  rsi: number;
  rsiZone5m: RsiZone5m;
  ema50: number;
  ema200: number;
  ema9?: number;
  ema21?: number;
  ema9Above21?: boolean;
  ema9Slope?: number;
  ema21Slope?: number;
  freshCross?: "bullish" | "bearish" | "none";
  crossoverAgeCandles?: number | null;
  emaTimingScore?: number;
  finalSetupScore?: number;
  emaTimingState?: "Bullish" | "Bearish" | "Neutral" | "Unavailable";
  emaTimingChoppy?: boolean;
  trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral HTF";
  trend: "Bullish" | "Bearish" | "Neutral";
  spreadPcnt: number;
  atr?: number;
  atrPcnt: number;
  oiAvailable: boolean;
  oiPositive: boolean;
  oiChangePercent?: number;
  breakoutBonus?: boolean;
  entryCandleDirection?: "Bullish" | "Bearish" | "Doji";
  gatePassed: number;
  gates: GateResultSummary;
  executionEligibility: ExecutionEligibility;
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
  symbol: string; timeframe: string; candleTime: number; price: number; side: "LONG" | "SHORT"; grade: "GRADE_A" | "GRADE_B"; reason: string;
  technicals: { ema50: number; ema200: number; rsi14: number; prevRsi14: number; currentVolume: number; avgVolume20: number; volumeRatio: number; };
  timestamp: number;
}

export type PipelineScannedSymbol = ScannedMarketItem;

export interface PipelineGateSummary { gateNumber: number; name: string; ruleDescription: string; status: "Passed" | "Filtering" | "Active"; inputCount: number; passCount: number; passRatePercent: number; }
export interface PipelineState { totalDiscovered: number; passedAllCount: number; candidateCount: number; gates: PipelineGateSummary[]; symbols: ScannedMarketItem[]; lastScanTimestamp: number; isScanning: boolean; }

export interface Scanner5mResult {
  symbol: string; price: number; ema50: number; ema200: number; rsi: number; prevRsi: number; currentVolume: number; avgVolume20: number; volumeRatio: number;
  isVolumeConfirmed: boolean; isVolumeModerate: boolean; trend: "BULLISH" | "BEARISH" | "NEUTRAL"; signal: "LONG" | "SHORT" | "NONE"; grade: "GRADE_A" | "GRADE_B" | "NONE"; signalReason: string; candleTime: number;
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
  exitTrigger: string;
  classifiedBy?: string;
  matchedOrderId?: string;
  matchedOrderLinkId?: string;
  rawStopOrderType?: string;
  rawCreateType?: string;
  time: number;
  openedTime?: number;
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
  tradingDay: "UTC";
  tradingDayStartUtc: number;
  windowEndUtc: number;
  todayOpenedCount: number;
  todayClosedCount: number;
  winningTradesCount: number;
  losingTradesCount: number;
  activePositionsCount: number;
  maxSlots: number;
  tpHitCount: number;
  trailingStopCount: number;
  slHitCount: number;
  manualCloseCount: number;
  otherExitCount: number;
  breakEvenCount: number;
  realizedPnlToday: number;
  unrealizedPnlToday: number;
  netDailyPnl: number;
  slAudit: SlAuditSummary;
  closedTrades: ClosedTradeAuditItem[];
}
