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

  log(message: string) {
    this.io.emit("log", message);
  }

  updatePrices(prices: Record<string, number>) {
    this.pendingPrices = { ...this.pendingPrices, ...prices };
    const now = Date.now();
    if (now - this.lastPriceEmit >= 1000) {
      this.flushPrices();
    } else if (!this.priceEmitTimer) {
      this.priceEmitTimer = setTimeout(() => {
        this.flushPrices();
      }, 1000 - (now - this.lastPriceEmit));
    }
  }

  private flushPrices() {
    this.lastPriceEmit = Date.now();
    if (this.priceEmitTimer) {
      clearTimeout(this.priceEmitTimer);
      this.priceEmitTimer = null;
    }
    this.io.emit("price-update", this.pendingPrices);
    this.io.emit("ticker:update", this.pendingPrices);
  }

  updateWatchlist(watchlist: string[]) {
    this.io.emit("watchlist-update", watchlist);
  }

  updatePositions(positions: any[]) {
    this.io.emit("positions-update", positions);
    this.io.emit("position:update", positions);
  }

  updateBalance(balance: string) {
    this.io.emit("balance-update", { balance });
    this.io.emit("wallet:update", { balance });
  }

  tradeUpdate(trade: any) {
    this.io.emit("trade-update", trade);
    this.io.emit("execution:update", trade);
  }

  updateKline(payload: { symbol: string; candle: any; ema9?: any; ema21?: any }) {
    this.io.emit("kline-update", payload);
    this.io.emit("kline:update", payload);
  }

  updateScanner(scannerState: any) {
    this.io.emit("scanner-update", scannerState);
    this.io.emit("scanner:update", scannerState);
  }

  updateTechnicals(technicals: Record<string, any>) {
    this.pendingTechnicals = { ...this.pendingTechnicals, ...technicals };
    const now = Date.now();
    if (now - this.lastTechEmit >= 1000) {
      this.flushTechnicals();
    } else if (!this.techEmitTimer) {
      this.techEmitTimer = setTimeout(() => {
        this.flushTechnicals();
      }, 1000 - (now - this.lastTechEmit));
    }
  }

  private flushTechnicals() {
    this.lastTechEmit = Date.now();
    if (this.techEmitTimer) {
      clearTimeout(this.techEmitTimer);
      this.techEmitTimer = null;
    }
    this.io.emit("technicals-update", this.pendingTechnicals);
  }

  emitStatus(running: boolean, circuitBreaker: boolean = false) {
    this.io.emit('bot-status', { running, circuitBreaker });
  }
}

export class RiskManager {
  constructor(private bybit: RestClientV5, private emitter: WebSocketEmitter) {}

  async getOpenPositions(): Promise<any[]> {
    try {
      const positionRes = await this.bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
      const positions = positionRes.result?.list || [];
      return positions.filter((p: any) => parseFloat(p.size) > 0);
    } catch (err: any) {
      this.emitter.log(`[RiskManager] Error fetching positions: ${err.message}`);
      return [];
    }
  }

  calculateBrackets(price: number, tpPercent: number, slPercent: number) {
    const takeProfit = (price * (1 + tpPercent / 100)).toFixed(2);
    const stopLoss = (price * (1 - slPercent / 100)).toFixed(2);
    return { takeProfit, stopLoss };
  }
}

export class TradingEngine {
  private isRunning = false;
  public circuitBreakerTriggered: boolean = false;
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
  public currentBalance: string = "0";

  public settings = {
    leverage: 10,
    positionMarginUsdt: 100,
    maxPositions: 5,
    tpPercent: 2.5,
    slPercent: 1.0,
    trailingStopPercent: 0.5,
    maxLossUsdt: 100,
    globalMaxLossUsdt: -100,
  };

  private positionState: Record<string, { peakPrice: number; breakEvenSet: boolean }> = {};
  private isProcessingTrade: Record<string, boolean> = {};
  private lastCheckLogTime: Record<string, number> = {};
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private bybit: RestClientV5,
    io: SocketIOServer,
    apiKey?: string,
    apiSecret?: string
  ) {
    this.emitter = new WebSocketEmitter(io);
    this.riskManager = new RiskManager(bybit, this.emitter);
    this.telegram = new TelegramNotifier();

    // Initialize high-performance Bybit V5 WebSocket Manager
    this.wsManager = new BybitWebSocketManager(
      bybit,
      apiKey || process.env.BYBIT_API_KEY,
      apiSecret || process.env.BYBIT_API_SECRET,
      process.env.BYBIT_DEMO === 'true' // UTA Demo Trading
    );

    // Initialize Dynamic Market Scanner Engine
    this.scanner = new MarketScanner(bybit, this.emitter, this.telegram, this);

    this.setupWebSocketHandlers();
    this.init();
  }

  private async ensureLeverage(symbol: string) {
    try {
      await this.bybit.setLeverage({
        category: "linear",
        symbol,
        buyLeverage: this.settings.leverage.toString(),
        sellLeverage: this.settings.leverage.toString(),
      });
      this.emitter.log(`[${symbol}] Leverage enforced to ${this.settings.leverage}x`);
    } catch (e: any) {
      if (!e.message?.toLowerCase().includes("not modified")) {
        this.emitter.log(`[${symbol}] Could not enforce leverage: ${e.message}`);
      }
    }
  }

  private async init() {
    this.emitter.log("[TradingEngine] Initializing real-time V5 1m-WebSocket pipelines...");
    await this.wsManager.init(this.watchlist);
    
    // Initial fetch of active positions to sync state
    await this.syncPositions();

    // Initialize Dynamic Market Scanner
    await this.scanner.init();

    // Auto-start engine on server load by default
    this.start();

    // Start background sync every 5 seconds to guarantee 100% position reconciliation
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      this.syncPositions();
    }, 5000);
  }

  private setupWebSocketHandlers() {
    // 1. Logs from WS
    this.wsManager.on("log", (msg: string) => {
      this.emitter.log(msg);
    });

    // 2. Real-time Kline updates (candle ticks & closes)
    this.wsManager.on("kline", (payload: KlineEventPayload) => {
      const { symbol, candle, technicals, isConfirmed } = payload;

      // Update cached technicals
      this.currentTechnicals[symbol] = {
        ema9: technicals.ema9,
        ema21: technicals.ema21,
        rsi: technicals.rsi,
        timestamp: Date.now(),
      };

      // Relay to frontend and charts
      this.emitter.updateKline({
        symbol,
        candle,
        ema9: { time: candle.time, value: Number(technicals.ema9.toFixed(4)) },
        ema21: { time: candle.time, value: Number(technicals.ema21.toFixed(4)) },
      });
      this.emitter.updateTechnicals(this.currentTechnicals);

      // When bot is active, evaluate strategy signals on 1m candle events
      if (this.isRunning) {
        this.evaluateStrategySignal(symbol, candle.close, technicals, isConfirmed);
      }
    });

    // 3. Real-time Ticker / Mark price updates
    this.wsManager.on("ticker", (payload: TickerEventPayload) => {
      const { symbol, price } = payload;
      this.currentPrices[symbol] = price;

      // Relay live ticker prices to frontend (throttled to max 1/sec)
      this.emitter.updatePrices(this.currentPrices);

      // Event-driven Trailing Stop and Break-Even check
      if (this.isRunning) {
        this.checkTrailingStopAndBreakEven(symbol, price);
      }
    });

    // 4. Real-time Private Position updates
    this.wsManager.on("position", (positions: any[]) => {
      const open = positions.filter((p) => parseFloat(p.size) > 0);
      
      // Reconcile closed positions immediately
      for (const sym of Object.keys(this.positionState)) {
        const stillOpen = open.find((p) => p.symbol === sym);
        if (!stillOpen) {
          this.emitter.log(`[${sym}] Position closed on exchange. Active state cleared.`);
          delete this.positionState[sym];
        }
      }

      this.activePositions = open;
      this.emitter.updatePositions(open);
    });

    // 5. Real-time Private Execution updates
    this.wsManager.on("execution", (exec: any) => {
      if (exec.execType === "Trade" || exec.execType === "Bust") {
        this.emitter.log(`[Bybit WS Private] Order Fill: ${exec.symbol} ${exec.side} ${exec.execQty} @ $${exec.execPrice}`);
        
        this.emitter.tradeUpdate({
          id: exec.execId || exec.orderId,
          symbol: exec.symbol,
          side: exec.side,
          price: parseFloat(exec.execPrice),
          qty: exec.execQty,
          time: parseInt(exec.execTime, 10) || Date.now(),
        });
      }
    });

    // 6. Real-time Private Wallet updates
    this.wsManager.on("wallet", (walletBalance: string) => {
      this.currentBalance = walletBalance;
      this.emitter.updateBalance(walletBalance);
      this.emitter.log(`[Bybit WS Private] Wallet balance updated: $${walletBalance} USDT`);
    });
  }

  public async syncPositions() {
    try {
      const positions = await this.riskManager.getOpenPositions();
      
      // Check for closed positions compared to previous state
      for (const sym of Object.keys(this.positionState)) {
        const stillOpen = positions.find((p) => p.symbol === sym);
        if (!stillOpen) {
          delete this.positionState[sym];
          this.emitter.log(`[${sym}] Position closed on exchange (TP/SL/Exit). Local slot freed.`);
          
          try {
            const closedPnlRes = await this.bybit.getClosedPnL({ category: "linear", symbol: sym, limit: 1 });
            if (closedPnlRes.retCode === 0 && closedPnlRes.result?.list?.length > 0) {
              const closedData = closedPnlRes.result.list[0];
              const pnl = parseFloat(closedData.closedPnl);
              const exitPrice = parseFloat(closedData.avgExitPrice);
              const entryPrice = parseFloat(closedData.avgEntryPrice);
              const qty = parseFloat(closedData.qty);
              const pnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 * (closedData.side === "Sell" ? 1 : -1) : 0;
              
              // Determine reason based on PnL vs TP/SL logic or API fields
              let reason = "Manual Close / Exchange";
              if (pnlPercent >= this.settings.tpPercent * 0.9) reason = `Take Profit (+${pnlPercent.toFixed(2)}%)`;
              else if (pnlPercent <= -this.settings.slPercent * 0.9) reason = `Hard SL (${pnlPercent.toFixed(2)}%)`;
              else if (pnlPercent > 0) reason = `Trailing Stop / TP`;
              
              const closedTrade = {
                id: closedData.orderId || `closed-${Date.now()}`,
                symbol: sym,
                side: closedData.side === "Sell" ? "Buy" : "Sell", // side returned is closing order side
                entryPrice,
                exitPrice,
                qty,
                reason,
                pnl,
                pnlPercent,
                time: Date.now(),
              };
              
              // Ensure we don't add duplicate
              if (!this.tradeHistory.find(t => t.id === closedTrade.id)) {
                this.tradeHistory.unshift(closedTrade);
                this.emitter.tradeUpdate(closedTrade);
                this.telegram.sendTradeClosed(sym, exitPrice, reason, pnl, pnlPercent);
                dbRecordTrade({ symbol: sym, side: closedData.side === "Sell" ? "Sell" : "Buy", entryPrice, exitPrice, status: "CLOSED", exitReason: reason, realizedPnl: pnl, closedAt: closedTrade.time, sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });
              }
            }
          } catch (e) {
            this.emitter.log(`[${sym}] Could not fetch closed PnL details: ${e}`);
          }
        }
      }

      this.activePositions = positions;
      this.emitter.updatePositions(positions);

      // Evaluate Circuit Breaker Net PnL threshold
      await this.checkCircuitBreaker();
    } catch (err: any) {
      // Avoid spamming logs if network error
    }
  }

  /**
   * Global Max Loss / Circuit Breaker check
   * When Net Realized + Floating PnL drops to or below -$maxLossUsdt, auto-halt bot and panic close all trades.
   */
  public async checkCircuitBreaker() {
    if (!this.isRunning) return;

    // Calculate floating unrealized PnL from active positions
    const totalUnrealizedPnl = this.activePositions.reduce((acc, pos) => {
      const pnl = parseFloat(pos.unrealisedPnl || "0");
      return acc + (isNaN(pnl) ? 0 : pnl);
    }, 0);

    // Calculate realized PnL from today's trade history (00:00 UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const totalRealizedPnl = this.tradeHistory.reduce((acc, trade) => {
      if (trade.pnl !== undefined && trade.time && trade.time >= todayStart.getTime()) {
        const pnl = parseFloat(trade.pnl);
        return acc + (isNaN(pnl) ? 0 : pnl);
      }
      return acc;
    }, 0);

    const netPnl = totalRealizedPnl + totalUnrealizedPnl;
    const maxLossThreshold = -Math.abs(this.settings.maxLossUsdt || 100);

    if (netPnl <= maxLossThreshold) {
      this.emitter.log(
        `🚨 [CIRCUIT BREAKER TRIGGERED] Net PnL is $${netPnl.toFixed(2)} USDT (Limit: $${maxLossThreshold} USDT). Halting bot and closing all positions immediately!`
      );
      this.telegram.send(
        `🚨 <b>CIRCUIT BREAKER ACTIVATED</b>\nNet PnL dropped to <b>$${netPnl.toFixed(2)} USDT</b> (Limit: -$${Math.abs(maxLossThreshold)} USDT).\nBot engine auto-halted and all active trades closed.`
      );

      this.circuitBreakerTriggered = true;
      this.emitter.log('🔒 [Bot Locked] Status set to CIRCUIT_BREAKER_TRIGGERED. Manual reset required to trade again.');
      this.stop();
      this.emitter.emitStatus(false, true);

      // Emergency panic close all open positions
      await this.closeAllPositions();
    }
  }

  public updateSettings(newSettings: Partial<typeof this.settings>) {
    this.settings = { ...this.settings, ...newSettings };
    this.emitter.log("[Settings] Engine parameters updated.");
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
    delete this.currentPrices[symbol];
    delete this.currentTechnicals[symbol];
    delete this.positionState[symbol];

    this.emitter.updateWatchlist(this.watchlist);
    this.emitter.updatePrices(this.currentPrices);
    this.wsManager.removeSymbol(formatted);
  }

  public resetCircuitBreaker() {
    this.circuitBreakerTriggered = false;
    this.emitter.log('✅ Circuit Breaker manually reset. Bot unlocked.');
    this.emitter.emitStatus(this.isRunning, false);
  }

  public getIsRunning() {
    return this.isRunning;
  }


  private async validatePreOrder(symbol: string, notionalSizeUsdt: number = 1000): Promise<{ valid: boolean, qty: string, price: number, reason?: string }> {
    try {
      // 1. Available Margin Check
      const walletRes = await this.bybit.getWalletBalance({ accountType: "UNIFIED", coin: "USDT" });
      if (walletRes.retCode === 0 && walletRes.result.list.length > 0 && walletRes.result.list[0].coin.length > 0) {
        const availableBal = parseFloat(walletRes.result.list[0].coin[0].availableToWithdraw || "0");
        const requiredMargin = notionalSizeUsdt / (this.settings.leverage || 10);
        if (availableBal < requiredMargin) {
          return { valid: false, qty: "0", price: 0, reason: `Available Margin (${availableBal.toFixed(2)}) < Required (${requiredMargin.toFixed(2)})` };
        }
      }

      // 2. Gate 3 Slippage Guard: Orderbook Spread
      const orderbook = await this.bybit.getOrderbook({ category: "linear", symbol, limit: 1 });
      if (orderbook.retCode !== 0 || !orderbook.result.b.length || !orderbook.result.a.length) {
        return { valid: false, qty: "0", price: 0, reason: "Failed to fetch orderbook or low liquidity" };
      }
      const bid = parseFloat(orderbook.result.b[0][0]);
      const ask = parseFloat(orderbook.result.a[0][0]);
      const spreadPercent = ((ask - bid) / ask) * 100;
      if (spreadPercent > 0.15) {
        return { valid: false, qty: "0", price: ask, reason: `Execution Aborted: Spread expanded beyond 0.15% (${spreadPercent.toFixed(3)}%)` };
      }

      // 3. Lot Size Normalization
      const instrumentRes = await this.bybit.getInstrumentsInfo({ category: "linear", symbol });
      if (instrumentRes.retCode !== 0 || !instrumentRes.result.list.length) {
        return { valid: false, qty: "0", price: ask, reason: "Failed to fetch instrument info" };
      }
      const instrument = instrumentRes.result.list[0];
      const minOrderQty = parseFloat(instrument.lotSizeFilter.minOrderQty);
      const qtyStep = parseFloat(instrument.lotSizeFilter.qtyStep);
      
      let rawQty = notionalSizeUsdt / ask;
      const precision = qtyStep.toString().split('.')[1]?.length || 0;
      let qtyNum = Math.floor(rawQty / qtyStep) * qtyStep;
      if (qtyNum < minOrderQty) {
          qtyNum = minOrderQty;
      }
      const qty = qtyNum.toFixed(precision);

      return { valid: true, qty, price: ask };
    } catch (err: any) {
      return { valid: false, qty: "0", price: 0, reason: `Pre-order validation error: ${err.message}` };
    }
  }

  public getHistory() {
    return this.tradeHistory;
  }

  public getTechnicals() {
    return this.currentTechnicals;
  }

  public testTelegram() {
    this.telegram.send("🔔 <b>Test Notification</b>\nBybit V5 WebSocket-driven trading pipeline is active!");
  }

  public start() {
    if (this.circuitBreakerTriggered) {
      this.emitter.log('❌ Cannot start bot: CIRCUIT_BREAKER_TRIGGERED. Please reset risk limits.');
      return false;
    }
    if (this.isRunning) return false;
    this.isRunning = true;
    this.emitter.emitStatus(true, this.circuitBreakerTriggered);
    this.telegram.sendBotStatus(true);
    this.emitter.log(`🚀 [Bot Started] Active concurrency enabled (Up to ${this.settings.maxPositions || 5} concurrent positions, ${this.settings.leverage || 10}x leverage). Monitoring 1m streams...`);
    this.syncPositions();
    return true;
  }

  public stop() {
    if (!this.isRunning) return false;
    this.isRunning = false;
    this.emitter.emitStatus(false, this.circuitBreakerTriggered);
    this.telegram.sendBotStatus(false);
    this.emitter.log("🛑 [Bot Stopped] Strategy execution paused.");
    return true;
  }

  /**
   * Manual Market Exit for any active position
   */
  public async manualClosePosition(symbol: string): Promise<{ success: boolean; message: string }> {
    const targetSymbol = symbol.toUpperCase();
    const pos = this.activePositions.find((p) => p.symbol === targetSymbol);

    if (!pos || parseFloat(pos.size) <= 0) {
      return { success: false, message: `No active position found for ${targetSymbol}` };
    }

    this.emitter.log(`[Manual Close] Executing Market Exit for ${targetSymbol} (${pos.size} contracts)...`);

    try {
      const closeRes = await this.bybit.submitOrder({
        category: "linear",
        symbol: targetSymbol,
        side: pos.side === "Buy" ? "Sell" : "Buy",
        orderType: "Market",
        qty: pos.size,
        reduceOnly: true,
        timeInForce: "IOC",
      });

      if (closeRes.retCode === 0) {
        const currentPrice = this.currentPrices[targetSymbol] || parseFloat(pos.avgPrice);
        const entryPrice = parseFloat(pos.avgPrice);
        const isLong = pos.side === "Buy";
        const realizedPnl = (currentPrice - entryPrice) * parseFloat(pos.size) * (isLong ? 1 : -1);
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);

        this.emitter.log(`[${targetSymbol}] Manual Market Exit filled successfully! Order ID: ${closeRes.result?.orderId}`);

        const tradeRecord = {
          id: closeRes.result?.orderId || `manual-${Date.now()}`,
          symbol: targetSymbol,
          side: pos.side,
          entryPrice,
          exitPrice: currentPrice,
          qty: pos.size,
          reason: "Manual Market Exit",
          pnl: realizedPnl,
          pnlPercent,
          time: Date.now(),
        };

        this.tradeHistory.unshift(tradeRecord);
        this.emitter.tradeUpdate(tradeRecord);
        this.telegram.sendTradeClosed(targetSymbol, currentPrice, "Manual Exit", realizedPnl, pnlPercent);
        dbRecordTrade({ symbol: targetSymbol, side: "Buy", entryPrice: parseFloat(pos.avgPrice || currentPrice.toString()), exitPrice: currentPrice, status: "CLOSED", exitReason: "Manual Exit", realizedPnl, closedAt: Date.now(), sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });

        delete this.positionState[targetSymbol];
        this.activePositions = this.activePositions.filter((p) => p.symbol !== targetSymbol);
        this.emitter.updatePositions(this.activePositions);

        // Immediate background sync
        setTimeout(() => this.syncPositions(), 500);

        return { success: true, message: `Successfully closed ${targetSymbol} position.` };
      } else {
        this.emitter.log(`[${targetSymbol}] Manual Close failed: ${closeRes.retMsg}`);
        return { success: false, message: closeRes.retMsg || "Bybit rejected close order" };
      }
    } catch (err: any) {
      this.emitter.log(`[${targetSymbol}] Manual Close exception: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * Emergency Panic Button: Close all active positions immediately at market price
   */
  public async closeAllPositions(): Promise<{ success: boolean; closedCount: number; results: any[] }> {
    this.emitter.log("🚨 [EMERGENCY PANIC CLOSE-ALL] Closing all active positions immediately...");
    const results: any[] = [];
    let closedCount = 0;

    // Fetch freshest positions from Bybit
    try {
      const posRes = await this.bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
      const rawList = posRes.result?.list || [];
      const activeList = rawList.filter((p: any) => parseFloat(p.size) > 0);

      if (activeList.length === 0) {
        this.emitter.log("ℹ️ [Panic Close] No open positions to close.");
        return { success: true, closedCount: 0, results: [] };
      }

      for (const pos of activeList) {
        const symbol = pos.symbol;
        const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
        try {
          const res = await this.bybit.submitOrder({
            category: "linear",
            symbol,
            side: closeSide,
            orderType: "Market",
            qty: pos.size,
            reduceOnly: true,
            timeInForce: "IOC",
          });

          if (res.retCode === 0) {
            closedCount++;
            this.emitter.log(`✅ [Panic Close] Successfully closed #${symbol} (${pos.size} contracts)`);
            results.push({ symbol, success: true, orderId: res.result?.orderId });
          } else {
            this.emitter.log(`❌ [Panic Close] Failed to close #${symbol}: ${res.retMsg}`);
            results.push({ symbol, success: false, error: res.retMsg });
          }
        } catch (err: any) {
          results.push({ symbol, success: false, error: err.message });
        }
      }

      this.activePositions = [];
      this.positionState = {};
      this.emitter.updatePositions([]);
      setTimeout(() => this.syncPositions(), 800);

      return { success: true, closedCount, results };
    } catch (err: any) {
      this.emitter.log(`❌ [Panic Close] Exception during close-all: ${err.message}`);
      return { success: false, closedCount, results: [{ error: err.message }] };
    }
  }

  /**
   * Manual Quick Test Long (Market Buy with active TP/SL brackets, bypassing indicators)
   */
  public async executeManualTestOrder(symbol: string = "BTCUSDT", customQty?: string): Promise<{ success: boolean; message: string; orderId?: string }> {
    const targetSymbol = symbol.toUpperCase();
    this.emitter.log(`⚡ [Manual Test Order] Initiating direct Market Buy for ${targetSymbol} (Bypassing indicators)...`);

    try {
      // 1. Get current market price
      let currentPrice = this.currentPrices[targetSymbol];
      if (!currentPrice || isNaN(currentPrice)) {
        const tickerRes = await this.bybit.getTickers({ category: "linear", symbol: targetSymbol });
        const tickerData = tickerRes.result?.list?.[0];
        if (tickerData?.lastPrice) {
          currentPrice = parseFloat(tickerData.lastPrice);
          this.currentPrices[targetSymbol] = currentPrice;
        }
      }

      if (!currentPrice || isNaN(currentPrice)) {
        currentPrice = targetSymbol.includes("BTC") ? 80000 : 2500;
      }

      const notionalSizeUsdt = (this.settings.positionMarginUsdt || 100) * (this.settings.leverage || 10);
      const preOrder = await this.validatePreOrder(targetSymbol, notionalSizeUsdt);
      
      if (!preOrder.valid) {
        this.emitter.log(`[Manual Test Order] ${preOrder.reason}`);
        return { success: false, message: preOrder.reason || "Validation failed" };
      }
      
      currentPrice = preOrder.price;
      const qty = customQty || preOrder.qty;

      // Calculate TP / SL brackets based on user risk settings
      const { takeProfit, stopLoss } = this.riskManager.calculateBrackets(
        currentPrice,
        this.settings.tpPercent,
        this.settings.slPercent
      );

      await this.ensureLeverage(targetSymbol);

      this.emitter.log(
        `⚡ [Manual Test Order] Submitting Bybit Linear Market Buy: ${qty} ${targetSymbol} @ ~${currentPrice.toFixed(2)} | TP: ${takeProfit} (+${this.settings.tpPercent}%) | SL: ${stopLoss} (-${this.settings.slPercent}%)...`
      );

      const orderRes = await this.bybit.submitOrder({
        category: "linear",
        symbol: targetSymbol,
        side: "Buy",
        orderType: "Market",
        qty,
        timeInForce: "IOC",
        takeProfit,
        stopLoss,
      });

      if (orderRes.retCode === 0) {
        const orderId = orderRes.result?.orderId || `test-${Date.now()}`;
        this.emitter.log(`✅ [Manual Test Order] Bybit Demo Order FILLED! Order ID: ${orderId}`);
        this.emitter.log(`🎯 [Manual Test Order] Active Brackets confirmed on Bybit: TP @ ${takeProfit} | SL @ ${stopLoss}`);

        const buyTrade = {
          id: orderId,
          type: "buy",
          symbol: targetSymbol,
          price: currentPrice,
          entryPrice: currentPrice,
          qty,
          takeProfit,
          stopLoss,
          reason: "Manual Test Over-ride",
          time: Date.now(),
        };

        this.telegram.sendTradeExecution(targetSymbol, "Long (Manual Test)", currentPrice, qty, takeProfit, stopLoss);
        dbRecordTrade({ symbol: targetSymbol, side: "Buy", entryPrice: currentPrice, status: "OPEN", sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });

        const existing = this.activePositions.find((p) => p.symbol === targetSymbol);
        if (!existing) {
          this.activePositions.push({
            symbol: targetSymbol,
            side: "Buy",
            size: qty,
            avgPrice: currentPrice.toString(),
            markPrice: currentPrice.toString(),
          });
        }
        this.positionState[targetSymbol] = { peakPrice: currentPrice, breakEvenSet: false };
        this.emitter.updatePositions(this.activePositions);

        setTimeout(() => this.syncPositions(), 800);

        return {
          success: true,
          message: `Successfully executed ${qty} ${targetSymbol} Market Buy on Bybit Demo! (Order ID: ${orderId})`,
          orderId,
        };
      } else {
        const errMsg = orderRes.retMsg || "Bybit rejected the test order";
        this.emitter.log(`❌ [Manual Test Order] Rejected by Bybit: ${errMsg} (Code: ${orderRes.retCode})`);
        return { success: false, message: errMsg };
      }
    } catch (err: any) {
      this.emitter.log(`❌ [Manual Test Order] Exception: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * Automated Execution of Confirmed Scanner Buy Signal
   */
  public async executeScannerEntry(
    symbol: string,
    price: number,
    ema9: number,
    ema21: number,
    rsi: number
  ): Promise<{ success: boolean; message: string; orderId?: string }> {
    if (!this.isRunning) {
      this.emitter.log(`[Scanner Auto-Execution] Execution skipped for ${symbol}: Bot engine is halted.`);
      return { success: false, message: "Bot engine is halted" };
    }
    const targetSymbol = symbol.toUpperCase();
    if (this.isProcessingTrade[targetSymbol]) {
      return { success: false, message: `Trade already in progress for ${targetSymbol}` };
    }

    this.isProcessingTrade[targetSymbol] = true;

    try {
      const { takeProfit, stopLoss } = this.riskManager.calculateBrackets(
        price,
        this.settings.tpPercent,
        this.settings.slPercent
      );

      // Smart position sizing based on Margin and Leverage (Notional = Margin * Leverage)
      const notionalSizeUsdt = (this.settings.positionMarginUsdt || 100) * (this.settings.leverage || 10);
      let qtyNum = notionalSizeUsdt / price;
      let qty = qtyNum.toFixed(3);
      if (price < 1) qty = Math.floor(qtyNum).toString();
      else if (price < 10) qty = Math.floor(qtyNum).toString();
      else if (price < 100) qty = qtyNum.toFixed(1);
      else if (price < 1000) qty = qtyNum.toFixed(2);
      else qty = qtyNum.toFixed(3);

      await this.ensureLeverage(targetSymbol);

      this.emitter.log(
        `⚡ [Scanner Auto-Execution] Submitting Market Buy: ${qty} ${targetSymbol} @ ~$${price.toFixed(2)} | TP: $${takeProfit} (+${this.settings.tpPercent}%) | SL: $${stopLoss} (-${this.settings.slPercent}%)`
      );

      const orderRes = await this.bybit.submitOrder({
        category: "linear",
        symbol: targetSymbol,
        side: "Buy",
        orderType: "Market",
        qty,
        timeInForce: "IOC",
        takeProfit,
        stopLoss,
      });

      if (orderRes.retCode === 0) {
        const orderId = orderRes.result?.orderId || `scan-${Date.now()}`;
        this.emitter.log(`✅ [Scanner Order FILLED] Bybit Demo Order ID: ${orderId}`);
        this.emitter.log(`🎯 [Scanner TP/SL Active] TP @ $${takeProfit} | SL @ $${stopLoss}`);

        const buyTrade = {
          id: orderId,
          type: "buy",
          symbol: targetSymbol,
          price,
          entryPrice: price,
          qty,
          takeProfit,
          stopLoss,
          reason: `Scanner Bullish Cross (RSI: ${rsi.toFixed(1)})`,
          time: Date.now(),
        };

        this.telegram.sendTradeExecution(targetSymbol, "Long (Scanner Auto)", price, qty, takeProfit, stopLoss);
        dbRecordTrade({ symbol: targetSymbol, side: "Buy", entryPrice: price, status: "OPEN", sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });

        // Update local active positions list if not present
        const existing = this.activePositions.find((p) => p.symbol === targetSymbol);
        if (!existing) {
          this.activePositions.push({
            symbol: targetSymbol,
            side: "Buy",
            size: qty,
            avgPrice: price.toString(),
            markPrice: price.toString(),
          });
        }
        this.positionState[targetSymbol] = { peakPrice: price, breakEvenSet: false };
        this.emitter.updatePositions(this.activePositions);

        // Add to watchlist and dynamic WS stream if not already monitored
        if (!this.watchlist.includes(targetSymbol)) {
          this.addSymbol(targetSymbol);
        }

        setTimeout(() => this.syncPositions(), 800);

        return {
          success: true,
          message: `Scanner successfully executed Market Buy on ${targetSymbol}!`,
          orderId,
        };
      } else {
        const errMsg = orderRes.retMsg || "Bybit rejected scanner order";
        this.emitter.log(`❌ [Scanner Entry] Rejected by Bybit: ${errMsg} (Code: ${orderRes.retCode})`);
        return { success: false, message: errMsg };
      }
    } catch (err: any) {
      this.emitter.log(`❌ [Scanner Entry] Exception: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      this.isProcessingTrade[targetSymbol] = false;
    }
  }

  /**
   * Event-driven Trailing Stop & Break-Even Evaluation on every price tick
   */
  private async checkTrailingStopAndBreakEven(symbol: string, currentPrice: number) {
    if (this.isProcessingTrade[symbol]) return;

    const pos = this.activePositions.find((p) => p.symbol === symbol && p.side === "Buy");
    if (!pos) return;

    const entryPrice = parseFloat(pos.avgPrice);
    if (!entryPrice || entryPrice <= 0) return;

    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (!this.positionState[symbol]) {
      this.positionState[symbol] = { peakPrice: currentPrice, breakEvenSet: false };
    }
    const state = this.positionState[symbol];

    // Track Peak Price
    if (currentPrice > state.peakPrice) {
      state.peakPrice = currentPrice;
    }

    // 1. Move SL to Break-Even at +1.0%
    if (pnlPercent >= 1.0 && !state.breakEvenSet) {
      this.emitter.log(`[${symbol}] +1.0% Profit hit! Moving SL to Break-Even ($${entryPrice}).`);
      try {
        await this.bybit.setTradingStop({
          category: "linear",
          symbol,
          stopLoss: entryPrice.toString(),
          slTriggerBy: "LastPrice",
          positionIdx: 0,
        });
        state.breakEvenSet = true;
      } catch (err: any) {
        this.emitter.log(`[${symbol}] Break-Even SL update error: ${err.message}`);
      }
    }

    // 2. Dynamic Trailing Stop calculation
    if (pnlPercent >= 1.0) {
      const dynamicSl = state.peakPrice * (1 - this.settings.trailingStopPercent / 100);
      if (currentPrice <= dynamicSl) {
        this.isProcessingTrade[symbol] = true;
        this.emitter.log(
          `[${symbol}] Trailing Stop triggered at $${currentPrice.toFixed(2)} (Peak: $${state.peakPrice.toFixed(2)}). Submitting IOC Market Close...`
        );

        try {
          const closeRes = await this.bybit.submitOrder({
            category: "linear",
            symbol,
            side: "Sell",
            orderType: "Market",
            qty: pos.size,
            reduceOnly: true,
            timeInForce: "IOC",
          });

          if (closeRes.retCode === 0) {
            const realizedPnl = (currentPrice - entryPrice) * parseFloat(pos.size);
            const closeTrade = {
              id: closeRes.result?.orderId || `ts-${Date.now()}`,
              symbol,
              side: pos.side,
              entryPrice,
              exitPrice: currentPrice,
              qty: pos.size,
              reason: "Trailing Stop",
              pnl: realizedPnl,
              pnlPercent,
              time: Date.now(),
            };

            this.tradeHistory.unshift(closeTrade);
            this.emitter.tradeUpdate(closeTrade);
            this.telegram.sendTradeClosed(symbol, currentPrice, "Trailing Stop", realizedPnl, pnlPercent);
            dbRecordTrade({ symbol, side: "Buy", entryPrice: parseFloat(pos.avgPrice || currentPrice.toString()), exitPrice: currentPrice, status: "CLOSED", exitReason: "Trailing Stop", realizedPnl, closedAt: Date.now(), sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });
            delete this.positionState[symbol];

            // Update in-memory positions list
            this.activePositions = this.activePositions.filter((p) => p.symbol !== symbol);
            this.emitter.updatePositions(this.activePositions);
            setTimeout(() => this.syncPositions(), 500);
          } else {
            this.emitter.log(`[${symbol}] Trailing Stop close error: ${closeRes.retMsg}`);
          }
        } catch (err: any) {
          this.emitter.log(`[${symbol}] Trailing Stop execution exception: ${err.message}`);
        } finally {
          this.isProcessingTrade[symbol] = false;
        }
      }
    }
  }

  /**
   * Event-driven Strategy Evaluation on live 1m Kline events
   */
  private async evaluateStrategySignal(
    symbol: string,
    currentPrice: number,
    technicals: KlineEventPayload["technicals"],
    isConfirmed: boolean
  ) {
    if (this.isProcessingTrade[symbol]) return;

    const { ema9, prevEma9, ema21, prevEma21, rsi, prevRsi } = technicals;

    const isBullishTrend = ema9 > ema21;
    const isBullishCross = prevEma9 <= prevEma21 && ema9 > ema21;
    const isBearishCross = prevEma9 >= prevEma21 && ema9 < ema21;
    const isRsiRecovering = prevRsi < 30 && rsi >= 30;

    const symbolPosition = this.activePositions.find((p) => p.symbol === symbol);

    // Diagnostic logging for condition check
    const now = Date.now();
    const lastLog = this.lastCheckLogTime[symbol] || 0;
    const shouldLogCondition = (now - lastLog >= 15000) || isConfirmed;

    let reasonStr = "";
    if (symbolPosition) {
      const entryP = parseFloat(symbolPosition.avgPrice);
      const pnlPct = ((currentPrice - entryP) / entryP) * 100;
      reasonStr = `Holding Active Position (PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
    } else if (!isBullishTrend && !isBullishCross && !isRsiRecovering) {
      reasonStr = `EMA9: $${ema9.toFixed(2)} < EMA21: $${ema21.toFixed(2)} -> Waiting for Bullish Cross`;
    } else if (rsi >= 65) {
      reasonStr = `RSI: ${rsi.toFixed(1)} (Overbought, needs <65) | EMA9: $${ema9.toFixed(2)} > EMA21: $${ema21.toFixed(2)} -> Waiting for RSI cooldown`;
    } else if (rsi < 30 && !isRsiRecovering) {
      reasonStr = `RSI: ${rsi.toFixed(1)} (Oversold) -> Waiting for RSI recovery >= 30`;
    } else {
      reasonStr = `Bullish Setup Confirmed (EMA9 > EMA21, RSI: ${rsi.toFixed(1)}) -> Ready for Entry`;
    }

    if (shouldLogCondition) {
      this.lastCheckLogTime[symbol] = now;
      this.emitter.log(`[${symbol} Check] RSI: ${rsi.toFixed(1)} (needs <65) | EMA9: $${ema9.toFixed(2)} vs EMA21: $${ema21.toFixed(2)} -> ${reasonStr}`);
    }

    let shouldBuy = false;
    let shouldSell = false;

    // Entry Criteria: Bullish EMA cross with RSI < 65 OR RSI recovery with EMA9 >= EMA21 OR Confirmed Bullish Trend with RSI in safe zone (30-65)
    if ((isBullishCross && rsi < 65) || (isRsiRecovering && ema9 >= ema21) || (isBullishTrend && rsi >= 35 && rsi < 62 && isConfirmed)) {
      shouldBuy = true;
    }

    // Exit Criteria: Bearish cross or overbought RSI
    if (isBearishCross || rsi > 75) {
      shouldSell = true;
    }

    // 1. Exit Signal on active position
    if (symbolPosition && shouldSell) {
      this.isProcessingTrade[symbol] = true;
      this.emitter.log(`[Strategy Exit] Exit signal triggered for ${symbol} @ $${currentPrice} (RSI: ${rsi.toFixed(1)}). Closing position...`);

      try {
        const closeRes = await this.bybit.submitOrder({
          category: "linear",
          symbol,
          side: symbolPosition.side === "Buy" ? "Sell" : "Buy",
          orderType: "Market",
          qty: symbolPosition.size,
          reduceOnly: true,
          timeInForce: "IOC",
        });

        if (closeRes.retCode === 0) {
          this.emitter.log(`[${symbol}] Strategy exit successful! Order ID: ${closeRes.result?.orderId}`);
          const entryPrice = parseFloat(symbolPosition.avgPrice);
          const realizedPnl =
            (currentPrice - entryPrice) *
            parseFloat(symbolPosition.size) *
            (symbolPosition.side === "Buy" ? 1 : -1);
          const pnlPercent =
            ((currentPrice - entryPrice) / entryPrice) *
            100 *
            (symbolPosition.side === "Buy" ? 1 : -1);

          const exitTrade = {
            id: closeRes.result?.orderId || `exit-${Date.now()}`,
            symbol,
            side: symbolPosition.side,
            entryPrice,
            exitPrice: currentPrice,
            qty: symbolPosition.size,
            reason: "Strategy Exit",
            pnl: realizedPnl,
            pnlPercent,
            time: Date.now(),
          };

          this.tradeHistory.unshift(exitTrade);
          this.emitter.tradeUpdate(exitTrade);
          this.telegram.sendTradeClosed(symbol, currentPrice, "Strategy Exit", realizedPnl, pnlPercent);
          dbRecordTrade({ symbol, side: "Buy", entryPrice: parseFloat(symbolPosition.avgPrice || currentPrice.toString()), exitPrice: currentPrice, status: "CLOSED", exitReason: "Strategy Exit", realizedPnl, closedAt: Date.now(), sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });
          delete this.positionState[symbol];

          this.activePositions = this.activePositions.filter((p) => p.symbol !== symbol);
          this.emitter.updatePositions(this.activePositions);
          setTimeout(() => this.syncPositions(), 500);
        } else {
          this.emitter.log(`[${symbol}] Strategy Exit order rejected: ${closeRes.retMsg}`);
        }
      } catch (err: any) {
        this.emitter.log(`[${symbol}] Strategy Exit exception: ${err.message}`);
      } finally {
        this.isProcessingTrade[symbol] = false;
      }
    }
    // 2. Entry Signal: Allowed if NOT currently in position for this symbol AND active positions count < maxPositions
    else if (!symbolPosition && shouldBuy) {
      const maxSlots = this.settings.maxPositions || 5;
      if (this.activePositions.length >= maxSlots) {
        if (shouldLogCondition) {
          this.emitter.log(`[Strategy] Long signal for ${symbol} skipped: All ${maxSlots} active position slots are occupied.`);
        }
        return;
      }

      this.isProcessingTrade[symbol] = true;
      this.emitter.log(`[Strategy] Long signal approved for ${symbol} @ ${currentPrice} (Slot ${this.activePositions.length + 1}/${maxSlots}). Placing Market Buy...`);

      try {
        const notionalSizeUsdt = (this.settings.positionMarginUsdt || 100) * (this.settings.leverage || 10);
        const preOrder = await this.validatePreOrder(symbol, notionalSizeUsdt);
        
        if (!preOrder.valid) {
          this.emitter.log(`[Strategy] ${preOrder.reason}`);
          return;
        }
        
        currentPrice = preOrder.price;
        const qty = preOrder.qty;

        const { takeProfit, stopLoss } = this.riskManager.calculateBrackets(
          currentPrice,
          this.settings.tpPercent,
          this.settings.slPercent
        );

        await this.ensureLeverage(symbol);

        const orderRes = await this.bybit.submitOrder({
          category: "linear",
          symbol,
          side: "Buy",
          orderType: "Market",
          qty,
          timeInForce: "IOC",
          takeProfit,
          stopLoss,
        });

        if (orderRes.retCode === 0) {
          this.emitter.log(`[${symbol}] Buy order filled! Order ID: ${orderRes.result?.orderId}`);
          this.emitter.log(
            `[${symbol}] Brackets set: TP @ ${takeProfit} (+${this.settings.tpPercent}%), SL @ ${stopLoss} (-${this.settings.slPercent}%)`
          );

          const buyTrade = {
            id: orderRes.result?.orderId || `buy-${Date.now()}`,
            type: "buy",
            symbol,
            price: currentPrice,
            entryPrice: currentPrice,
            qty,
            takeProfit,
            stopLoss,
            time: Date.now(),
          };

          this.telegram.sendTradeExecution(symbol, "Long", currentPrice, qty, takeProfit, stopLoss);
          dbRecordTrade({ symbol, side: "Buy", entryPrice: currentPrice, status: "OPEN", sizeNotional: 1000, marginUsed: 100, leverage: this.settings.leverage || 10 });

          this.activePositions.push({
            symbol,
            side: "Buy",
            size: qty,
            avgPrice: currentPrice.toString(),
            markPrice: currentPrice.toString(),
          });
          this.positionState[symbol] = { peakPrice: currentPrice, breakEvenSet: false };
          this.emitter.updatePositions(this.activePositions);

          // Background sync to fetch Bybit order ID and leverage details
          setTimeout(() => this.syncPositions(), 1000);
        } else {
          this.emitter.log(`[${symbol}] Buy order rejected: ${orderRes.retMsg}`);
        }
      } catch (err: any) {
        this.emitter.log(`[${symbol}] Buy order exception: ${err.message}`);
      } finally {
        this.isProcessingTrade[symbol] = false;
      }
    }
  }

  public shutdown() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.stop();
    this.wsManager.close();
  }
}
