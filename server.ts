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
import { MarketScanner5m, Scanner5mSignal } from "./src/engine/MarketScanner5m";
import { SixGateFilteringPipeline } from "./src/engine/SixGateFilteringPipeline";
import { initDatabase, dbGetClosedTrades } from "./src/db";
import { getUtcTradingDayWindow, normalizeTimestampMs } from "./src/utils/utcTradingDay";
import { classifyClosedTradeExit } from "./src/utils/exitClassification";

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

  const bybit = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    demoTrading: process.env.BYBIT_DEMO === 'true',
    testnet: false,
  });

  const engine = new TradingEngine(bybit, io);
  const pipelineEngine = new SixGateFilteringPipeline(bybit);
  pipelineEngine.start();

  const scanner5m = new MarketScanner5m(bybit, async (signal: Scanner5mSignal) => {
    io.emit("scanner-5m:signal", signal);
    io.emit("scanner5m:signal", signal);
    engine.emitter.log(
      `⚡ [5m Scanner] ${signal.grade} ${signal.side} Signal Detected on #${signal.symbol} @ $${signal.price} (RSI: ${signal.technicals.rsi14}, Vol: ${(signal.technicals.volumeRatio * 100).toFixed(0)}% avg)`
    );
    await engine.telegram.sendScanner5mSignal(
      signal.symbol,
      signal.side,
      signal.grade,
      signal.price,
      signal.technicals.rsi14,
      signal.technicals.ema50,
      signal.technicals.ema200,
      signal.technicals.volumeRatio,
      signal.reason
    );
  });
  scanner5m.startScheduler();

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
    res.json({ success: true, settings: engine.settings });
  });

  app.post("/api/settings", requireAuth, (req, res) => {
    const { settings } = req.body;
    if (settings) {
      engine.updateSettings(settings);
      res.json({ success: true, settings: engine.settings });
    } else res.status(400).json({ success: false, message: "Missing settings" });
  });

  app.get("/api/history", async (req, res) => {
    try {
      const closedTrades = await dbGetClosedTrades();
      const totalTrades = closedTrades.length;
      const winningTrades = closedTrades.filter(t => t.pnl > 0).length;
      const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
      const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
      res.json({
        success: true,
        history: closedTrades,
        metrics: { totalTrades, winRate: winRate.toFixed(1) + "%", totalPnl: totalPnl.toFixed(2) }
      });
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
    } else res.status(400).json({ success: false, message: "Missing symbol" });
  });

  app.post("/api/watchlist/remove", (req, res) => {
    const { symbol } = req.body;
    if (symbol) {
      engine.removeSymbol(symbol.toUpperCase());
      res.json({ success: true, watchlist: engine.watchlist });
    } else res.status(400).json({ success: false, message: "Missing symbol" });
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
      if (!symbol) return res.status(400).json({ success: false, message: "Missing symbol in request body" });
      const targetSymbol = symbol.toUpperCase();
      if (side && qty) {
        const closeSide = side === "Buy" ? "Sell" : "Buy";
        const orderRes = await bybit.submitOrder({
          category: "linear", symbol: targetSymbol, side: closeSide, orderType: "Market", qty: qty.toString(), reduceOnly: true, timeInForce: "IOC", orderLinkId: `app-manual-${Date.now().toString(36)}`,
        });
        if (orderRes.retCode === 0) {
          engine.emitter.log(`[Manual Close] Closed ${targetSymbol} position (${qty} contracts)`);
          return res.json({ success: true, message: `Successfully closed ${targetSymbol} position`, orderId: orderRes.result?.orderId });
        }
        return res.status(400).json({ success: false, error: orderRes.retMsg || "Bybit rejected market close order", retCode: orderRes.retCode });
      }
      const result = await engine.manualClosePosition(targetSymbol);
      if (result.success) res.json(result);
      else res.status(400).json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/positions/close-all", requireAuth, async (req, res) => {
    try {
      const result = await engine.closeAllPositions();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/test-order", requireAuth, async (req, res) => {
    try {
      const symbol = req.body?.symbol || "BTCUSDT";
      const qty = req.body?.qty || "0.001";
      const result = await engine.executeManualTestOrder(symbol, qty);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/trading-summary", async (req, res) => {
    try {
      const symbol = req.query.symbol as string | undefined;
      const limit = Math.min(100, parseInt((req.query.limit as string) || "50", 10));
      const pnlParams: any = { category: "linear", limit };
      if (symbol) pnlParams.symbol = symbol.toUpperCase();
      const pnlResponse = await bybit.getClosedPnL(pnlParams);
      const rawClosedList = pnlResponse.result?.list || [];
      const execParams: any = { category: "linear", limit };
      if (symbol) execParams.symbol = symbol.toUpperCase();
      const execResponse = await bybit.getExecutionList(execParams);
      const rawExecList = execResponse.result?.list || [];

      let totalRealizedPnl = 0;
      let winningTrades = 0;
      let losingTrades = 0;
      let breakEvenTrades = 0;
      const closedTrades = rawClosedList.map((item: any) => {
        const closedPnlNum = parseFloat(item.closedPnl || "0");
        totalRealizedPnl += closedPnlNum;
        if (closedPnlNum > 0) winningTrades++;
        else if (closedPnlNum < 0) losingTrades++;
        else breakEvenTrades++;
        return {
          symbol: item.symbol,
          orderId: item.orderId,
          side: item.side,
          qty: item.qty,
          entryPrice: parseFloat(item.avgEntryPrice || "0"),
          exitPrice: parseFloat(item.avgExitPrice || "0"),
          closedPnl: closedPnlNum,
          closedPnlPercent: item.avgEntryPrice && parseFloat(item.avgEntryPrice) > 0
            ? ((parseFloat(item.avgExitPrice || "0") - parseFloat(item.avgEntryPrice)) / parseFloat(item.avgEntryPrice)) * 100 * (item.side === "Buy" ? -1 : 1)
            : 0,
          execTime: normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime),
          orderType: item.orderType,
        };
      });
      const totalClosedTrades = closedTrades.length;
      const winRatePercent = totalClosedTrades > 0 ? parseFloat(((winningTrades / totalClosedTrades) * 100).toFixed(2)) : 0;
      const averagePnlPerTrade = totalClosedTrades > 0 ? parseFloat((totalRealizedPnl / totalClosedTrades).toFixed(4)) : 0;
      const executionLogs = rawExecList.map((exec: any) => ({
        execId: exec.execId,
        orderId: exec.orderId,
        symbol: exec.symbol,
        side: exec.side,
        price: parseFloat(exec.execPrice || "0"),
        qty: parseFloat(exec.execQty || "0"),
        fee: parseFloat(exec.execFee || "0"),
        feeRate: parseFloat(exec.feeRate || "0"),
        execTime: normalizeTimestampMs(exec.execTime),
        execType: exec.execType,
        isMaker: exec.isMaker,
        closedSize: exec.closedSize,
        stopOrderType: exec.stopOrderType,
      }));
      res.json({
        success: true,
        environment: "Bybit UTA Demo Trading (V5)",
        timestamp: Date.now(),
        metrics: {
          totalClosedTrades,
          winningTrades,
          losingTrades,
          breakEvenTrades,
          winRatePercent,
          totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(4)),
          averagePnlPerTrade,
          currency: "USDT",
        },
        closedTrades,
        executionLogs,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to fetch trading summary from Bybit Demo API" });
    }
  });

  app.get("/api/analytics/daily", async (req, res) => {
    try {
      const nowMs = Date.now();
      const { startMs: dayStartMs, endMs: dayEndMs } = getUtcTradingDayWindow(nowMs);

      const [posRes, pnlResponse, execResponse, orderHistoryResponse] = await Promise.all([
        bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" }),
        bybit.getClosedPnL({ category: "linear", startTime: dayStartMs, endTime: dayEndMs, limit: 100 }),
        bybit.getExecutionList({ category: "linear", startTime: dayStartMs, endTime: dayEndMs, limit: 100 }),
        bybit.getHistoricOrders({ category: "linear", startTime: dayStartMs, endTime: dayEndMs, limit: 100 }).catch(() => null),
      ]);

      const openPositions = (posRes.result?.list || []).filter((p: any) => parseFloat(p.size || "0") > 0);
      const activePositionsCount = openPositions.length;
      const maxSlots = engine.settings.maxPositions || 3;
      const rawClosedList = pnlResponse.result?.list || [];
      const rawExecutions = execResponse.result?.list || [];
      const rawOrderHistory = orderHistoryResponse?.retCode === 0 ? (orderHistoryResponse.result?.list || []) : [];
      const engineHistory = engine.getHistory() || [];

      const closedTodayRaw = rawClosedList.filter((item: any) => {
        const closeTime = normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime);
        return closeTime >= dayStartMs && closeTime <= dayEndMs;
      });
      const executionsToday = rawExecutions.filter((exec: any) => {
        const execTime = normalizeTimestampMs(exec.execTime);
        return execTime >= dayStartMs && execTime <= dayEndMs && String(exec.execType || "Trade") === "Trade";
      });
      const ordersToday = rawOrderHistory.filter((order: any) => {
        const orderTime = normalizeTimestampMs(order.updatedTime || order.createdTime);
        return orderTime >= dayStartMs && orderTime <= dayEndMs;
      });

      const dailyCounters = { tp: 0, sl: 0, trailing: 0, manual: 0, other: 0, wins: 0, losses: 0 };
      const slCountsBySymbol: Record<string, number> = {};

      const todayTrades = closedTodayRaw.map((item: any) => {
        const pnl = Number(item.closedPnl || 0);
        const entryPrice = Number(item.avgEntryPrice || 0);
        const exitPrice = Number(item.avgExitPrice || 0);
        const closeTime = normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime);
        const pnlPercent = entryPrice > 0
          ? ((exitPrice - entryPrice) / entryPrice) * 100 * (item.side === "Buy" ? -1 : 1)
          : 0;

        const classified = classifyClosedTradeExit({
          closedTrade: item,
          executions: executionsToday,
          orders: ordersToday,
          localHistory: engineHistory,
        });

        if (classified.category === "TP") dailyCounters.tp++;
        else if (classified.category === "SL") {
          dailyCounters.sl++;
          slCountsBySymbol[item.symbol] = (slCountsBySymbol[item.symbol] || 0) + 1;
        } else if (classified.category === "TRAILING") dailyCounters.trailing++;
        else if (classified.category === "MANUAL") dailyCounters.manual++;
        else dailyCounters.other++;

        if (pnl > 0) dailyCounters.wins++;
        else if (pnl < 0) dailyCounters.losses++;

        return {
          id: String(item.orderId || `close-${item.symbol}-${closeTime}`),
          symbol: item.symbol,
          side: item.side === "Buy" ? "SHORT" : "LONG",
          entryPrice,
          exitPrice,
          qty: String(item.qty || "0"),
          pnl,
          pnlPercent,
          exitTrigger: classified.label,
          classifiedBy: classified.classifiedBy,
          matchedOrderId: classified.matchedOrderId,
          matchedOrderLinkId: classified.matchedOrderLinkId,
          rawStopOrderType: classified.rawStopOrderType,
          rawCreateType: classified.rawCreateType,
          time: closeTime,
        };
      });

      // Opening executions have no closedSize (or zero closedSize). Count unique opening orders,
      // not fills, so partial fills do not inflate Today's Total Opened.
      const openingExecutions = executionsToday.filter((exec: any) => Number(exec.closedSize || 0) <= 0);
      const openedTradeKeys = new Set<string>();
      for (const exec of openingExecutions) {
        const execTime = normalizeTimestampMs(exec.execTime);
        const key = String(exec.orderId || exec.execId || `${exec.symbol}:${exec.side}:${execTime}`);
        openedTradeKeys.add(key);
      }

      // Position openTime is a fallback for a still-open position if its opening execution is not
      // present in the current execution page. Overnight positions are intentionally excluded.
      for (const pos of openPositions) {
        const openTime = normalizeTimestampMs(pos.openTime || pos.createdTime || pos.updatedTime);
        if (openTime < dayStartMs || openTime > dayEndMs) continue;
        const hasMatchingExecution = openingExecutions.some((exec: any) =>
          exec.symbol === pos.symbol && exec.side === pos.side && Math.abs(normalizeTimestampMs(exec.execTime) - openTime) <= 60_000
        );
        if (!hasMatchingExecution) openedTradeKeys.add(`position:${pos.symbol}:${pos.side}:${openTime}`);
      }

      const realizedPnlToday = todayTrades.reduce((sum: number, t: any) => sum + Number(t.pnl || 0), 0);
      const unrealizedPnlToday = openPositions.reduce((sum: number, p: any) => sum + Number(p.unrealisedPnl || 0), 0);
      const netDailyPnl = realizedPnlToday + unrealizedPnlToday;
      const exitBreakdownTotal = dailyCounters.tp + dailyCounters.sl + dailyCounters.trailing + dailyCounters.manual + dailyCounters.other;
      if (exitBreakdownTotal !== todayTrades.length) {
        throw new Error(`Daily exit breakdown mismatch: ${exitBreakdownTotal} categorized vs ${todayTrades.length} closed`);
      }

      let worstPerformingSymbol = "None";
      let slCountForWorst = 0;
      for (const [symbol, count] of Object.entries(slCountsBySymbol)) {
        if (count > slCountForWorst) {
          worstPerformingSymbol = symbol;
          slCountForWorst = count;
        }
      }

      res.json({
        success: true,
        analytics: {
          tradingDay: "UTC",
          tradingDayStartUtc: dayStartMs,
          windowEndUtc: dayEndMs,
          todayOpenedCount: openedTradeKeys.size,
          todayClosedCount: todayTrades.length,
          winningTradesCount: dailyCounters.wins,
          losingTradesCount: dailyCounters.losses,
          activePositionsCount,
          maxSlots,
          tpHitCount: dailyCounters.tp,
          trailingStopCount: dailyCounters.trailing,
          slHitCount: dailyCounters.sl,
          manualCloseCount: dailyCounters.manual,
          otherExitCount: dailyCounters.other,
          breakEvenCount: 0,
          realizedPnlToday,
          unrealizedPnlToday,
          netDailyPnl,
          slAudit: {
            primarySlCause: dailyCounters.sl > 0 ? "Exact root cause unavailable from current Bybit/local metadata" : "No Stop Loss exits today",
            worstPerformingSymbol,
            slCountForWorst,
            averageTimeToSlSeconds: 0,
            strategyFeedbackNote: "Daily SL analytics use only confirmed UTC-day exits. Unknown reasons remain Unknown / Other; no random or PnL-sign classification is fabricated.",
            totalLossUsdt: todayTrades
              .filter((t: any) => t.exitTrigger === "Stop Loss")
              .reduce((sum: number, t: any) => sum + Math.abs(Number(t.pnl || 0)), 0),
          },
          closedTrades: todayTrades,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/bot/start", requireAuth, (req, res) => {
    if (engine.start()) res.json({ success: true, message: "Bot started" });
    else res.status(400).json({ success: false, message: "Bot is already running" });
  });

  app.post("/api/bot/stop", requireAuth, (req, res) => {
    if (engine.stop()) res.json({ success: true, message: "Bot stopped" });
    else res.status(400).json({ success: false, message: "Bot is not running" });
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
        scanner: "50/200 EMA + RSI 14 + Volume Confirmation",
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
