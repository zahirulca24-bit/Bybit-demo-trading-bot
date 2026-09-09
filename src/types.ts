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

export type RuntimeHealthStatus = "healthy" | "degraded" | "unavailable" | "connecting" | "disconnected";

export interface RuntimeRiskStatus {
  leverage: number;
  marginCapUsdt: number;
  approximateMaxNotionalUsdt: number;
  maxPositions: number;
  scannerMaxConcurrent: number;
  duplicateSymbolPolicy: "DENY_SAME_SYMBOL";
  cooldown: {
    symbolMs: number;
    description: string;
  };
  dailyLossBreaker: {
    limitUsdt: number;
    active: boolean;
    scope: "NEW_ENTRIES_ONLY";
  };
  consecutiveLossBreaker: {
    losses: number;
    pauseMs: number;
    active: boolean;
    until: number | null;
  };
  stopLossDiscipline: {
    mode: "ADAPTIVE_ATR_STRUCTURE";
    minInitialDistancePercent: number;
    maxInitialDistancePercent: number;
    breakEvenAtrMultiple: number;
    neverWiden: boolean;
  };
  botRunning: boolean;
  scannerRunning: boolean;
  autoTrade: boolean;
  breakerActive: boolean;
  breakerReason: string | null;
  bybitPrivateApiHealth: {
    healthy: boolean;
    status: RuntimeHealthStatus;
    lastError: string | null;
  };
  bybitPrivateWsHealth: {
    healthy: boolean;
    status: RuntimeHealthStatus;
    connected: boolean;
    authenticated: boolean;
    lastMessageAt: number | null;
    lastError: string | null;
  };
  lastSuccessfulRiskDataRefresh: number | null;
}

export interface Position {
  symbol: string;
  side: "Buy" | "Sell" | string;
  size: number | string;
  entryPrice?: number;
  avgPrice?: string | number;
  markPrice?: string | number;
  leverage: number | string;
  positionIdx?: number;
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
  side: "Buy" | "Sell" | null;
  entryPrice: number | null;
  exitPrice: number | null;
  size: number | null;
  qty?: number | null;
  filledQty?: number | null;
  pnl: number | null;
  realizedPnlUsdt: number | null;
  priceMovePercent: number | null;
  returnOnNotionalPercent: number | null;
  roePercent: number | null;
  pnlPercent?: number | null;
  reason: string;
  time: number | null;
  orderId?: string | null;
  orderLinkId?: string | null;
  outcome?: "WIN" | "LOSS" | "ZERO" | "UNKNOWN";
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
  "runtime-status": (status: RuntimeRiskStatus) => void;
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

export interface ScannedMarketItem {
  symbol: string; price?: number; lastPrice: number; turnover24h: number; volume24h: number; price24hPcnt: number; highPrice24h: number; lowPrice24h: number;
  rsi: number; ema50: number; ema200: number; ema9?: number; ema21?: number;
  ema9Above21?: boolean; ema9Slope?: number; ema21Slope?: number; freshCross?: "bullish" | "bearish" | "none"; crossoverAgeCandles?: number | null; emaTimingScore?: number; finalSetupScore?: number; emaTimingState?: "Bullish" | "Bearish" | "Neutral" | "Unavailable"; emaTimingChoppy?: boolean;
  trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral HTF";
  spreadPcnt: number; atr?: number; atrPcnt: number; oiPositive: boolean; oiChangePercent?: number; breakoutBonus?: boolean; entryCandleDirection?: "Bullish" | "Bearish" | "Doji"; gatePassed: number;
  trend: "Bullish" | "Bearish" | "Neutral";
  signal: "BUY_SIGNAL" | "WAITING" | "IN_POSITION" | "SELL_SIGNAL";
  signalReason: string; lastScannedAt: number;
}

export interface ScannerState { markets: ScannedMarketItem[]; autoTrade: boolean; maxConcurrent: number; isScanning: boolean; lastScanTime: number; topSymbols: string[]; }

export interface Scanner5mSignal {
  symbol: string; timeframe: string; candleTime: number; price: number; side: "LONG" | "SHORT"; grade: "GRADE_A" | "GRADE_B"; reason: string;
  technicals: { ema50: number; ema200: number; rsi14: number; prevRsi14: number; currentVolume: number; avgVolume20: number; volumeRatio: number; };
  timestamp: number;
}

export interface GateValidationResult { passed: boolean; valueDisplay: string; detail: string; }
export interface GateResultSummary {
  gate1_volume: GateValidationResult;
  gate2_trend: GateValidationResult; // EMA50/EMA200 direction + confirmed price on correct side of EMA50
  gate3_spread: GateValidationResult; // Bid-Ask Spread <= 0.08%
  gate4_atr: GateValidationResult; // ATR 0.30%–1.20%
  gate5_oi: GateValidationResult; // Real Bybit 1h OI expansion >= +0.50%; unavailable fails closed
  gate6_rsi: GateValidationResult; // RSI Long 50–64 / Short 36–50 on confirmed candle
  passedAll: boolean; failedGateNumber: number | null; failedGateName: string | null;
}

export type RsiZone5m = "Long (50-64)" | "Short (36-50)" | "Overbought (>64)" | "Oversold (<36)" | "Neutral";

export interface PipelineScannedSymbol {
  symbol: string; price: number; turnover24h: number; turnoverFormatted: string;
  ema50_15m: number; ema200_15m: number; trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral"; isTrend15mValid: boolean;
  bidPrice: number; askPrice: number; spreadPercent: number; isSpreadValid: boolean;
  atr5m: number; atr5mPercent: number; isAtrValid: boolean;
  openInterest: number; oiChangePercent1h: number; oiAvailable?: boolean; isOiValid: boolean;
  rsi14_5m: number; rsiZone5m: RsiZone5m; isRsi5mValid: boolean;
  gates: GateResultSummary; pipelineStatus: "Passed All 6 Gates" | string; signalAction: "Grade A Long" | "Grade A Short" | "Standby"; actionType: "LONG" | "SHORT" | "STANDBY"; lastUpdated: number;
}

export interface PipelineGateSummary { gateNumber: number; name: string; ruleDescription: string; status: "Passed" | "Filtering" | "Active"; inputCount: number; passCount: number; passRatePercent: number; }
export interface PipelineState { totalDiscovered: number; passedAllCount: number; activeSignalsCount: number; gates: PipelineGateSummary[]; symbols: PipelineScannedSymbol[]; lastScanTimestamp: number; isScanning: boolean; }

export interface Scanner5mResult {
  symbol: string; price: number; ema50: number; ema200: number; rsi: number; prevRsi: number; currentVolume: number; avgVolume20: number; volumeRatio: number;
  isVolumeConfirmed: boolean; isVolumeModerate: boolean; trend: "BULLISH" | "BEARISH" | "NEUTRAL"; signal: "LONG" | "SHORT" | "NONE"; grade: "GRADE_A" | "GRADE_B" | "NONE"; signalReason: string; candleTime: number;
}

export interface ClosedTradeAuditItem {
  id: string;
  symbol: string;
  side: "Buy" | "Sell" | null;
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  priceMovePercent?: number | null;
  returnOnNotionalPercent?: number | null;
  roePercent?: number | null;
  outcome?: "WIN" | "LOSS" | "ZERO" | "UNKNOWN";
  exitTrigger: string;
  classifiedBy?: string;
  matchedOrderId?: string;
  matchedOrderLinkId?: string;
  rawStopOrderType?: string;
  rawCreateType?: string;
  time: number | null;
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
  zeroOrUnknownCount: number;
  activePositionsCount: number;
  maxSlots: number;
  tpHitCount: number;
  trailingStopCount: number;
  slHitCount: number;
  manualCloseCount: number;
  otherExitCount: number;
  breakEvenCount: number;
  realizedPnlToday: number | null;
  unrealizedPnlToday: number | null;
  netDailyPnl: number | null;
  slAudit: SlAuditSummary;
  closedTrades: ClosedTradeAuditItem[];
}
