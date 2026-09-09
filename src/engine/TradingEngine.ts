import { RestClientV5 } from "bybit-api";
import { Server as SocketIOServer } from "socket.io";
import { TelegramNotifier } from "./TelegramNotifier";
import { BybitWebSocketManager, KlineEventPayload, TickerEventPayload } from "./BybitWebSocketManager";
import { MarketScanner } from "./MarketScanner";
import { dbRecordReportEvent, dbRecordTrade } from "../db";
import { ATR } from "technicalindicators";
import { getUtcDayStartMs, normalizeTimestampMs } from "../utils/utcTradingDay";
import { classifyClosedTradeExit } from "../utils/exitClassification";
import { calculateAdaptiveStopPlan, calculateRiskAdjustedNotional, AdaptiveStopPlan } from "../utils/adaptiveStop";
import { buildRiskAccounting, DAILY_PNL_UNAVAILABLE, evaluateEntryRiskAccounting, fetchClosedPnlRange } from "../utils/dailyRiskAccounting";
import { bangladeshDateForTimestamp } from "../utils/tradingReports";
import { RuntimeRiskStatus } from "../types";
import {
  InstrumentConstraints,
  POSITION_STATE_UNAVAILABLE,
  calculateApprovedQuantity,
  ensureConfiguredLeverage,
  ensureOneWayPositionMode,
  fetchInstrumentConstraints,
  fetchOpenPositions,
  fetchOrderFillSnapshot,
  fetchTopOfBook,
  fetchUnifiedAvailableBalance,
  mergePositionUpdates,
  quantizePrice,
  quantizeProtectivePrices,
  validateFinalRequestedQuantity,
} from "../utils/riskHardening";

export class WebSocketEmitter {
  private lastPriceEmit = 0;
  private pendingPrices: Record<string, number> = {};
  private priceEmitTimer: NodeJS.Timeout | null = null;
  private lastTechEmit = 0;
  private pendingTechnicals: Record<string, any> = {};
  private techEmitTimer: NodeJS.Timeout | null = null;

  constructor(private io: SocketIOServer) {}

  log(message: string) { this.io.emit("log", message); }

  updatePrices(prices: Record<string, number>) {
    this.pendingPrices = { ...this.pendingPrices, ...prices };
    const now = Date.now();
    if (now - this.lastPriceEmit >= 1000) this.flushPrices();
    else if (!this.priceEmitTimer) this.priceEmitTimer = setTimeout(() => this.flushPrices(), 1000 - (now - this.lastPriceEmit));
  }

  private flushPrices() {
    this.lastPriceEmit = Date.now();
    if (this.priceEmitTimer) clearTimeout(this.priceEmitTimer);
    this.priceEmitTimer = null;
    this.io.emit("price-update", this.pendingPrices);
    this.io.emit("ticker:update", this.pendingPrices);
  }

  updateWatchlist(watchlist: string[]) { this.io.emit("watchlist-update", watchlist); }
  updatePositions(positions: any[]) { this.io.emit("positions-update", positions); this.io.emit("position:update", positions); }
  updateBalance(balance: string) { this.io.emit("balance-update", { balance }); this.io.emit("wallet:update", { balance }); }
  tradeUpdate(trade: any) { this.io.emit("trade-update", trade); this.io.emit("execution:update", trade); }
  updateKline(payload: { symbol: string; candle: any; ema9?: any; ema21?: any }) { this.io.emit("kline-update", payload); this.io.emit("kline:update", payload); }
  updateScanner(scannerState: any) { this.io.emit("scanner-update", scannerState); this.io.emit("scanner:update", scannerState); }
  updateRuntimeStatus(status: RuntimeRiskStatus) { this.io.emit("runtime-status", status); }

  updateTechnicals(technicals: Record<string, any>) {
    this.pendingTechnicals = { ...this.pendingTechnicals, ...technicals };
    const now = Date.now();
    if (now - this.lastTechEmit >= 1000) this.flushTechnicals();
    else if (!this.techEmitTimer) this.techEmitTimer = setTimeout(() => this.flushTechnicals(), 1000 - (now - this.lastTechEmit));
  }

  private flushTechnicals() {
    this.lastTechEmit = Date.now();
    if (this.techEmitTimer) clearTimeout(this.techEmitTimer);
    this.techEmitTimer = null;
    this.io.emit("technicals-update", this.pendingTechnicals);
  }

  emitStatus(running: boolean, circuitBreaker: boolean = false) { this.io.emit("bot-status", { running, circuitBreaker }); }
}

export class RiskManager {
  constructor(private bybit: RestClientV5, private emitter: WebSocketEmitter) {}

  async getOpenPositions() {
    const result = await fetchOpenPositions(this.bybit);
    if (!result.ok) this.emitter.log(`[RiskManager] ${result.reason}: ${result.error}`);
    return result;
  }
}

export interface ScannerEntryQualityContext {
  atr?: number;
  atrPercent?: number;
  oiExpansionPercent?: number;
  spreadPercent?: number;
  trendState?: string;
  breakoutBonus?: boolean;
  entryCandleDirection?: "Bullish" | "Bearish" | "Doji";
  ema9?: number;
  ema21?: number;
  ema9Above21?: boolean;
  ema9Slope?: number;
  ema21Slope?: number;
  freshCross?: "bullish" | "bearish" | "none";
  crossoverAgeCandles?: number | null;
  emaTimingScore?: number;
  finalSetupScore?: number;
  emaTimingState?: string;
  emaTimingChoppy?: boolean;
}

type PositionRiskState = {
  peakPrice: number;
  breakEvenSet: boolean;
  initialStopLoss?: number;
  initialRiskPercent?: number;
  atrPercent?: number;
};

type PreOrderValidation = {
  valid: boolean;
  qty: string;
  qtyNumber: number;
  price: number;
  approvedNotional: number;
  actualNotional: number;
  constraints?: InstrumentConstraints;
  reason?: string;
};

export class TradingEngine {
  private isRunning = false;
  public circuitBreakerTriggered = false;
  private riskManager: RiskManager;
  public emitter: WebSocketEmitter;
  public telegram: TelegramNotifier;
  public wsManager: BybitWebSocketManager;
  public scanner: MarketScanner;

  public currentPrices: Record<string, number> = {};
  public watchlist: string[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  public tradeHistory: any[] = [];
  public currentTechnicals: Record<string, any> = {};
  public activePositions: any[] = [];
  public currentBalance = "0";

  public settings = {
    leverage: 10,
    positionMarginUsdt: 50,
    maxPositions: 3,
    tpPercent: 2.5,
    slPercent: 1.0,
    trailingStopPercent: 0.5,
    maxLossUsdt: 50,
    globalMaxLossUsdt: -50,
  };

  private positionState: Record<string, PositionRiskState> = {};
  private isProcessingTrade: Record<string, boolean> = {};
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly symbolCooldownMs = 10 * 60 * 1000;
  private readonly consecutiveLossPauseMs = 30 * 60 * 1000;
  private readonly consecutiveLossCount = 3;
  private riskBlockReason: string | null = "RISK_DATA_NOT_REFRESHED";
  private privateApiLastError: string | null = "Risk data has not been refreshed yet";
  private lastSuccessfulRiskDataRefresh: number | null = null;
  private consecutiveLossUntil: number | null = null;
  private scannerRunning = false;

  constructor(private bybit: RestClientV5, io: SocketIOServer, apiKey?: string, apiSecret?: string) {
    this.emitter = new WebSocketEmitter(io);
    this.riskManager = new RiskManager(bybit, this.emitter);
    this.telegram = new TelegramNotifier();
    this.wsManager = new BybitWebSocketManager(
      bybit,
      apiKey || process.env.BYBIT_API_KEY,
      apiSecret || process.env.BYBIT_API_SECRET,
      process.env.BYBIT_DEMO === "true"
    );
    this.scanner = new MarketScanner(bybit, this.emitter, this.telegram, this);
    this.setupWebSocketHandlers();
    void this.init();
  }

  private async init() {
    this.emitter.log("[TradingEngine] Initializing strict 5m scanner + real-time risk management...");
    await this.wsManager.init(this.watchlist);
    await this.syncPositions();
    await this.scanner.init();
    this.scannerRunning = true;
    this.start();
    this.emitRuntimeStatus();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => void this.syncPositions(), 5000);
  }

  private setupWebSocketHandlers() {
    this.wsManager.on("log", (msg: string) => this.emitter.log(msg));
    this.wsManager.on("status", () => this.emitRuntimeStatus());

    this.wsManager.on("kline", (payload: KlineEventPayload) => {
      const { symbol, candle, technicals } = payload;
      this.currentTechnicals[symbol] = { ema9: technicals.ema9, ema21: technicals.ema21, rsi: technicals.rsi, timestamp: Date.now() };
      this.emitter.updateKline({
        symbol,
        candle,
        ema9: { time: candle.time, value: Number(technicals.ema9.toFixed(4)) },
        ema21: { time: candle.time, value: Number(technicals.ema21.toFixed(4)) },
      });
      this.emitter.updateTechnicals(this.currentTechnicals);
    });

    this.wsManager.on("ticker", (payload: TickerEventPayload) => {
      this.currentPrices[payload.symbol] = payload.price;
      this.emitter.updatePrices(this.currentPrices);
      if (this.isRunning) void this.checkTrailingStopAndBreakEven(payload.symbol, payload.price);
    });

    this.wsManager.on("position", (updates: any[]) => {
      this.activePositions = mergePositionUpdates(this.activePositions, updates);
      this.emitter.updatePositions(this.activePositions);
    });

    this.wsManager.on("execution", (exec: any) => {
      if (exec.execType === "Trade" || exec.execType === "Bust") {
        this.emitter.log(`[Bybit WS Private] Order Fill: ${exec.symbol} ${exec.side} ${exec.execQty} @ $${exec.execPrice}`);
        this.emitter.tradeUpdate({
          id: exec.execId || exec.orderId,
          symbol: exec.symbol,
          side: exec.side,
          price: Number(exec.execPrice),
          qty: exec.execQty,
          time: Number(exec.execTime) || Date.now(),
        });
      }
    });

    this.wsManager.on("wallet", (walletBalance: string) => {
      this.currentBalance = walletBalance;
      this.emitter.updateBalance(walletBalance);
    });
  }

  private makeCloseOrderLinkId(kind: "manual" | "trail"): string {
    return `bot-${kind}-${Date.now().toString(36)}`;
  }

  private isCandidateStopTighter(side: "Buy" | "Sell", currentStop: number, candidateStop: number): boolean {
    if (!(candidateStop > 0)) return false;
    if (!(currentStop > 0)) return true;
    return side === "Buy" ? candidateStop >= currentStop : candidateStop <= currentStop;
  }

  private async buildAdaptiveStopPlan(symbol: string, side: "Buy" | "Sell", entryPrice: number, quality?: ScannerEntryQualityContext): Promise<AdaptiveStopPlan> {
    const klineRes = await this.bybit.getKline({ category: "linear", symbol, interval: "5", limit: 40 });
    if (klineRes.retCode !== 0 || !klineRes.result?.list) throw new Error("Confirmed 5m candles unavailable for adaptive SL");
    const now = Date.now();
    const closed = [...klineRes.result.list].reverse().filter((c: any) => Number(c[0]) + 5 * 60 * 1000 <= now);
    if (closed.length < 20) throw new Error("Insufficient confirmed 5m candles for adaptive SL");
    const highs = closed.map((c: any) => Number(c[2]));
    const lows = closed.map((c: any) => Number(c[3]));
    const closes = closed.map((c: any) => Number(c[4]));
    const atrs = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const calculatedAtr = atrs[atrs.length - 1];
    const atr = quality?.atr && quality.atr > 0 ? quality.atr : calculatedAtr;
    if (!(atr > 0)) throw new Error("ATR unavailable for adaptive SL");
    const recent = closed.slice(-6);
    const swingPrice = side === "Buy"
      ? Math.min(...recent.map((c: any) => Number(c[3])))
      : Math.max(...recent.map((c: any) => Number(c[2])));
    return calculateAdaptiveStopPlan({ side, entryPrice, atr, swingPrice, minDistancePercent: 1.0, maxDistancePercent: 1.8 });
  }

  private extractClosedTime(item: any): number {
    return normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime);
  }

  private markRiskUnavailable(reason: string, error: string) {
    this.riskBlockReason = reason;
    this.privateApiLastError = error;
    this.emitRuntimeStatus();
  }

  private markRiskHealthy() {
    this.riskBlockReason = null;
    this.privateApiLastError = null;
    this.lastSuccessfulRiskDataRefresh = Date.now();
    this.emitRuntimeStatus();
  }

  private updateConsecutiveLossState(closed: any[]) {
    const ordered = [...closed].sort((a: any, b: any) => this.extractClosedTime(b) - this.extractClosedTime(a));
    const recent = ordered.slice(0, this.consecutiveLossCount);
    if (recent.length === this.consecutiveLossCount && recent.every((trade: any) => Number(trade.closedPnl || 0) < 0)) {
      const latestClose = this.extractClosedTime(recent[0]);
      const until = latestClose + this.consecutiveLossPauseMs;
      this.consecutiveLossUntil = until > Date.now() ? until : null;
    } else {
      this.consecutiveLossUntil = null;
    }
  }

  private async getDailyRiskSnapshot() {
    const now = Date.now();
    const dayStartMs = getUtcDayStartMs(now);
    const historyStartMs = Math.min(dayStartMs, now - this.consecutiveLossPauseMs);

    const positionResult = await this.riskManager.getOpenPositions();
    if (!positionResult.ok) {
      this.markRiskUnavailable(POSITION_STATE_UNAVAILABLE, positionResult.error);
      return { ok: false as const, reason: POSITION_STATE_UNAVAILABLE, error: positionResult.error };
    }

    const closedResult = await fetchClosedPnlRange(this.bybit, historyStartMs, now + 1);
    if (!closedResult.ok) {
      this.markRiskUnavailable(DAILY_PNL_UNAVAILABLE, closedResult.error);
      return { ok: false as const, reason: DAILY_PNL_UNAVAILABLE, error: closedResult.error, positions: positionResult.positions };
    }

    const accounting = buildRiskAccounting(closedResult, positionResult.positions, dayStartMs);
    this.updateConsecutiveLossState(accounting.closed);
    this.markRiskHealthy();
    return { ok: true as const, positions: positionResult.positions, ...accounting };
  }

  public async canOpenSymbol(symbol: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.isRunning) return { allowed: false, reason: "BOT_HALTED" };

    const snapshot = await this.getDailyRiskSnapshot();
    if (!snapshot.ok) return { allowed: false, reason: snapshot.reason };

    this.activePositions = snapshot.positions;
    if (snapshot.positions.length >= this.settings.maxPositions) {
      return { allowed: false, reason: `MAX_POSITIONS_REACHED` };
    }
    if (snapshot.positions.some((p: any) => p.symbol === symbol && Number(p.size || 0) > 0)) {
      return { allowed: false, reason: "DUPLICATE_SYMBOL_BLOCKED" };
    }

    const dailyLimit = -Math.abs(this.settings.maxLossUsdt || 50);
    const riskDecision = evaluateEntryRiskAccounting(snapshot, dailyLimit);
    if (!riskDecision.allowed) {
      if (riskDecision.breakerTriggered) {
        this.circuitBreakerTriggered = true;
        this.emitRuntimeStatus();
      }
      return { allowed: false, reason: riskDecision.reason || DAILY_PNL_UNAVAILABLE };
    }

    const ordered = [...snapshot.closed].sort((a: any, b: any) => this.extractClosedTime(b) - this.extractClosedTime(a));
    if (this.consecutiveLossUntil && this.consecutiveLossUntil > Date.now()) {
      const latestClose = this.extractClosedTime(ordered[0]);
      void dbRecordReportEvent({
        eventKey: `loss-pause:${latestClose}`,
        eventType: "loss_pause_trigger",
        occurredAt: latestClose,
        reportingDate: bangladeshDateForTimestamp(latestClose),
        payload: { reason: `${this.consecutiveLossCount} consecutive losses`, streakCount: this.consecutiveLossCount },
      });
      this.emitRuntimeStatus();
      return { allowed: false, reason: "CONSECUTIVE_LOSS_BREAKER" };
    }

    const latestForSymbol = ordered.find((t: any) => t.symbol === symbol);
    if (latestForSymbol) {
      const closeTime = this.extractClosedTime(latestForSymbol);
      const remaining = this.symbolCooldownMs - (Date.now() - closeTime);
      if (remaining > 0) return { allowed: false, reason: `SYMBOL_COOLDOWN_ACTIVE:${Math.ceil(remaining / 60000)}m` };
    }

    if (this.circuitBreakerTriggered) {
      this.circuitBreakerTriggered = false;
      this.emitRuntimeStatus();
    }
    return { allowed: true };
  }

  private updateDailyCircuitBreaker(snapshot: { net: number | null }) {
    if (!Number.isFinite(snapshot.net)) return;
    const limit = -Math.abs(this.settings.maxLossUsdt || 50);
    const triggered = Number(snapshot.net) <= limit;
    if (triggered !== this.circuitBreakerTriggered) {
      this.circuitBreakerTriggered = triggered;
      this.emitRuntimeStatus();
      if (triggered) {
        this.emitter.log(`🚨 [DAILY ENTRY BREAKER] Net daily PnL $${Number(snapshot.net).toFixed(2)} reached $${limit.toFixed(2)}. New entries blocked; existing positions remain managed.`);
        this.telegram.send(`🚨 <b>DAILY ENTRY BREAKER</b>\nNet daily PnL: <b>$${Number(snapshot.net).toFixed(2)}</b>. New entries are blocked; open positions continue to be managed.`);
      } else {
        this.emitter.log("✅ [DAILY ENTRY BREAKER] UTC trading-day risk condition cleared; new entries may resume if all other rules pass.");
      }
    }
  }

  public async checkCircuitBreaker() {
    if (!this.isRunning) return;
    const snapshot = await this.getDailyRiskSnapshot();
    if (!snapshot.ok) {
      this.emitter.log(`[Risk] ${snapshot.reason}: ${snapshot.error}. New entries fail closed; existing positions remain managed.`);
      return;
    }
    this.updateDailyCircuitBreaker(snapshot);
  }

  public async syncPositions() {
    try {
      const snapshot = await this.getDailyRiskSnapshot();
      if (!snapshot.ok) {
        this.emitter.log(`[Risk Sync] ${snapshot.reason}: retaining last known positions; no close inference performed.`);
        return;
      }

      const previousSymbols = new Set(this.activePositions.filter((p) => Number(p.size || 0) > 0).map((p) => p.symbol));
      const positions = snapshot.positions;
      const currentSymbols = new Set(positions.map((p) => p.symbol));

      for (const symbol of previousSymbols) {
        if (!currentSymbols.has(symbol)) await this.recordLatestClosedTrade(symbol);
      }

      this.activePositions = positions;
      for (const pos of positions) {
        if (Number(pos.positionIdx ?? 0) !== 0) {
          this.emitter.log(`[Risk] ${pos.symbol} is reported with positionIdx=${pos.positionIdx}; new entries require one-way mode.`);
        }
        const price = Number(pos.markPrice || pos.avgPrice || 0);
        if (!this.positionState[pos.symbol] && price > 0) {
          const entry = Number(pos.avgPrice || price);
          const currentStop = Number(pos.stopLoss || 0);
          const initialRiskPercent = entry > 0 && currentStop > 0 ? Math.abs(entry - currentStop) / entry * 100 : this.settings.slPercent;
          this.positionState[pos.symbol] = { peakPrice: price, breakEvenSet: false, initialStopLoss: currentStop || undefined, initialRiskPercent };
        }
      }
      for (const symbol of Object.keys(this.positionState)) if (!currentSymbols.has(symbol)) delete this.positionState[symbol];
      this.emitter.updatePositions(positions);
      this.updateDailyCircuitBreaker(snapshot);
    } catch (error: any) {
      this.emitter.log(`[Risk Sync] Unexpected sync error: ${error?.message || error}`);
    }
  }

  private async recordLatestClosedTrade(symbol: string) {
    try {
      const res = await this.bybit.getClosedPnL({ category: "linear", symbol, limit: 1 });
      const item: any = res.retCode === 0 ? res.result?.list?.[0] : null;
      if (!item) return;
      const pnl = Number(item.closedPnl || 0);
      const entryPrice = Number(item.avgEntryPrice || 0);
      const exitPrice = Number(item.avgExitPrice || 0);
      const qty = Number(item.qty || 0);
      const entryNotional = entryPrice * qty;
      const pnlPercent = entryNotional > 0 ? (pnl / entryNotional) * 100 : 0;
      const time = this.extractClosedTime(item) || Date.now();
      const id = String(item.orderId || `${symbol}-${time}`);
      if (this.tradeHistory.some((t) => t.id === id)) return;

      const side = item.side === "Sell" ? "Buy" : "Sell";
      const windowStart = Math.max(0, time - 180_000);
      const windowEnd = Math.min(Date.now(), time + 180_000);
      const [execRes, orderRes] = await Promise.all([
        this.bybit.getExecutionList({ category: "linear", symbol, startTime: windowStart, endTime: windowEnd, limit: 100 }).catch(() => null),
        this.bybit.getHistoricOrders({ category: "linear", symbol, startTime: windowStart, endTime: windowEnd, limit: 100 }).catch(() => null),
      ]);
      const classified = classifyClosedTradeExit({
        closedTrade: item,
        executions: execRes?.retCode === 0 ? (execRes.result?.list || []) : [],
        orders: orderRes?.retCode === 0 ? (orderRes.result?.list || []) : [],
        localHistory: this.tradeHistory,
      });
      const trade = { id, symbol, side, entryPrice, exitPrice, qty, reason: classified.label, pnl, pnlPercent, time, exitAudit: classified };
      this.tradeHistory.unshift(trade);
      this.emitter.tradeUpdate(trade);
      this.telegram.sendTradeClosed(symbol, exitPrice, classified.label, pnl, pnlPercent);
      dbRecordTrade({
        symbol,
        side,
        entryPrice,
        exitPrice,
        status: "CLOSED",
        exitReason: classified.label,
        exitAudit: classified,
        source: "external",
        closingOrderId: classified.matchedOrderId || item.orderId || null,
        closingOrderLinkId: classified.matchedOrderLinkId || item.orderLinkId || null,
        realizedPnl: pnl,
        closedAt: time,
        sizeNotional: entryNotional,
        marginUsed: entryNotional / (this.settings.leverage || 10),
        leverage: this.settings.leverage || 10,
      });
    } catch (err: any) {
      this.emitter.log(`[${symbol}] Closed-PnL reconciliation warning: ${err.message}`);
    }
  }

  private async validatePreOrder(
    symbol: string,
    side: "Buy" | "Sell",
    notionalSizeUsdt: number,
    requestedQty?: string,
  ): Promise<PreOrderValidation> {
    const denied = (reason: string, price: number = 0): PreOrderValidation => ({
      valid: false,
      qty: "0",
      qtyNumber: 0,
      price,
      approvedNotional: notionalSizeUsdt,
      actualNotional: 0,
      reason,
    });

    const risk = await this.canOpenSymbol(symbol);
    if (!risk.allowed) return denied(risk.reason || "RISK_VALIDATION_FAILED");

    const wallet = await fetchUnifiedAvailableBalance(this.bybit);
    if (!wallet.ok) {
      this.emitter.log(`[${symbol}] ${wallet.reason}: ${wallet.error}`);
      return denied(wallet.reason);
    }
    const requiredMargin = notionalSizeUsdt / this.settings.leverage;
    if (wallet.value + 1e-9 < requiredMargin) return denied("INSUFFICIENT_AVAILABLE_MARGIN");

    const top = await fetchTopOfBook(this.bybit, symbol);
    if (!top.ok) {
      this.emitter.log(`[${symbol}] ${top.reason}: ${top.error}`);
      return denied(top.reason);
    }
    const { bid, ask } = top.value;
    const executionPrice = side === "Buy" ? ask : bid;
    const mid = (bid + ask) / 2;
    const spread = mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(spread) || spread > 0.08) return denied("SPREAD_LIMIT_EXCEEDED", executionPrice);

    const instrument = await fetchInstrumentConstraints(this.bybit, symbol);
    if (!instrument.ok) {
      this.emitter.log(`[${symbol}] ${instrument.reason}: ${instrument.error}`);
      return denied(instrument.reason, executionPrice);
    }

    const approved = calculateApprovedQuantity(notionalSizeUsdt, executionPrice, instrument.value);
    if (!approved.ok) {
      this.emitter.log(`[${symbol}] ${approved.reason}: ${approved.error}`);
      return denied(approved.reason, executionPrice);
    }

    const finalQty = validateFinalRequestedQuantity(
      requestedQty,
      approved,
      executionPrice,
      notionalSizeUsdt,
      instrument.value,
    );
    if (!finalQty.ok) {
      this.emitter.log(`[${symbol}] ${finalQty.reason}: ${finalQty.error}`);
      return denied(finalQty.reason, executionPrice);
    }

    return {
      valid: true,
      qty: finalQty.qtyText,
      qtyNumber: finalQty.qty,
      price: executionPrice,
      approvedNotional: notionalSizeUsdt,
      actualNotional: finalQty.actualNotional,
      constraints: instrument.value,
    };
  }

  private async enforceExecutionConfiguration(symbol: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const positionMode = await ensureOneWayPositionMode(this.bybit, symbol);
    if (!positionMode.ok) {
      this.emitter.log(`[${symbol}] ${positionMode.reason}: ${positionMode.error}`);
      return { ok: false, reason: positionMode.reason };
    }
    const leverage = await ensureConfiguredLeverage(this.bybit, symbol, this.settings.leverage);
    if (!leverage.ok) {
      this.emitter.log(`[${symbol}] ${leverage.reason}: ${leverage.error}`);
      return { ok: false, reason: leverage.reason };
    }
    return { ok: true };
  }

  private async resolveConfirmedFill(symbol: string, orderId: string, requestedQty: number) {
    let latest = await fetchOrderFillSnapshot(this.bybit, symbol, orderId);
    for (const delay of [150, 350, 700]) {
      if (latest.confirmed) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      latest = await fetchOrderFillSnapshot(this.bybit, symbol, orderId);
    }
    return {
      ...latest,
      fullyFilled: latest.confirmed && latest.filledQty + 1e-10 >= requestedQty,
    };
  }

  public async executeScannerEntry(
    symbol: string,
    side: "Buy" | "Sell",
    currentPrice: number,
    ema50: number,
    ema200: number,
    rsi: number,
    quality?: ScannerEntryQualityContext
  ): Promise<{ success: boolean; message: string; orderId?: string; fillConfirmed?: boolean }> {
    const targetSymbol = symbol.toUpperCase();
    if (this.isProcessingTrade[targetSymbol]) return { success: false, message: `Trade already in progress for ${targetSymbol}` };
    this.isProcessingTrade[targetSymbol] = true;

    try {
      const baseNotional = this.settings.positionMarginUsdt * this.settings.leverage;
      let targetNotional = baseNotional;
      let pre = await this.validatePreOrder(targetSymbol, side, targetNotional);
      if (!pre.valid || !pre.constraints) return { success: false, message: pre.reason || "Risk validation failed" };
      currentPrice = pre.price;

      let stopPlan = await this.buildAdaptiveStopPlan(targetSymbol, side, currentPrice, quality);
      for (let pass = 0; pass < 2; pass++) {
        const riskAdjustedNotional = Math.min(
          targetNotional,
          calculateRiskAdjustedNotional(baseNotional, stopPlan.stopDistancePercent, this.settings.slPercent),
        );
        if (riskAdjustedNotional >= targetNotional - 1e-8) break;
        targetNotional = riskAdjustedNotional;
        pre = await this.validatePreOrder(targetSymbol, side, targetNotional);
        if (!pre.valid || !pre.constraints) return { success: false, message: pre.reason || "Risk-adjusted sizing validation failed" };
        currentPrice = pre.price;
        stopPlan = await this.buildAdaptiveStopPlan(targetSymbol, side, currentPrice, quality);
      }

      const direction = side === "Buy" ? 1 : -1;
      const rawTakeProfit = currentPrice * (1 + direction * this.settings.tpPercent / 100);
      const protective = quantizeProtectivePrices(side, rawTakeProfit, stopPlan.stopLoss, pre.constraints);
      const actualNotional = pre.actualNotional;
      const actualMargin = actualNotional / this.settings.leverage;

      const config = await this.enforceExecutionConfiguration(targetSymbol);
      if (!config.ok) return { success: false, message: config.reason };

      this.emitter.log(`⚡ [Scanner Execution] ${side === "Buy" ? "LONG" : "SHORT"} ${targetSymbol} | Margin cap $${this.settings.positionMarginUsdt} | Approved notional $${targetNotional.toFixed(2)} | Requested ~$${actualNotional.toFixed(2)} | TP ${protective.takeProfit} | SL ${protective.stopLoss}`);
      this.emitter.log(`[Trade Quality] ${targetSymbol} RSI=${rsi.toFixed(1)} ATR%=${stopPlan.atrPercent.toFixed(3)} OI=${quality?.oiExpansionPercent?.toFixed(3) ?? "N/A"}% Spread=${quality?.spreadPercent?.toFixed(3) ?? "N/A"}% Trend=${quality?.trendState ?? "N/A"} EMA9=${quality?.ema9?.toFixed(6) ?? "N/A"} EMA21=${quality?.ema21?.toFixed(6) ?? "N/A"} Timing=${quality?.emaTimingScore?.toFixed(2) ?? "N/A"}/2 Cross=${quality?.freshCross ?? "none"}@${quality?.crossoverAgeCandles ?? "N/A"} Setup=${quality?.finalSetupScore?.toFixed(2) ?? "N/A"} BreakoutBonus=${Boolean(quality?.breakoutBonus)} Candle=${quality?.entryCandleDirection ?? "N/A"} SL=${stopPlan.stopDistancePercent.toFixed(3)}% (${stopPlan.stopDistanceAtrMultiple.toFixed(2)} ATR) Reason=${stopPlan.reason}`);

      const orderRes = await this.bybit.submitOrder({
        category: "linear",
        symbol: targetSymbol,
        side,
        orderType: "Market",
        qty: pre.qty,
        timeInForce: "IOC",
        takeProfit: protective.takeProfit,
        stopLoss: protective.stopLoss,
        positionIdx: 0,
      });
      if (orderRes.retCode !== 0) return { success: false, message: orderRes.retMsg || "Bybit rejected scanner order" };

      const orderId = orderRes.result?.orderId;
      if (!orderId) {
        setTimeout(() => void this.syncPositions(), 800);
        return { success: true, message: `${targetSymbol} order acknowledged; fill confirmation pending`, fillConfirmed: false };
      }

      const fill = await this.resolveConfirmedFill(targetSymbol, orderId, pre.qtyNumber);
      if (!fill.confirmed || !fill.avgFillPrice) {
        this.emitter.log(`[${targetSymbol}] Order ${orderId} acknowledged by Bybit; no execution fill confirmed yet.`);
        setTimeout(() => void this.syncPositions(), 800);
        return { success: true, message: `${targetSymbol} order acknowledged; fill confirmation pending`, orderId, fillConfirmed: false };
      }

      const filledQty = fill.filledQty;
      const fillPrice = fill.avgFillPrice;
      const filledNotional = filledQty * fillPrice;
      const filledMargin = filledNotional / this.settings.leverage;
      this.activePositions = mergePositionUpdates(this.activePositions, [{
        symbol: targetSymbol,
        side,
        positionIdx: 0,
        size: String(filledQty),
        avgPrice: String(fillPrice),
        markPrice: String(fillPrice),
        stopLoss: protective.stopLoss,
        takeProfit: protective.takeProfit,
      }]);
      this.positionState[targetSymbol] = {
        peakPrice: fillPrice,
        breakEvenSet: false,
        initialStopLoss: Number(protective.stopLoss),
        initialRiskPercent: stopPlan.stopDistancePercent,
        atrPercent: stopPlan.atrPercent,
      };
      this.emitter.updatePositions(this.activePositions);
      this.telegram.sendTradeExecution(targetSymbol, side === "Buy" ? "Long (Strict Scanner)" : "Short (Strict Scanner)", fillPrice, String(filledQty), protective.takeProfit, protective.stopLoss);
      dbRecordTrade({
        symbol: targetSymbol,
        side,
        entryPrice: fillPrice,
        status: "OPEN",
        source: "auto",
        openingOrderId: orderId,
        openingOrderLinkId: null,
        sizeNotional: filledNotional,
        marginUsed: filledMargin,
        leverage: this.settings.leverage,
        entryDiagnostics: {
          rsi,
          atr: quality?.atr ?? null,
          atrPercent: stopPlan.atrPercent,
          oiExpansionPercent: quality?.oiExpansionPercent ?? null,
          spreadPercent: quality?.spreadPercent ?? null,
          trendState: quality?.trendState ?? null,
          breakoutBonus: Boolean(quality?.breakoutBonus),
          entryCandleDirection: quality?.entryCandleDirection ?? null,
          ema9: quality?.ema9 ?? null,
          ema21: quality?.ema21 ?? null,
          ema9Above21: quality?.ema9Above21 ?? null,
          ema9Slope: quality?.ema9Slope ?? null,
          ema21Slope: quality?.ema21Slope ?? null,
          freshCross: quality?.freshCross ?? "none",
          crossoverAgeCandles: quality?.crossoverAgeCandles ?? null,
          emaTimingScore: quality?.emaTimingScore ?? 0,
          finalSetupScore: quality?.finalSetupScore ?? 6,
          emaTimingState: quality?.emaTimingState ?? "Unavailable",
          emaTimingChoppy: quality?.emaTimingChoppy ?? false,
          slDistancePercent: stopPlan.stopDistancePercent,
          slDistanceAtrMultiple: stopPlan.stopDistanceAtrMultiple,
          slReason: stopPlan.reason,
          configuredMarginCapUsdt: this.settings.positionMarginUsdt,
          riskApprovedNotionalUsdt: targetNotional,
          actualMarginUsedUsdt: filledMargin,
          actualNotionalUsdt: filledNotional,
          requestedQty: pre.qty,
          confirmedFillQty: filledQty,
          fillCompleteAtConfirmation: fill.fullyFilled,
        },
      });
      if (!this.watchlist.includes(targetSymbol)) void this.addSymbol(targetSymbol);
      setTimeout(() => void this.syncPositions(), 800);
      return {
        success: true,
        message: `${side === "Buy" ? "Long" : "Short"} ${fill.fullyFilled ? "fill" : "partial fill"} confirmed for ${targetSymbol}`,
        orderId,
        fillConfirmed: true,
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    } finally {
      this.isProcessingTrade[targetSymbol] = false;
    }
  }

  private async checkTrailingStopAndBreakEven(symbol: string, currentPrice: number) {
    if (this.isProcessingTrade[symbol]) return;
    const pos = this.activePositions.find((p) => p.symbol === symbol && Number(p.size || 0) > 0);
    if (!pos) return;
    const entry = Number(pos.avgPrice || 0);
    if (!(entry > 0)) return;
    const isLong = pos.side === "Buy";
    const pnlPercent = ((currentPrice - entry) / entry) * 100 * (isLong ? 1 : -1);

    if (!this.positionState[symbol]) this.positionState[symbol] = { peakPrice: currentPrice, breakEvenSet: false };
    const state = this.positionState[symbol];
    if (isLong) state.peakPrice = Math.max(state.peakPrice, currentPrice);
    else state.peakPrice = Math.min(state.peakPrice, currentPrice);

    const breakEvenTriggerPercent = Math.max(
      1.0,
      state.initialRiskPercent || this.settings.slPercent,
      (state.atrPercent || 0) * 1.25
    );

    if (pnlPercent >= breakEvenTriggerPercent && !state.breakEvenSet) {
      try {
        const instrument = await fetchInstrumentConstraints(this.bybit, symbol);
        if (!instrument.ok) {
          this.emitter.log(`[${symbol}] Break-even skipped: ${instrument.reason}`);
          return;
        }
        const candidateText = quantizePrice(
          entry,
          instrument.value.tickSize,
          instrument.value.tickSizeText,
          isLong ? "ceil" : "floor",
        );
        const candidate = Number(candidateText);
        const currentStop = Number(pos.stopLoss || state.initialStopLoss || 0);
        if (this.isCandidateStopTighter(isLong ? "Buy" : "Sell", currentStop, candidate)) {
          await this.bybit.setTradingStop({ category: "linear", symbol, stopLoss: candidateText, slTriggerBy: "LastPrice", positionIdx: 0 });
          this.emitter.log(`[${symbol}] +${breakEvenTriggerPercent.toFixed(2)}% quality threshold reached; SL tightened to tick-aligned break-even.`);
        } else {
          this.emitter.log(`[${symbol}] Break-even candidate skipped because current SL is already tighter; no widening allowed.`);
        }
        state.breakEvenSet = true;
      } catch (err: any) {
        this.emitter.log(`[${symbol}] Break-even update warning: ${err.message}`);
      }
    }

    if (pnlPercent < breakEvenTriggerPercent) return;
    const trailingDistancePercent = Math.max(this.settings.trailingStopPercent, Math.min(1.0, (state.atrPercent || 0) * 0.75));
    const trailing = isLong
      ? state.peakPrice * (1 - trailingDistancePercent / 100)
      : state.peakPrice * (1 + trailingDistancePercent / 100);
    const triggered = isLong ? currentPrice <= trailing : currentPrice >= trailing;
    if (!triggered) return;

    this.isProcessingTrade[symbol] = true;
    try {
      const closeRes = await this.bybit.submitOrder({
        category: "linear",
        symbol,
        side: isLong ? "Sell" : "Buy",
        orderType: "Market",
        qty: String(pos.size),
        reduceOnly: true,
        timeInForce: "IOC",
        orderLinkId: this.makeCloseOrderLinkId("trail"),
        positionIdx: 0,
      });
      if (closeRes.retCode === 0) {
        const orderId = closeRes.result?.orderId;
        const fill = orderId ? await this.resolveConfirmedFill(symbol, orderId, Number(pos.size)) : null;
        this.emitter.log(fill?.confirmed
          ? `[${symbol}] Trailing-stop execution confirmed for ${fill.filledQty} @ ${fill.avgFillPrice}.`
          : `[${symbol}] Trailing-stop close acknowledged; awaiting execution/position confirmation.`);
        setTimeout(() => void this.syncPositions(), 500);
      }
    } catch (err: any) {
      this.emitter.log(`[${symbol}] Trailing stop error: ${err.message}`);
    } finally {
      this.isProcessingTrade[symbol] = false;
    }
  }

  public updateSettings(newSettings: Partial<typeof this.settings>) {
    this.settings = {
      ...this.settings,
      ...newSettings,
      positionMarginUsdt: 50,
      maxPositions: 3,
      maxLossUsdt: 50,
      globalMaxLossUsdt: -50,
    };
    this.scanner.setMaxConcurrent(3);
    this.emitter.log("[Settings] Strict risk caps enforced by backend runtime policy.");
    this.emitRuntimeStatus();
  }

  public async addSymbol(symbol: string) {
    const formatted = symbol.toUpperCase();
    if (!this.watchlist.includes(formatted)) {
      this.watchlist.push(formatted);
      this.emitter.updateWatchlist(this.watchlist);
      await this.wsManager.addSymbol(formatted);
    }
  }

  public removeSymbol(symbol: string) {
    const formatted = symbol.toUpperCase();
    this.watchlist = this.watchlist.filter((s) => s !== formatted);
    delete this.currentPrices[formatted];
    delete this.currentTechnicals[formatted];
    this.emitter.updateWatchlist(this.watchlist);
    this.emitter.updatePrices(this.currentPrices);
    this.wsManager.removeSymbol(formatted);
  }

  public getHistory() { return this.tradeHistory; }
  public getTechnicals() { return this.currentTechnicals; }
  public getIsRunning() { return this.isRunning; }
  public testTelegram() { this.telegram.send("🔔 <b>Test Notification</b>\nStrict Bybit demo trading pipeline is active."); }

  public getRuntimeRiskStatus(): RuntimeRiskStatus {
    const now = Date.now();
    const consecutiveActive = Boolean(this.consecutiveLossUntil && this.consecutiveLossUntil > now);
    const privateWs = this.wsManager.getPrivateHealth();
    const privateApiHealthy = this.riskBlockReason === null && this.lastSuccessfulRiskDataRefresh !== null;
    const breakerReason = this.riskBlockReason
      || (this.circuitBreakerTriggered ? "DAILY_LOSS_BREAKER" : null)
      || (consecutiveActive ? "CONSECUTIVE_LOSS_BREAKER" : null);
    return {
      leverage: this.settings.leverage,
      marginCapUsdt: this.settings.positionMarginUsdt,
      approximateMaxNotionalUsdt: this.settings.positionMarginUsdt * this.settings.leverage,
      maxPositions: this.settings.maxPositions,
      scannerMaxConcurrent: this.scanner.maxConcurrent,
      duplicateSymbolPolicy: "DENY_SAME_SYMBOL",
      cooldown: {
        symbolMs: this.symbolCooldownMs,
        description: "Post-close same-symbol cooldown",
      },
      dailyLossBreaker: {
        limitUsdt: -Math.abs(this.settings.maxLossUsdt),
        active: this.circuitBreakerTriggered,
        scope: "NEW_ENTRIES_ONLY",
      },
      consecutiveLossBreaker: {
        losses: this.consecutiveLossCount,
        pauseMs: this.consecutiveLossPauseMs,
        active: consecutiveActive,
        until: consecutiveActive ? this.consecutiveLossUntil : null,
      },
      stopLossDiscipline: {
        mode: "ADAPTIVE_ATR_STRUCTURE",
        minInitialDistancePercent: 1.0,
        maxInitialDistancePercent: 1.8,
        breakEvenAtrMultiple: 1.25,
        neverWiden: true,
      },
      botRunning: this.isRunning,
      scannerRunning: this.scannerRunning,
      autoTrade: this.scanner.autoTrade,
      breakerActive: Boolean(breakerReason),
      breakerReason,
      bybitPrivateApiHealth: {
        healthy: privateApiHealthy,
        status: privateApiHealthy ? "healthy" : "unavailable",
        lastError: this.privateApiLastError,
      },
      bybitPrivateWsHealth: privateWs,
      lastSuccessfulRiskDataRefresh: this.lastSuccessfulRiskDataRefresh,
    };
  }

  public emitRuntimeStatus() {
    this.emitter.updateRuntimeStatus(this.getRuntimeRiskStatus());
  }

  public resetCircuitBreaker() {
    this.circuitBreakerTriggered = false;
    this.emitRuntimeStatus();
    this.emitter.log("✅ Daily breaker display reset. Risk-data and loss-pause breakers remain authoritative and are revalidated before every entry.");
  }

  public start() {
    if (this.isRunning) return false;
    this.isRunning = true;
    this.emitter.emitStatus(true, this.getRuntimeRiskStatus().breakerActive);
    this.emitRuntimeStatus();
    this.telegram.sendBotStatus(true);
    this.emitter.log(`🚀 [Bot Started] Strict runtime risk policy active.`);
    void this.syncPositions();
    return true;
  }

  public stop() {
    if (!this.isRunning) return false;
    this.isRunning = false;
    this.emitter.emitStatus(false, this.getRuntimeRiskStatus().breakerActive);
    this.emitRuntimeStatus();
    this.telegram.sendBotStatus(false);
    this.emitter.log("🛑 [Bot Stopped] New entries and active management paused.");
    return true;
  }

  public async manualClosePosition(symbol: string): Promise<{ success: boolean; message: string; orderId?: string; fillConfirmed?: boolean }> {
    const target = symbol.toUpperCase();
    const pos = this.activePositions.find((p) => p.symbol === target && Number(p.size || 0) > 0);
    if (!pos) return { success: false, message: `No active position found for ${target}` };
    try {
      const result = await this.bybit.submitOrder({
        category: "linear",
        symbol: target,
        side: pos.side === "Buy" ? "Sell" : "Buy",
        orderType: "Market",
        qty: String(pos.size),
        reduceOnly: true,
        timeInForce: "IOC",
        orderLinkId: this.makeCloseOrderLinkId("manual"),
        positionIdx: 0,
      });
      if (result.retCode !== 0) return { success: false, message: result.retMsg || "Bybit rejected close" };
      const orderId = result.result?.orderId;
      const fill = orderId ? await this.resolveConfirmedFill(target, orderId, Number(pos.size)) : null;
      setTimeout(() => void this.syncPositions(), 500);
      if (fill?.confirmed) {
        return {
          success: true,
          message: `${target} close execution confirmed for ${fill.filledQty} @ ${fill.avgFillPrice}`,
          orderId,
          fillConfirmed: true,
        };
      }
      return {
        success: true,
        message: `${target} close acknowledged; awaiting execution/position confirmation`,
        orderId,
        fillConfirmed: false,
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  public async closeAllPositions(): Promise<{ success: boolean; closedCount: number; results: any[] }> {
    const results: any[] = [];
    let closedCount = 0;
    const positionResult = await this.riskManager.getOpenPositions();
    if (!positionResult.ok) {
      return { success: false, closedCount: 0, results: [{ error: POSITION_STATE_UNAVAILABLE }] };
    }

    for (const pos of positionResult.positions) {
      try {
        const result = await this.bybit.submitOrder({
          category: "linear",
          symbol: pos.symbol,
          side: pos.side === "Buy" ? "Sell" : "Buy",
          orderType: "Market",
          qty: String(pos.size),
          reduceOnly: true,
          timeInForce: "IOC",
          orderLinkId: this.makeCloseOrderLinkId("manual"),
          positionIdx: 0,
        });
        if (result.retCode !== 0) {
          results.push({ symbol: pos.symbol, success: false, error: result.retMsg || "Bybit rejected close" });
          continue;
        }
        const orderId = result.result?.orderId;
        const fill = orderId ? await this.resolveConfirmedFill(pos.symbol, orderId, Number(pos.size)) : null;
        const fullyClosedFill = Boolean(fill?.confirmed && fill.fullyFilled);
        if (fullyClosedFill) closedCount++;
        results.push({
          symbol: pos.symbol,
          success: true,
          orderId,
          acknowledged: true,
          fillConfirmed: Boolean(fill?.confirmed),
          fullyClosedFill,
          filledQty: fill?.filledQty || 0,
          avgFillPrice: fill?.avgFillPrice || null,
        });
      } catch (err: any) {
        results.push({ symbol: pos.symbol, success: false, error: err.message });
      }
    }
    setTimeout(() => void this.syncPositions(), 800);
    return { success: results.every((item) => item.success), closedCount, results };
  }

  public async executeManualTestOrder(symbol: string = "BTCUSDT", customQty?: string): Promise<{ success: boolean; message: string; orderId?: string; fillConfirmed?: boolean }> {
    const target = symbol.toUpperCase();
    const approvedNotional = this.settings.positionMarginUsdt * this.settings.leverage;
    const pre = await this.validatePreOrder(target, "Buy", approvedNotional, customQty);
    if (!pre.valid || !pre.constraints) return { success: false, message: pre.reason || "Risk validation failed" };

    const rawTakeProfit = pre.price * (1 + this.settings.tpPercent / 100);
    const rawStopLoss = pre.price * (1 - this.settings.slPercent / 100);
    const protective = quantizeProtectivePrices("Buy", rawTakeProfit, rawStopLoss, pre.constraints);
    try {
      const config = await this.enforceExecutionConfiguration(target);
      if (!config.ok) return { success: false, message: config.reason };

      const result = await this.bybit.submitOrder({
        category: "linear",
        symbol: target,
        side: "Buy",
        orderType: "Market",
        qty: pre.qty,
        timeInForce: "IOC",
        takeProfit: protective.takeProfit,
        stopLoss: protective.stopLoss,
        positionIdx: 0,
      });
      if (result.retCode !== 0) return { success: false, message: result.retMsg || "Bybit rejected test order" };
      const orderId = result.result?.orderId;
      if (!orderId) {
        setTimeout(() => void this.syncPositions(), 800);
        return { success: true, message: `Test order acknowledged for ${target}; fill confirmation pending`, fillConfirmed: false };
      }

      const fill = await this.resolveConfirmedFill(target, orderId, pre.qtyNumber);
      if (!fill.confirmed || !fill.avgFillPrice) {
        setTimeout(() => void this.syncPositions(), 800);
        return { success: true, message: `Test order acknowledged for ${target}; fill confirmation pending`, orderId, fillConfirmed: false };
      }

      const filledNotional = fill.filledQty * fill.avgFillPrice;
      const filledMargin = filledNotional / this.settings.leverage;
      this.activePositions = mergePositionUpdates(this.activePositions, [{
        symbol: target,
        side: "Buy",
        positionIdx: 0,
        size: String(fill.filledQty),
        avgPrice: String(fill.avgFillPrice),
        markPrice: String(fill.avgFillPrice),
        stopLoss: protective.stopLoss,
        takeProfit: protective.takeProfit,
      }]);
      this.positionState[target] = {
        peakPrice: fill.avgFillPrice,
        breakEvenSet: false,
        initialStopLoss: Number(protective.stopLoss),
        initialRiskPercent: this.settings.slPercent,
      };
      this.emitter.updatePositions(this.activePositions);
      dbRecordTrade({
        symbol: target,
        side: "Buy",
        entryPrice: fill.avgFillPrice,
        status: "OPEN",
        source: "manual",
        openingOrderId: orderId,
        openingOrderLinkId: null,
        sizeNotional: filledNotional,
        marginUsed: filledMargin,
        leverage: this.settings.leverage,
      });
      setTimeout(() => void this.syncPositions(), 800);
      return {
        success: true,
        message: `Test ${fill.fullyFilled ? "fill" : "partial fill"} confirmed for ${target}`,
        orderId,
        fillConfirmed: true,
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  public shutdown() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.scannerRunning = false;
    this.stop();
    this.wsManager.close();
    this.emitRuntimeStatus();
  }
}
