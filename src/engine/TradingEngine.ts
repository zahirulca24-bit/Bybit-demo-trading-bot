import { RestClientV5 } from "bybit-api";
import { Server as SocketIOServer } from "socket.io";
import { TelegramNotifier } from "./TelegramNotifier";
import { BybitWebSocketManager, KlineEventPayload, TickerEventPayload } from "./BybitWebSocketManager";
import { MarketScanner } from "./MarketScanner";
import { dbRecordTrade } from "../db";

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

  async getOpenPositions(): Promise<any[]> {
    try {
      const response = await this.bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
      return (response.result?.list || []).filter((p: any) => Number(p.size || 0) > 0);
    } catch (err: any) {
      this.emitter.log(`[RiskManager] Error fetching positions: ${err.message}`);
      return [];
    }
  }

  calculateBrackets(price: number, tpPercent: number, slPercent: number, side: "Buy" | "Sell" = "Buy") {
    const direction = side === "Buy" ? 1 : -1;
    const takeProfit = (price * (1 + direction * tpPercent / 100)).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    const stopLoss = (price * (1 - direction * slPercent / 100)).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    return { takeProfit, stopLoss };
  }
}

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

  private positionState: Record<string, { peakPrice: number; breakEvenSet: boolean }> = {};
  private isProcessingTrade: Record<string, boolean> = {};
  private syncTimer: NodeJS.Timeout | null = null;
  private lastRiskLogAt = 0;
  private readonly symbolCooldownMs = 10 * 60 * 1000;
  private readonly consecutiveLossPauseMs = 30 * 60 * 1000;

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
    this.start();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => void this.syncPositions(), 5000);
  }

  private setupWebSocketHandlers() {
    this.wsManager.on("log", (msg: string) => this.emitter.log(msg));

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
      // Legacy 1m auto-entry is intentionally disabled. New entries come only from the confirmed 5m strict scanner.
    });

    this.wsManager.on("ticker", (payload: TickerEventPayload) => {
      this.currentPrices[payload.symbol] = payload.price;
      this.emitter.updatePrices(this.currentPrices);
      if (this.isRunning) void this.checkTrailingStopAndBreakEven(payload.symbol, payload.price);
    });

    this.wsManager.on("position", (positions: any[]) => {
      this.activePositions = positions.filter((p) => Number(p.size || 0) > 0);
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

  private async ensureLeverage(symbol: string) {
    try {
      await this.bybit.setLeverage({
        category: "linear",
        symbol,
        buyLeverage: String(this.settings.leverage),
        sellLeverage: String(this.settings.leverage),
      });
    } catch (err: any) {
      if (!String(err?.message || "").toLowerCase().includes("not modified")) this.emitter.log(`[${symbol}] Leverage warning: ${err.message}`);
    }
  }

  private extractClosedTime(item: any): number {
    return Number(item.updatedTime || item.createdTime || item.execTime || 0);
  }

  private async getDailyRiskSnapshot() {
    const [positions, closedRes] = await Promise.all([
      this.riskManager.getOpenPositions(),
      this.bybit.getClosedPnL({ category: "linear", limit: 100 }).catch(() => null),
    ]);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const closed = closedRes?.retCode === 0 ? (closedRes.result?.list || []) : [];
    const realized = closed.reduce((sum: number, item: any) => {
      const t = this.extractClosedTime(item);
      return t >= start.getTime() ? sum + Number(item.closedPnl || 0) : sum;
    }, 0);
    const unrealized = positions.reduce((sum: number, pos: any) => sum + Number(pos.unrealisedPnl || 0), 0);
    return { positions, closed, realized, unrealized, net: realized + unrealized };
  }

  public async canOpenSymbol(symbol: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.isRunning) return { allowed: false, reason: "Bot engine is halted" };

    try {
      const snapshot = await this.getDailyRiskSnapshot();
      this.activePositions = snapshot.positions;

      if (snapshot.positions.length >= this.settings.maxPositions) {
        return { allowed: false, reason: `Max ${this.settings.maxPositions} concurrent positions reached` };
      }
      if (snapshot.positions.some((p: any) => p.symbol === symbol && Number(p.size || 0) > 0)) {
        return { allowed: false, reason: "Same-symbol position already open" };
      }

      const dailyLimit = -Math.abs(this.settings.maxLossUsdt || 50);
      if (snapshot.net <= dailyLimit) {
        this.circuitBreakerTriggered = true;
        this.emitter.emitStatus(this.isRunning, true);
        return { allowed: false, reason: `Daily circuit breaker active: net PnL $${snapshot.net.toFixed(2)} <= $${dailyLimit.toFixed(2)}` };
      }

      const ordered = [...snapshot.closed].sort((a: any, b: any) => this.extractClosedTime(b) - this.extractClosedTime(a));
      const lastThree = ordered.slice(0, 3);
      if (lastThree.length === 3 && lastThree.every((t: any) => Number(t.closedPnl || 0) < 0)) {
        const latestClose = this.extractClosedTime(lastThree[0]);
        const remaining = this.consecutiveLossPauseMs - (Date.now() - latestClose);
        if (remaining > 0) return { allowed: false, reason: `3-loss pause active (${Math.ceil(remaining / 60000)}m remaining)` };
      }

      const latestForSymbol = ordered.find((t: any) => t.symbol === symbol);
      if (latestForSymbol) {
        const closeTime = this.extractClosedTime(latestForSymbol);
        const remaining = this.symbolCooldownMs - (Date.now() - closeTime);
        if (remaining > 0) return { allowed: false, reason: `${symbol} post-close cooldown (${Math.ceil(remaining / 60000)}m remaining)` };
      }

      if (this.circuitBreakerTriggered) {
        this.circuitBreakerTriggered = false;
        this.emitter.emitStatus(this.isRunning, false);
      }
      return { allowed: true };
    } catch (err: any) {
      return { allowed: false, reason: `Risk validation unavailable: ${err.message}` };
    }
  }

  public async checkCircuitBreaker() {
    if (!this.isRunning) return;
    try {
      const snapshot = await this.getDailyRiskSnapshot();
      const limit = -Math.abs(this.settings.maxLossUsdt || 50);
      const triggered = snapshot.net <= limit;
      if (triggered !== this.circuitBreakerTriggered) {
        this.circuitBreakerTriggered = triggered;
        this.emitter.emitStatus(this.isRunning, triggered);
        if (triggered) {
          this.emitter.log(`🚨 [DAILY ENTRY BREAKER] Net daily PnL $${snapshot.net.toFixed(2)} reached $${limit.toFixed(2)}. New entries blocked; existing positions remain managed.`);
          this.telegram.send(`🚨 <b>DAILY ENTRY BREAKER</b>\nNet daily PnL: <b>$${snapshot.net.toFixed(2)}</b>. New entries are blocked; open positions continue to be managed.`);
        } else {
          this.emitter.log("✅ [DAILY ENTRY BREAKER] Risk condition cleared; new entries may resume if all other rules pass.");
        }
      }
    } catch {
      // Fail closed happens in canOpenSymbol. Avoid noisy background errors here.
    }
  }

  public async syncPositions() {
    try {
      const previousSymbols = new Set(this.activePositions.filter((p) => Number(p.size || 0) > 0).map((p) => p.symbol));
      const positions = await this.riskManager.getOpenPositions();
      const currentSymbols = new Set(positions.map((p) => p.symbol));

      for (const symbol of previousSymbols) {
        if (!currentSymbols.has(symbol)) await this.recordLatestClosedTrade(symbol);
      }

      this.activePositions = positions;
      for (const pos of positions) {
        const price = Number(pos.markPrice || pos.avgPrice || 0);
        if (!this.positionState[pos.symbol] && price > 0) this.positionState[pos.symbol] = { peakPrice: price, breakEvenSet: false };
      }
      for (const symbol of Object.keys(this.positionState)) if (!currentSymbols.has(symbol)) delete this.positionState[symbol];
      this.emitter.updatePositions(positions);
      await this.checkCircuitBreaker();
    } catch {
      // Keep the engine alive; entry checks fail closed if risk data cannot be fetched.
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
      const trade = { id, symbol, side, entryPrice, exitPrice, qty, reason: "Bybit Closed PnL", pnl, pnlPercent, time };
      this.tradeHistory.unshift(trade);
      this.emitter.tradeUpdate(trade);
      this.telegram.sendTradeClosed(symbol, exitPrice, "Bybit Closed PnL", pnl, pnlPercent);
      dbRecordTrade({
        symbol,
        side,
        entryPrice,
        exitPrice,
        status: "CLOSED",
        exitReason: "Bybit Closed PnL",
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

  private async validatePreOrder(symbol: string, side: "Buy" | "Sell", notionalSizeUsdt: number): Promise<{ valid: boolean; qty: string; price: number; reason?: string }> {
    const risk = await this.canOpenSymbol(symbol);
    if (!risk.allowed) return { valid: false, qty: "0", price: 0, reason: risk.reason };

    try {
      const walletRes = await this.bybit.getWalletBalance({ accountType: "UNIFIED", coin: "USDT" });
      const coin = walletRes.result?.list?.[0]?.coin?.[0];
      if (coin) {
        const available = Number(coin.availableToWithdraw || 0);
        const required = notionalSizeUsdt / (this.settings.leverage || 10);
        if (available < required) return { valid: false, qty: "0", price: 0, reason: `Available margin $${available.toFixed(2)} < required $${required.toFixed(2)}` };
      }

      const orderbook = await this.bybit.getOrderbook({ category: "linear", symbol, limit: 1 });
      if (orderbook.retCode !== 0 || !orderbook.result?.b?.length || !orderbook.result?.a?.length) return { valid: false, qty: "0", price: 0, reason: "Orderbook unavailable" };
      const bid = Number(orderbook.result.b[0][0]);
      const ask = Number(orderbook.result.a[0][0]);
      const mid = (bid + ask) / 2;
      const spread = mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(spread) || spread > 0.08) return { valid: false, qty: "0", price: side === "Buy" ? ask : bid, reason: `Spread ${spread.toFixed(3)}% exceeds 0.08%` };

      const instrumentRes = await this.bybit.getInstrumentsInfo({ category: "linear", symbol });
      const instrument: any = instrumentRes.result?.list?.[0];
      if (instrumentRes.retCode !== 0 || !instrument) return { valid: false, qty: "0", price: side === "Buy" ? ask : bid, reason: "Instrument info unavailable" };
      const minQty = Number(instrument.lotSizeFilter.minOrderQty);
      const qtyStep = Number(instrument.lotSizeFilter.qtyStep);
      const executionPrice = side === "Buy" ? ask : bid;
      const rawQty = notionalSizeUsdt / executionPrice;
      const precision = String(instrument.lotSizeFilter.qtyStep).split(".")[1]?.length || 0;
      const qtyNum = Math.max(minQty, Math.floor(rawQty / qtyStep) * qtyStep);
      return { valid: true, qty: qtyNum.toFixed(precision), price: executionPrice };
    } catch (err: any) {
      return { valid: false, qty: "0", price: 0, reason: `Pre-order validation error: ${err.message}` };
    }
  }

  public async executeScannerEntry(
    symbol: string,
    side: "Buy" | "Sell",
    currentPrice: number,
    ema50: number,
    ema200: number,
    rsi: number
  ): Promise<{ success: boolean; message: string; orderId?: string }> {
    const targetSymbol = symbol.toUpperCase();
    if (this.isProcessingTrade[targetSymbol]) return { success: false, message: `Trade already in progress for ${targetSymbol}` };
    this.isProcessingTrade[targetSymbol] = true;

    try {
      const notional = this.settings.positionMarginUsdt * this.settings.leverage;
      const pre = await this.validatePreOrder(targetSymbol, side, notional);
      if (!pre.valid) return { success: false, message: pre.reason || "Risk validation failed" };
      currentPrice = pre.price;
      const { takeProfit, stopLoss } = this.riskManager.calculateBrackets(currentPrice, this.settings.tpPercent, this.settings.slPercent, side);
      await this.ensureLeverage(targetSymbol);

      this.emitter.log(`⚡ [Scanner Execution] ${side === "Buy" ? "LONG" : "SHORT"} ${targetSymbol} | Margin $${this.settings.positionMarginUsdt} | Notional ~$${notional} | TP ${takeProfit} | SL ${stopLoss}`);
      const orderRes = await this.bybit.submitOrder({
        category: "linear",
        symbol: targetSymbol,
        side,
        orderType: "Market",
        qty: pre.qty,
        timeInForce: "IOC",
        takeProfit,
        stopLoss,
      });
      if (orderRes.retCode !== 0) return { success: false, message: orderRes.retMsg || "Bybit rejected scanner order" };

      const orderId = orderRes.result?.orderId || `scan-${Date.now()}`;
      const position = { symbol: targetSymbol, side, size: pre.qty, avgPrice: String(currentPrice), markPrice: String(currentPrice) };
      this.activePositions.push(position);
      this.positionState[targetSymbol] = { peakPrice: currentPrice, breakEvenSet: false };
      this.emitter.updatePositions(this.activePositions);
      this.telegram.sendTradeExecution(targetSymbol, side === "Buy" ? "Long (Strict Scanner)" : "Short (Strict Scanner)", currentPrice, pre.qty, takeProfit, stopLoss);
      dbRecordTrade({
        symbol: targetSymbol,
        side,
        entryPrice: currentPrice,
        status: "OPEN",
        sizeNotional: notional,
        marginUsed: this.settings.positionMarginUsdt,
        leverage: this.settings.leverage,
      });
      if (!this.watchlist.includes(targetSymbol)) void this.addSymbol(targetSymbol);
      setTimeout(() => void this.syncPositions(), 800);
      return { success: true, message: `${side === "Buy" ? "Long" : "Short"} entry placed for ${targetSymbol}`, orderId };
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

    if (pnlPercent >= 1 && !state.breakEvenSet) {
      try {
        await this.bybit.setTradingStop({ category: "linear", symbol, stopLoss: String(entry), slTriggerBy: "LastPrice", positionIdx: 0 });
        state.breakEvenSet = true;
        this.emitter.log(`[${symbol}] +1.0% reached; SL moved to break-even.`);
      } catch (err: any) {
        this.emitter.log(`[${symbol}] Break-even update warning: ${err.message}`);
      }
    }

    if (pnlPercent < 1) return;
    const trailing = isLong
      ? state.peakPrice * (1 - this.settings.trailingStopPercent / 100)
      : state.peakPrice * (1 + this.settings.trailingStopPercent / 100);
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
      });
      if (closeRes.retCode === 0) {
        this.emitter.log(`[${symbol}] Trailing stop exit submitted.`);
        this.activePositions = this.activePositions.filter((p) => p.symbol !== symbol);
        delete this.positionState[symbol];
        this.emitter.updatePositions(this.activePositions);
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
    this.emitter.log("[Settings] Strict risk caps enforced: $50 margin, 3 slots, -$50 daily breaker.");
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

  public resetCircuitBreaker() {
    this.circuitBreakerTriggered = false;
    this.emitter.emitStatus(this.isRunning, false);
    this.emitter.log("✅ Circuit-breaker display reset. Entry risk is re-validated before every order.");
  }

  public start() {
    if (this.isRunning) return false;
    this.isRunning = true;
    this.emitter.emitStatus(true, this.circuitBreakerTriggered);
    this.telegram.sendBotStatus(true);
    this.emitter.log(`🚀 [Bot Started] Strict mode: max ${this.settings.maxPositions} positions, $${this.settings.positionMarginUsdt} margin each, 10m symbol cooldown, -$${this.settings.maxLossUsdt} daily entry breaker.`);
    void this.syncPositions();
    return true;
  }

  public stop() {
    if (!this.isRunning) return false;
    this.isRunning = false;
    this.emitter.emitStatus(false, this.circuitBreakerTriggered);
    this.telegram.sendBotStatus(false);
    this.emitter.log("🛑 [Bot Stopped] New entries and active management paused.");
    return true;
  }

  public async manualClosePosition(symbol: string): Promise<{ success: boolean; message: string }> {
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
      });
      if (result.retCode !== 0) return { success: false, message: result.retMsg || "Bybit rejected close" };
      this.activePositions = this.activePositions.filter((p) => p.symbol !== target);
      delete this.positionState[target];
      this.emitter.updatePositions(this.activePositions);
      setTimeout(() => void this.syncPositions(), 500);
      return { success: true, message: `Successfully closed ${target}.` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  public async closeAllPositions(): Promise<{ success: boolean; closedCount: number; results: any[] }> {
    const results: any[] = [];
    let closedCount = 0;
    try {
      const positions = await this.riskManager.getOpenPositions();
      for (const pos of positions) {
        try {
          const result = await this.bybit.submitOrder({
            category: "linear",
            symbol: pos.symbol,
            side: pos.side === "Buy" ? "Sell" : "Buy",
            orderType: "Market",
            qty: String(pos.size),
            reduceOnly: true,
            timeInForce: "IOC",
          });
          const success = result.retCode === 0;
          if (success) closedCount++;
          results.push({ symbol: pos.symbol, success, orderId: result.result?.orderId, error: success ? undefined : result.retMsg });
        } catch (err: any) {
          results.push({ symbol: pos.symbol, success: false, error: err.message });
        }
      }
      setTimeout(() => void this.syncPositions(), 800);
      return { success: true, closedCount, results };
    } catch (err: any) {
      return { success: false, closedCount, results: [{ error: err.message }] };
    }
  }

  public async executeManualTestOrder(symbol: string = "BTCUSDT", customQty?: string): Promise<{ success: boolean; message: string; orderId?: string }> {
    const target = symbol.toUpperCase();
    const notional = this.settings.positionMarginUsdt * this.settings.leverage;
    const pre = await this.validatePreOrder(target, "Buy", notional);
    if (!pre.valid) return { success: false, message: pre.reason || "Risk validation failed" };
    const qty = customQty || pre.qty;
    const { takeProfit, stopLoss } = this.riskManager.calculateBrackets(pre.price, this.settings.tpPercent, this.settings.slPercent, "Buy");
    try {
      await this.ensureLeverage(target);
      const result = await this.bybit.submitOrder({
        category: "linear", symbol: target, side: "Buy", orderType: "Market", qty,
        timeInForce: "IOC", takeProfit, stopLoss,
      });
      if (result.retCode !== 0) return { success: false, message: result.retMsg || "Bybit rejected test order" };
      const orderId = result.result?.orderId || `test-${Date.now()}`;
      this.activePositions.push({ symbol: target, side: "Buy", size: qty, avgPrice: String(pre.price), markPrice: String(pre.price) });
      this.positionState[target] = { peakPrice: pre.price, breakEvenSet: false };
      this.emitter.updatePositions(this.activePositions);
      dbRecordTrade({ symbol: target, side: "Buy", entryPrice: pre.price, status: "OPEN", sizeNotional: notional, marginUsed: this.settings.positionMarginUsdt, leverage: this.settings.leverage });
      setTimeout(() => void this.syncPositions(), 800);
      return { success: true, message: `Test long placed for ${target}`, orderId };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  public shutdown() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.stop();
    this.wsManager.close();
  }
}
