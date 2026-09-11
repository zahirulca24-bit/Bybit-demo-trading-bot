import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import http from "http";
import path from "path";
import { Server as SocketIOServer } from "socket.io";
import { RestClientV5 } from "bybit-api";
import dotenv from "dotenv";
import { EMA } from "technicalindicators";
import { TradingEngine } from "./src/engine/TradingEngine";
import { LegacyInformationalScanner5m } from "./src/engine/MarketScanner5m";
import { SixGateFilteringPipeline } from "./src/engine/SixGateFilteringPipeline";
import { initDatabase, dbGetTradeMetadata } from "./src/db";
import { getUtcTradingDayWindow, normalizeTimestampMs } from "./src/utils/utcTradingDay";
import { classifyClosedTradeExit } from "./src/utils/exitClassification";
import { TelegramReportService } from "./src/engine/TelegramReportService";
import { fetchClosedPnlRange, fetchExecutionRange, mergeStableLocalMetadata, summarizeNormalizedTrades } from "./src/utils/exchangeTradeHistory";

dotenv.config();

const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const secret = process.env.APP_SECRET;
  if (!secret) return next();
  const authHeader = req.headers.authorization;
  const headerSecret = req.headers['x-app-secret'] || req.headers['x-session-token'];
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
  else if (headerSecret) token = headerSecret as string;
  if (token === secret) next();
  else res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API secret' });
};

const isProd = process.env.NODE_ENV === "production";

async function startServer() {
  await initDatabase();
  const app = express();
  const server = http.createServer(app);
  const io = new SocketIOServer(server, { cors: { origin: "*" } });
  const PORT = Number(process.env.PORT) || 3000;

  app.use(cors());
  app.use(express.json());
  const sendApiError = (res: express.Response, status: number, message: string) => res.status(status).json({ success: false, error: { message } });

  const bybit = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    demoTrading: process.env.BYBIT_DEMO === 'true',
    testnet: false,
  });

  const engine = new TradingEngine(bybit, io);
  const pipelineEngine = new SixGateFilteringPipeline(bybit);
  pipelineEngine.start();

  const scanner5m = new LegacyInformationalScanner5m(bybit);
  engine.emitter.log("[Legacy / Informational Scanner] Isolated from auto-entry and Telegram. Manual API inspection only.");

  const telegramReports = new TelegramReportService(bybit, engine, engine.telegram);
  telegramReports.start();

  app.get("/api/balance", async (req, res) => {
    try {
      const response = await bybit.getWalletBalance({ accountType: "UNIFIED", coin: "USDT" });
      const balance = response.result?.list?.[0]?.coin?.[0]?.walletBalance || "0";
      res.json({ success: true, balance });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/prices", (req, res) => {
    res.json({ success: true, prices: engine.currentPrices });
  });

  app.get("/api/klines", async (req, res) => {
    try {
      const symbol = (req.query.symbol as string) || "BTCUSDT";
      const interval = (req.query.interval as string) || "5";
      const limit = Math.min(200, parseInt((req.query.limit as string) || "100", 10));
      const klineRes = await bybit.getKline({ category: "linear", symbol, interval: interval as any, limit });
      if (!klineRes.result?.list || klineRes.result.list.length === 0) {
        return res.json({ success: true, symbol, interval, candles: [], ema9: [], ema21: [] });
      }
      const rawList = [...klineRes.result.list].reverse();
      const candles = rawList.map((item: any) => ({
        time: Math.floor(parseInt(item[0], 10) / 1000),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5] || "0"),
      }));
      const closePrices = candles.map((c) => c.close);
      const ema9List = EMA.calculate({ period: 9, values: closePrices });
      const ema21List = EMA.calculate({ period: 21, values: closePrices });
      const ema9 = ema9List.map((val, idx) => ({ time: candles[idx + 8].time, value: Number(val.toFixed(4)) }));
      const ema21 = ema21List.map((val, idx) => ({ time: candles[idx + 20].time, value: Number(val.toFixed(4)) }));
      res.json({ success: true, symbol, interval, candles, ema9, ema21 });
    } catch (error: any) {
      console.error("Error fetching klines:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/settings", (req, res) => {
    res.json({ success: true, settings: engine.settings, riskProfile: engine.getRuntimeRiskProfile() });
  });

  app.post("/api/settings", requireAuth, (req, res) => {
    const { settings } = req.body;
    if (settings) {
      engine.updateSettings(settings);
      res.json({ success: true, settings: engine.settings, riskProfile: engine.getRuntimeRiskProfile() });
    } else sendApiError(res, 400, "Missing settings");
  });

  app.get("/api/history", async (req, res) => {
    try {
      const endTime = Number(req.query.endTime) || Date.now() + 1;
      const requestedStart = Number(req.query.startTime);
      const startTime = Number.isFinite(requestedStart) && requestedStart > 0 ? requestedStart : endTime - 7 * 24 * 60 * 60 * 1000;
      const symbol = typeof req.query.symbol === "string" && req.query.symbol ? req.query.symbol.toUpperCase() : undefined;
      const exchange = await fetchClosedPnlRange(bybit, { startTime, endTime, symbol });
      if (!exchange.ok) return res.status(502).json({ success: false, error: exchange.error || "Bybit Closed PnL unavailable" });
      const metadata = await dbGetTradeMetadata(startTime, endTime);
      const merged = mergeStableLocalMetadata(exchange.trades, metadata.ok ? metadata.rows : []);
      const summary = summarizeNormalizedTrades(merged);
      const history = merged.map((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        qty: trade.filledQty,
        filledQty: trade.filledQty,
        entryPrice: trade.avgEntryPrice,
        exitPrice: trade.avgExitPrice,
        pnl: trade.realizedPnlUsdt,
        realizedPnlUsdt: trade.realizedPnlUsdt,
        priceMovePercent: trade.priceMovePercent,
        returnOnNotionalPercent: trade.returnOnNotionalPercent,
        roePercent: trade.roePercent,
        pnlPercent: trade.returnOnNotionalPercent,
        reason: trade.metadata?.exitReason || "Other / Unknown",
        time: trade.closedAt,
        orderId: trade.orderId,
        orderLinkId: trade.orderLinkId,
        outcome: trade.outcome,
      }));
      res.json({ success: true, source: "Bybit Closed PnL", history, metrics: summary, metadataCoverage: metadata.ok ? "available" : "unavailable" });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/technicals", (req, res) => {
    res.json({ success: true, technicals: engine.getTechnicals() });
  });

  app.post("/api/test-telegram", requireAuth, async (req, res) => {
    try {
      const result = await engine.telegram.sendTestNotification();
      if (result.success) res.json({ success: true, message: "Test notification sent successfully to Telegram!" });
      else res.status(400).json({ success: false, message: result.error || "Failed to send Telegram message" });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  let runtimeStatusCache: { at: number; data: any } = { at: 0, data: null };
  app.get("/api/runtime-status", async (req, res) => {
    const now = Date.now();
    if (runtimeStatusCache.data && now - runtimeStatusCache.at < 15_000) return res.json(runtimeStatusCache.data);
    let bybitNetworkReachable = false;
    let accountAuthenticated = false;
    let privateApiHealthy = false;
    let error: string | null = null;
    try {
      const publicResult = await bybit.getServerTime();
      bybitNetworkReachable = publicResult.retCode === 0;
    } catch (err: any) { error = err?.message || "Bybit network check failed"; }
    if (bybitNetworkReachable) {
      try {
        const privateResult = await bybit.getWalletBalance({ accountType: "UNIFIED", coin: "USDT" });
        accountAuthenticated = privateResult.retCode === 0 && Array.isArray(privateResult.result?.list);
        privateApiHealthy = accountAuthenticated;
        if (!privateApiHealthy) error = privateResult.retMsg || "Bybit private API authentication failed";
      } catch (err: any) { error = err?.message || "Bybit private API check failed"; }
    }
    const ws = engine.wsManager.getRuntimeStatus();
    const scanner = engine.scanner.getState();
    const data = {
      success: true,
      status: {
        bybitNetworkReachable,
        accountAuthenticated,
        privateApiHealthy,
        privateWsConnected: ws.connected && ws.privateAuthenticated,
        privateWsAuthenticated: ws.privateAuthenticated,
        tradingEngineRunning: engine.getIsRunning(),
        scannerState: scanner.isScanning ? "scanning" : scanner.lastScanTime ? "scheduled" : "idle",
        scannerLastScanTime: scanner.lastScanTime,
        checkedAt: now,
        error,
      },
    };
    runtimeStatusCache = { at: now, data };
    res.json(data);
  });

  app.get("/api/test-bybit", async (req, res) => {
    const startTime = Date.now();
    try {
      const response = await bybit.getServerTime();
      const latencyMs = Date.now() - startTime;
      if (response.retCode === 0) {
        res.json({
          success: true,
          serverTime: response.result?.timeNano ? new Date(parseInt(response.result.timeNano.slice(0, 13), 10)).toISOString() : new Date().toISOString(),
          latencyMs,
          environment: "Bybit Demo Trading (UTA)",
          apiKeyConfigured: Boolean(process.env.BYBIT_API_KEY),
        });
      } else {
        res.status(400).json({ success: false, latencyMs, error: response.retMsg || "Bybit API returned non-zero retCode", retCode: response.retCode });
      }
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      res.status(500).json({ success: false, latencyMs, error: error.message || "Failed to reach Bybit Demo API" });
    }
  });

  app.get("/api/watchlist", (req, res) => {
    res.json({ success: true, watchlist: engine.watchlist });
  });

  app.post("/api/watchlist/add", (req, res) => {
    const { symbol } = req.body;
    if (symbol) {
      engine.addSymbol(symbol.toUpperCase());
      res.json({ success: true, watchlist: engine.watchlist });
    } else sendApiError(res, 400, "Missing symbol");
  });

  app.post("/api/watchlist/remove", (req, res) => {
    const { symbol } = req.body;
    if (symbol) {
      engine.removeSymbol(symbol.toUpperCase());
      res.json({ success: true, watchlist: engine.watchlist });
    } else sendApiError(res, 400, "Missing symbol");
  });

  app.get("/api/positions", async (req, res) => {
    try {
      const response = await bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
      res.json({ success: true, positions: response.result?.list || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/positions/active", async (req, res) => {
    try {
      const response = await bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
      const rawList = response.result?.list || [];
      const activePositions = rawList
        .filter((pos: any) => parseFloat(pos.size || "0") > 0)
        .map((pos: any) => {
          const entryPrice = parseFloat(pos.avgPrice || "0");
          const markPrice = parseFloat(pos.markPrice || "0");
          const size = parseFloat(pos.size || "0");
          const leverage = parseFloat(pos.leverage || "1");
          const unrealisedPnl = parseFloat(pos.unrealisedPnl || "0");
          const initialMargin = (entryPrice * size) / (leverage > 0 ? leverage : 1);
          const curRealisedPnlPercent = initialMargin > 0 ? ((unrealisedPnl / initialMargin) * 100).toFixed(2) + "%" : "0.00%";
          const openTime = normalizeTimestampMs(pos.openTime || pos.createdTime || pos.updatedTime);
          return {
            symbol: pos.symbol,
            side: pos.side,
            size: pos.size,
            avgPrice: pos.avgPrice,
            markPrice: pos.markPrice,
            unrealisedPnl: pos.unrealisedPnl,
            curRealisedPnl: curRealisedPnlPercent,
            leverage: pos.leverage,
            stopLoss: pos.stopLoss || "0",
            takeProfit: pos.takeProfit || "0",
            liqPrice: pos.liqPrice || "0",
            openTime,
            createdTime: openTime,
          };
        });
      res.json({ success: true, count: activePositions.length, positions: activePositions });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to fetch active positions" });
    }
  });

  app.post("/api/positions/close", requireAuth, async (req, res) => {
    try {
      const { symbol, side, qty } = req.body;
      if (!symbol) return sendApiError(res, 400, "Missing symbol in request body");
      const targetSymbol = symbol.toUpperCase();
      // Route every UI/manual close through TradingEngine so the exact closing
      // order identity is preserved for reconciliation and exit audit.
      const result = await engine.manualClosePosition(targetSymbol);
      if (result.success) res.json(result);
      else sendApiError(res, 400, result.message || `Failed to close position for ${symbol}`);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/positions/close-all", requireAuth, async (req, res) => {
    try {
      const result = await engine.closeAllPositions();
      if (result.success) res.json(result);
      else sendApiError(res, 500, "Failed to close all positions");
    } catch (error: any) {
      sendApiError(res, 500, error.message || "Failed to close all positions");
    }
  });

  app.post("/api/test-order", requireAuth, async (req, res) => {
    try {
      const symbol = req.body?.symbol || "BTCUSDT";
      const qty = req.body?.qty || "0.001";
      const result = await engine.executeManualTestOrder(symbol, qty);
      if (result.success) res.json(result);
      else sendApiError(res, 400, result.message || "Quick Test order rejected");
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/trading-summary", async (req, res) => {
    try {
      const endTime = Number(req.query.endTime) || Date.now() + 1;
      const requestedStart = Number(req.query.startTime);
      const startTime = Number.isFinite(requestedStart) && requestedStart > 0 ? requestedStart : endTime - 7 * 24 * 60 * 60 * 1000;
      const symbol = typeof req.query.symbol === "string" && req.query.symbol ? req.query.symbol.toUpperCase() : undefined;
      const exchange = await fetchClosedPnlRange(bybit, { startTime, endTime, symbol });
      if (!exchange.ok) return res.status(502).json({ success: false, error: exchange.error });
      const metadata = await dbGetTradeMetadata(startTime, endTime);
      const trades = mergeStableLocalMetadata(exchange.trades, metadata.ok ? metadata.rows : []);
      res.json({
        success: true,
        environment: "Bybit UTA Demo Trading (V5)",
        source: "Bybit Closed PnL",
        timestamp: Date.now(),
        metrics: summarizeNormalizedTrades(trades),
        closedTrades: trades,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to fetch trading summary from Bybit Demo API" });
    }
  });

  app.get("/api/analytics/daily", async (req, res) => {
    try {
      const nowMs = Date.now();
      const { startMs: dayStartMs, endMs: dayEndMs } = getUtcTradingDayWindow(nowMs);
      const [posRes, closedResult, executionResult, orderHistoryResponse] = await Promise.all([
        bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" }),
        fetchClosedPnlRange(bybit, { startTime: dayStartMs, endTime: dayEndMs }),
        fetchExecutionRange(bybit, { startTime: dayStartMs, endTime: dayEndMs }),
        bybit.getHistoricOrders({ category: "linear", startTime: dayStartMs, endTime: dayEndMs - 1, limit: 100 }).catch(() => null),
      ]);
      if (!closedResult.ok) return res.status(502).json({ success: false, error: closedResult.error || "Bybit Closed PnL unavailable" });
      if (!executionResult.ok) return res.status(502).json({ success: false, error: executionResult.error || "Bybit executions unavailable" });

      const openPositions = (posRes.result?.list || []).filter((p: any) => Number(p.size) > 0);
      const metadata = await dbGetTradeMetadata(dayStartMs, dayEndMs);
      const mergedTrades = mergeStableLocalMetadata(closedResult.trades, metadata.ok ? metadata.rows : []);
      const rawOrders = orderHistoryResponse?.retCode === 0 ? (orderHistoryResponse.result?.list || []) : [];
      const engineHistory = engine.getHistory() || [];
      const rawByOrderId = new Map(closedResult.rows.map((row: any) => [String(row.orderId || ""), row]));
      const counters = { tp: 0, sl: 0, trailing: 0, manual: 0, other: 0 };
      const slCountsBySymbol: Record<string, number> = {};

      const closedTrades = mergedTrades.map((trade) => {
        const raw = trade.orderId ? rawByOrderId.get(trade.orderId) : null;
        const classified = classifyClosedTradeExit({
          closedTrade: raw || {},
          executions: executionResult.rows,
          orders: rawOrders,
          localHistory: engineHistory,
        });
        if (classified.category === "TP") counters.tp++;
        else if (classified.category === "SL") { counters.sl++; slCountsBySymbol[trade.symbol] = (slCountsBySymbol[trade.symbol] || 0) + 1; }
        else if (classified.category === "TRAILING") counters.trailing++;
        else if (classified.category === "MANUAL") counters.manual++;
        else counters.other++;
        return {
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.avgEntryPrice,
          exitPrice: trade.avgExitPrice,
          qty: trade.filledQty,
          pnl: trade.realizedPnlUsdt,
          pnlPercent: trade.returnOnNotionalPercent,
          priceMovePercent: trade.priceMovePercent,
          returnOnNotionalPercent: trade.returnOnNotionalPercent,
          roePercent: trade.roePercent,
          outcome: trade.outcome,
          exitTrigger: classified.label,
          classifiedBy: classified.classifiedBy,
          matchedOrderId: classified.matchedOrderId,
          matchedOrderLinkId: classified.matchedOrderLinkId,
          rawStopOrderType: classified.rawStopOrderType,
          rawCreateType: classified.rawCreateType,
          time: trade.closedAt,
        };
      });

      const openingExecutions = executionResult.rows.filter((exec: any) => String(exec.execType || "Trade") === "Trade" && Number(exec.execQty || 0) > 0 && Number(exec.closedSize || 0) <= 0);
      const openedTradeKeys = new Set(openingExecutions.map((exec: any) => String(exec.orderId || exec.orderLinkId || exec.execId || `${exec.symbol}:${exec.side}:${normalizeTimestampMs(exec.execTime)}`)));
      const summary = summarizeNormalizedTrades(mergedTrades);
      const unrealizedValues = openPositions.map((p: any) => Number(p.unrealisedPnl)).filter((n: number) => Number.isFinite(n));
      const unrealizedPnlToday = unrealizedValues.length === openPositions.length ? unrealizedValues.reduce((sum: number, n: number) => sum + n, 0) : null;
      const netDailyPnl = summary.realizedPnlUsdt !== null && unrealizedPnlToday !== null ? summary.realizedPnlUsdt + unrealizedPnlToday : null;
      let worstPerformingSymbol = "None";
      let slCountForWorst = 0;
      for (const [symbol, count] of Object.entries(slCountsBySymbol)) if (count > slCountForWorst) { worstPerformingSymbol = symbol; slCountForWorst = count; }

      res.json({ success: true, analytics: {
        tradingDay: "UTC",
        tradingDayStartUtc: dayStartMs,
        windowEndUtc: dayEndMs,
        todayOpenedCount: openedTradeKeys.size,
        todayClosedCount: closedTrades.length,
        winningTradesCount: summary.wins,
        losingTradesCount: summary.losses,
        zeroOrUnknownCount: summary.zeroOrUnknown,
        activePositionsCount: openPositions.length,
        maxSlots: engine.settings.maxPositions || 3,
        tpHitCount: counters.tp,
        trailingStopCount: counters.trailing,
        slHitCount: counters.sl,
        manualCloseCount: counters.manual,
        otherExitCount: counters.other,
        breakEvenCount: summary.zero,
        realizedPnlToday: summary.realizedPnlUsdt,
        unrealizedPnlToday,
        netDailyPnl,
        slAudit: {
          primarySlCause: counters.sl > 0 ? "Exact root cause unavailable from current Bybit/order metadata" : "No Stop Loss exits today",
          worstPerformingSymbol,
          slCountForWorst,
          averageTimeToSlSeconds: 0,
          strategyFeedbackNote: "Daily PnL and quantities come from paginated Bybit exchange records. Unknown values remain unavailable.",
          totalLossUsdt: mergedTrades.filter((t) => t.outcome === "LOSS" && t.realizedPnlUsdt !== null).reduce((sum, t) => sum + Math.abs(t.realizedPnlUsdt as number), 0),
        },
        closedTrades,
      }});
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/bot/start", requireAuth, (req, res) => {
    if (engine.start()) res.json({ success: true, message: "Bot started" });
    else sendApiError(res, 400, "Bot is already running");
  });

  app.post("/api/bot/stop", requireAuth, (req, res) => {
    if (engine.stop()) res.json({ success: true, message: "Engine paused: new entries and active position-management logic are paused" });
    else sendApiError(res, 400, "Bot is not running");
  });

  app.get('/api/bot/status', (req, res) => {
    res.json({ success: true, running: engine.getIsRunning(), circuitBreaker: engine.circuitBreakerTriggered });
  });

  app.post("/api/bot/reset-circuit-breaker", (req, res) => {
    engine.resetCircuitBreaker();
    res.json({ success: true, message: 'Circuit breaker reset' });
  });

  app.get("/api/scanner/state", (req, res) => {
    res.json({ success: true, state: engine.scanner.getState() });
  });

  app.post("/api/scanner/scan-now", async (req, res) => {
    try {
      await engine.scanner.scanMarkets();
      res.json({ success: true, state: engine.scanner.getState() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/scanner/refresh-markets", async (req, res) => {
    try {
      const symbols = await engine.scanner.discoverTopMarkets();
      await engine.scanner.scanMarkets();
      res.json({ success: true, topSymbols: symbols, state: engine.scanner.getState() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/scanner/toggle-autotrade", (req, res) => {
    const { autoTrade } = req.body;
    engine.scanner.setAutoTrade(Boolean(autoTrade));
    res.json({ success: true, autoTrade: engine.scanner.autoTrade });
  });

  app.post("/api/scanner/max-concurrent", (req, res) => {
    const { maxConcurrent } = req.body;
    engine.scanner.setMaxConcurrent(parseInt(maxConcurrent, 10) || 2);
    res.json({ success: true, maxConcurrent: engine.scanner.maxConcurrent });
  });

  app.get("/api/scanner/status", (req, res) => {
    try {
      res.json(scanner5m.getScheduleStatus());
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/scanner/signals", async (req, res) => {
    try {
      if (req.query.scan === "true" || scanner5m.scanResults.length === 0) await scanner5m.scanAllSymbols();
      res.json({
        success: true,
        timeframe: "5m",
        scanner: "Legacy / Informational Scanner — no order execution",
        timestamp: Date.now(),
        lastScanTime: scanner5m.lastScanTime,
        isScanning: scanner5m.isScanning,
        scannedSymbolsCount: scanner5m.symbols.length,
        activeSignals: scanner5m.detectedSignals,
        marketSetups: scanner5m.scanResults,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to fetch 5m scanner signals" });
    }
  });

  app.post("/api/scanner/signals/scan-now", async (req, res) => {
    try {
      const results = await scanner5m.scanAllSymbols();
      res.json({
        success: true,
        lastScanTime: scanner5m.lastScanTime,
        signalsCount: scanner5m.detectedSignals.length,
        activeSignals: scanner5m.detectedSignals,
        marketSetups: results,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/scanner/pipeline", async (req, res) => {
    try {
      const state = pipelineEngine.getState();
      if (state.symbols.length === 0 || req.query.refresh === "true") await pipelineEngine.executePipelineScan();
      res.json({ success: true, pipeline: pipelineEngine.getState() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/scanner/pipeline/scan-now", async (req, res) => {
    try {
      const state = await pipelineEngine.executePipelineScan();
      res.json({ success: true, pipeline: state });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.emit("bot-status", { running: engine.getIsRunning() });
    socket.emit("price-update", engine.currentPrices);
    socket.emit("ticker:update", engine.currentPrices);
    socket.emit("watchlist-update", engine.watchlist);
    socket.emit('settings-update', { ...engine.settings, demoTrading: process.env.BYBIT_DEMO === 'true' });
    socket.emit("technicals-update", engine.currentTechnicals);
    socket.emit("positions-update", engine.activePositions);
    socket.emit("position:update", engine.activePositions);
    socket.emit("scanner-update", engine.scanner.getState());
    socket.emit("scanner:update", engine.scanner.getState());
    if (engine.currentBalance && engine.currentBalance !== "0") socket.emit("balance-update", { balance: engine.currentBalance });
    socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  server.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
