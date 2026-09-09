import { RestClientV5 } from "bybit-api";
import { EMA, RSI, ATR } from "technicalindicators";
import { WebSocketEmitter } from "./TradingEngine";
import { TelegramNotifier } from "./TelegramNotifier";
import { PipelineState, ScannedMarketItem, ScannerState, RsiZone5m } from "../types";
import { calculateEmaTimingQuality, calculateFinalSetupScore } from "../utils/emaTimingQuality";
import { buildExecutionEligibility, buildPipelineStateFromMarkets, evaluateGate6, formatScannerTurnover } from "../utils/canonicalScanner";
import { ScannerMarketDataService, ScannerTicker } from "./ScannerMarketDataService";

export interface ScannerTradeExecutor {
  getIsRunning: () => boolean;
  activePositions: any[];
  currentPrices: Record<string, number>;
  settings?: { maxPositions?: number; positionMarginUsdt?: number; leverage?: number };
  checkScannerExecutionEligibility: (symbol: string, side: "Buy" | "Sell", notionalSizeUsdt: number) => Promise<{ riskEligible: boolean; preOrderValid: boolean; reason?: string }>;
  executeScannerEntry: (
    symbol: string,
    side: "Buy" | "Sell",
    currentPrice: number,
    ema50: number,
    ema200: number,
    rsi: number,
    quality?: { atr?: number; atrPercent?: number; oiExpansionPercent?: number; spreadPercent?: number; trendState?: string; breakoutBonus?: boolean; entryCandleDirection?: "Bullish" | "Bearish" | "Doji"; ema9?: number; ema21?: number; ema9Above21?: boolean; ema9Slope?: number; ema21Slope?: number; freshCross?: "bullish" | "bearish" | "none"; crossoverAgeCandles?: number | null; emaTimingScore?: number; finalSetupScore?: number; emaTimingState?: string; emaTimingChoppy?: boolean }
  ) => Promise<{ success: boolean; message: string; orderId?: string }>;
}

export class MarketScanner {
  public topSymbols: string[] = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT",
    "NEARUSDT", "SUIUSDT", "BNBUSDT", "PEPEUSDT", "AVAXUSDT",
    "LINKUSDT", "ADAUSDT", "WIFUSDT", "APTUSDT", "LTCUSDT",
    "SHIBUSDT", "TRXUSDT", "DOTUSDT", "UNIUSDT", "OPUSDT",
  ];

  public scannedItems: ScannedMarketItem[] = [];
  public autoTrade = true;
  public maxConcurrent = 3;
  public isScanning = false;
  public lastScanTime = 0;
  public scanIntervalSec = 20;

  private scanTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private marketData: ScannerMarketDataService;

  private readonly minTurnover = 25_000_000;
  private readonly maxSpreadPercent = 0.08;
  private readonly minAtrPercent = 0.30;
  private readonly maxAtrPercent = 1.20;
  private readonly minOiExpansionPercent = 0.50;

  constructor(
    private bybit: RestClientV5,
    private emitter: WebSocketEmitter,
    private telegram: TelegramNotifier,
    private executor: ScannerTradeExecutor
  ) {
    this.marketData = new ScannerMarketDataService(bybit);
  }

  public async init() {
    this.emitter.log("📡 [Market Scanner] Starting canonical strict 6-gate market scanner...");
    await this.discoverTopMarkets();
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = setInterval(() => void this.discoverTopMarkets(), 30 * 60 * 1000);
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = setInterval(() => void this.scanMarkets(), this.scanIntervalSec * 1000);
    setTimeout(() => void this.scanMarkets(), 1500);
  }

  public async discoverTopMarkets(): Promise<string[]> {
    try {
      const tickerMap = await this.marketData.getTickerMap(true);
      const valid = [...tickerMap.values()]
        .filter((item) => item.symbol.endsWith("USDT") && !item.symbol.includes("-") && item.lastPrice > 0 && item.turnover24h >= this.minTurnover)
        .sort((a, b) => b.turnover24h - a.turnover24h);
      const top20 = valid.slice(0, 20).map((item) => item.symbol);
      if (top20.length >= 5) this.topSymbols = top20;
      this.emitter.log(`📊 [Market Scanner] ${this.topSymbols.length} markets loaded with >= $25M turnover.`);
    } catch (err: any) {
      this.emitter.log(`⚠️ [Market Scanner] Discovery warning: ${err.message}`);
    }
    return this.topSymbols;
  }

  public async scanMarkets(): Promise<ScannedMarketItem[]> {
    if (this.isScanning) return this.scannedItems;
    this.isScanning = true;
    try {
      const tickerMap = await this.marketData.beginCycle();
      const newItems: ScannedMarketItem[] = [];
      for (let i = 0; i < this.topSymbols.length; i += 5) {
        const results = await Promise.all(this.topSymbols.slice(i, i + 5).map((symbol) => this.evaluateSingleSymbol(symbol, tickerMap)));
        for (const item of results) if (item) newItems.push(item);
      }

      await this.attachExecutionEligibility(newItems);
      newItems.sort((a, b) => {
        const rank = (s: string) => s === "BUY_SIGNAL" || s === "SELL_SIGNAL" ? 0 : s === "IN_POSITION" ? 1 : 2;
        const diff = rank(a.signal) - rank(b.signal);
        if (diff !== 0) return diff;
        const qualityDiff = (b.finalSetupScore ?? 0) - (a.finalSetupScore ?? 0);
        return qualityDiff !== 0 ? qualityDiff : b.turnover24h - a.turnover24h;
      });

      this.scannedItems = newItems;
      this.lastScanTime = Date.now();
      this.emitter.updateScanner(this.getState());
      const candidates = newItems.filter((item) => item.executionEligibility.gateCandidate && (item.signal === "BUY_SIGNAL" || item.signal === "SELL_SIGNAL"));
      if (candidates.length > 0) this.emitter.log(`🚀 [Strict Scanner] ${candidates.length} 6-gate candidate(s): ${candidates.map((s) => `${s.symbol}:${s.signal}`).join(", ")}`);
      if (this.autoTrade && this.executor.getIsRunning()) {
        await this.handleAutoTradeTriggers(candidates);
        this.emitter.updateScanner(this.getState());
      }
    } catch (err: any) {
      this.emitter.log(`⚠️ [Market Scanner] Scan error: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
    return this.scannedItems;
  }

  private async evaluateSingleSymbol(symbol: string, tickerMap: Map<string, ScannerTicker>): Promise<ScannedMarketItem | null> {
    try {
      const ticker = tickerMap.get(symbol);
      if (!ticker) return null;
      this.executor.currentPrices[symbol] = ticker.lastPrice;

      const [closed15m, closed5m, oiMetric] = await Promise.all([
        this.marketData.getClosedKlines(symbol, "15", 210),
        this.marketData.getClosedKlines(symbol, "5", 80),
        this.marketData.getOpenInterest(symbol),
      ]);
      if (closed15m.length < 200 || closed5m.length < 30) return null;

      const closes15m = closed15m.map((k: any) => Number(k[4]));
      const ema50List = EMA.calculate({ period: 50, values: closes15m });
      const ema200List = EMA.calculate({ period: 200, values: closes15m });
      if (!ema50List.length || !ema200List.length) return null;
      const ema50 = ema50List[ema50List.length - 1];
      const ema200 = ema200List[ema200List.length - 1];
      const confirmed15mPrice = closes15m[closes15m.length - 1];
      let trend15m: ScannedMarketItem["trend15m"] = "Neutral HTF";
      if (ema50 > ema200 && confirmed15mPrice > ema50) trend15m = "Bullish HTF";
      else if (ema50 < ema200 && confirmed15mPrice < ema50) trend15m = "Bearish HTF";

      const bid = ticker.bid1Price;
      const ask = ticker.ask1Price;
      const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : 0;
      const spreadPcnt = mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY;

      const highs5m = closed5m.map((k: any) => Number(k[2]));
      const lows5m = closed5m.map((k: any) => Number(k[3]));
      const closes5m = closed5m.map((k: any) => Number(k[4]));
      const confirmed5mPrice = closes5m[closes5m.length - 1];
      const atrList = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m });
      const rsiList = RSI.calculate({ period: 14, values: closes5m });
      if (!atrList.length || !rsiList.length || !confirmed5mPrice) return null;
      const currentAtr = atrList[atrList.length - 1];
      const atrPcnt = (currentAtr / confirmed5mPrice) * 100;
      const currentRsi = rsiList[rsiList.length - 1];

      const previousCandle = closed5m[closed5m.length - 2];
      const latestCandle = closed5m[closed5m.length - 1];
      const previousClose = Number(previousCandle?.[4] || 0);
      const latestOpen = Number(latestCandle?.[1] || 0);
      const latestClose = Number(latestCandle?.[4] || 0);
      const longConfirmed = latestClose > previousClose && latestClose > latestOpen;
      const shortConfirmed = latestClose < previousClose && latestClose < latestOpen;
      const breakoutBonusLong = latestClose > Number(previousCandle?.[2] || 0);
      const breakoutBonusShort = latestClose < Number(previousCandle?.[3] || 0);
      const entryCandleDirection: "Bullish" | "Bearish" | "Doji" = latestClose > latestOpen ? "Bullish" : latestClose < latestOpen ? "Bearish" : "Doji";

      const gate1 = ticker.turnover24h >= this.minTurnover;
      const gate2 = trend15m !== "Neutral HTF";
      const gate3 = Number.isFinite(spreadPcnt) && spreadPcnt <= this.maxSpreadPercent;
      const gate4 = atrPcnt >= this.minAtrPercent && atrPcnt <= this.maxAtrPercent;
      const oiChange = oiMetric.changePercent;
      const gate5 = oiMetric.available && oiChange !== null && oiChange >= this.minOiExpansionPercent;
      const gate6 = evaluateGate6({ trend15m, rsi: currentRsi, longCandleConfirmed: longConfirmed, shortCandleConfirmed: shortConfirmed });

      let rsiZone5m: RsiZone5m = "Neutral";
      if (trend15m === "Bullish HTF" && currentRsi >= 50 && currentRsi <= 64) rsiZone5m = "Long (50-64)";
      else if (trend15m === "Bearish HTF" && currentRsi >= 36 && currentRsi <= 50) rsiZone5m = "Short (36-50)";
      else if (currentRsi > 64) rsiZone5m = "Overbought (>64)";
      else if (currentRsi < 36) rsiZone5m = "Oversold (<36)";

      const sequential = [gate1, gate2, gate3, gate4, gate5, gate6.passed];
      let gatePassed = 0;
      for (const passed of sequential) { if (!passed) break; gatePassed++; }
      let failedGateNumber: number | null = null;
      let failedGateName: string | null = null;
      if (!gate1) { failedGateNumber = 1; failedGateName = "Gate 1: Turnover below $25M"; }
      else if (!gate2) { failedGateNumber = 2; failedGateName = "Gate 2: EMA trend / EMA50 price-side mismatch"; }
      else if (!gate3) { failedGateNumber = 3; failedGateName = "Gate 3: Spread above 0.08% or unavailable"; }
      else if (!gate4) { failedGateNumber = 4; failedGateName = "Gate 4: ATR outside 0.30%-1.20%"; }
      else if (!gate5) { failedGateNumber = 5; failedGateName = "Gate 5: OI expansion below +0.50% or unavailable"; }
      else if (!gate6.passed) { failedGateNumber = 6; failedGateName = `Gate 6: ${gate6.failureReason === "DIRECTIONAL_CANDLE_FAILED" ? "directional candle confirmation failed" : gate6.failureReason === "RSI_OUT_OF_RANGE" ? "RSI outside directional window" : gate6.failureReason === "RSI_AND_CANDLE_FAILED" ? "RSI and directional candle confirmation failed" : "directional confirmation unavailable"}`; }
      const passedAll = failedGateNumber === null;

      const timingSide = trend15m === "Bullish HTF" ? "LONG" : trend15m === "Bearish HTF" ? "SHORT" : null;
      const emaTiming = timingSide ? calculateEmaTimingQuality(closes5m, timingSide) : {
        available: false as const, freshCross: "none" as const, crossoverAgeCandles: null, emaTimingScore: 0,
        timingState: "Unavailable" as const, choppy: false, chopPenalty: 0,
      };
      const selectedBreakoutBonus = trend15m === "Bullish HTF" ? breakoutBonusLong : trend15m === "Bearish HTF" ? breakoutBonusShort : false;
      const finalSetupScore = passedAll ? calculateFinalSetupScore(emaTiming.emaTimingScore, selectedBreakoutBonus) : gatePassed;

      let signal: ScannedMarketItem["signal"] = "WAITING";
      if (passedAll && trend15m === "Bullish HTF") signal = "BUY_SIGNAL";
      else if (passedAll && trend15m === "Bearish HTF") signal = "SELL_SIGNAL";
      const signalReason = passedAll
        ? `Strict ${trend15m === "Bullish HTF" ? "Long" : "Short"}: RSI ${currentRsi.toFixed(1)} + confirmed directional 5m candle${selectedBreakoutBonus ? " + breakout bonus" : ""} | EMA9/21 timing ${emaTiming.available ? `${emaTiming.emaTimingScore.toFixed(2)}/2` : "Unavailable"}`
        : failedGateName || "Hard-gate evaluation unavailable";

      const gates = {
        gate1_volume: { passed: gate1, valueDisplay: formatScannerTurnover(ticker.turnover24h), detail: gate1 ? ">= $25M turnover" : "Below $25M" },
        gate2_trend: { passed: gate2, valueDisplay: trend15m, detail: gate2 ? "EMA50/EMA200 and confirmed price-side aligned" : "Trend or EMA50 price-side mismatch" },
        gate3_spread: { passed: gate3, valueDisplay: Number.isFinite(spreadPcnt) ? `${spreadPcnt.toFixed(3)}%` : "—", detail: gate3 ? "Fresh spread <= 0.08%" : "Spread too wide/unavailable" },
        gate4_atr: { passed: gate4, valueDisplay: `${atrPcnt.toFixed(2)}%`, detail: gate4 ? "ATR inside 0.30%-1.20%" : "ATR outside strict band" },
        gate5_oi: { passed: gate5, valueDisplay: oiMetric.available && oiChange !== null ? `${oiChange >= 0 ? "+" : ""}${oiChange.toFixed(2)}%` : "—", detail: gate5 ? "1h OI expansion >= +0.50%" : "OI expansion insufficient/unavailable" },
        gate6_rsi: { passed: gate6.rsiPassed, valueDisplay: `${currentRsi.toFixed(1)} (${rsiZone5m})`, detail: gate6.rsiDetail },
        gate6_candle: { passed: gate6.candlePassed, valueDisplay: entryCandleDirection, detail: gate6.candleDetail },
        gate6FailureReason: gate6.failureReason,
        passedAll,
        failedGateNumber,
        failedGateName,
      };

      return {
        symbol, price: confirmed5mPrice, lastPrice: confirmed5mPrice,
        turnover24h: ticker.turnover24h, volume24h: ticker.volume24h, price24hPcnt: ticker.price24hPcnt,
        highPrice24h: ticker.highPrice24h, lowPrice24h: ticker.lowPrice24h, bidPrice: bid, askPrice: ask,
        rsi: currentRsi, rsiZone5m, ema50, ema200,
        ema9: emaTiming.ema9, ema21: emaTiming.ema21, ema9Above21: emaTiming.ema9Above21,
        ema9Slope: emaTiming.ema9Slope, ema21Slope: emaTiming.ema21Slope, freshCross: emaTiming.freshCross,
        crossoverAgeCandles: emaTiming.crossoverAgeCandles, emaTimingScore: emaTiming.emaTimingScore,
        emaTimingState: emaTiming.timingState, emaTimingChoppy: emaTiming.choppy, finalSetupScore,
        trend: trend15m === "Bullish HTF" ? "Bullish" : trend15m === "Bearish HTF" ? "Bearish" : "Neutral",
        trend15m, spreadPcnt, atr: currentAtr, atrPcnt, oiAvailable: oiMetric.available,
        oiPositive: gate5, oiChangePercent: oiChange ?? undefined, breakoutBonus: selectedBreakoutBonus,
        entryCandleDirection, gatePassed, gates,
        executionEligibility: buildExecutionEligibility({ gateCandidate: passedAll, botRunning: false, activePositionsCount: this.executor.activePositions.length, maxConcurrent: this.maxConcurrent, blockReason: passedAll ? "Execution eligibility pending" : failedGateName }),
        signal, signalReason, lastScannedAt: Date.now(),
      };
    } catch (err: any) {
      this.emitter.log(`[Scanner] ${symbol} evaluation unavailable: ${err?.message || err}`);
      return null;
    }
  }

  private async attachExecutionEligibility(items: ScannedMarketItem[]) {
    for (const item of items) {
      if (!item.gates.passedAll) continue;
      const botRunning = this.executor.getIsRunning();
      if (!botRunning || this.executor.activePositions.length >= this.maxConcurrent) {
        item.executionEligibility = buildExecutionEligibility({ gateCandidate: true, botRunning, activePositionsCount: this.executor.activePositions.length, maxConcurrent: this.maxConcurrent });
        continue;
      }
      const side: "Buy" | "Sell" = item.signal === "SELL_SIGNAL" ? "Sell" : "Buy";
      const baseNotional = (this.executor.settings?.positionMarginUsdt ?? 50) * (this.executor.settings?.leverage ?? 10);
      const check = await this.executor.checkScannerExecutionEligibility(item.symbol, side, baseNotional);
      item.executionEligibility = buildExecutionEligibility({
        gateCandidate: true,
        botRunning,
        activePositionsCount: this.executor.activePositions.length,
        maxConcurrent: this.maxConcurrent,
        riskAllowed: check.riskEligible,
        preOrderAllowed: check.preOrderValid,
        blockReason: check.reason || null,
      });
    }
  }

  private async handleAutoTradeTriggers(candidates: ScannedMarketItem[]) {
    for (const item of candidates) {
      if (this.executor.activePositions.length >= this.maxConcurrent) {
        item.executionEligibility = buildExecutionEligibility({ gateCandidate: true, botRunning: this.executor.getIsRunning(), activePositionsCount: this.executor.activePositions.length, maxConcurrent: this.maxConcurrent });
        continue;
      }
      if (!item.executionEligibility.executableNow) {
        this.emitter.log(`[Scanner] ${item.symbol} candidate not executable: ${item.executionEligibility.blockReason || "execution eligibility blocked"}`);
        continue;
      }
      const side: "Buy" | "Sell" = item.signal === "SELL_SIGNAL" ? "Sell" : "Buy";
      const price = item.price;
      this.emitter.log(`⚡ [Strict Scanner] ${side === "Buy" ? "LONG" : "SHORT"} ${item.symbol} | Slot ${this.executor.activePositions.length + 1}/${this.maxConcurrent} | RSI ${item.rsi.toFixed(1)} | EMA timing ${item.emaTimingScore?.toFixed(2) ?? "N/A"}/2 | Setup ${item.finalSetupScore?.toFixed(2) ?? "N/A"}`);
      const result = await this.executor.executeScannerEntry(item.symbol, side, price, item.ema50, item.ema200, item.rsi, {
        atr: item.atr, atrPercent: item.atrPcnt, oiExpansionPercent: item.oiChangePercent, spreadPercent: item.spreadPcnt,
        trendState: item.trend15m, breakoutBonus: item.breakoutBonus, entryCandleDirection: item.entryCandleDirection,
        ema9: item.ema9, ema21: item.ema21, ema9Above21: item.ema9Above21, ema9Slope: item.ema9Slope,
        ema21Slope: item.ema21Slope, freshCross: item.freshCross, crossoverAgeCandles: item.crossoverAgeCandles,
        emaTimingScore: item.emaTimingScore, finalSetupScore: item.finalSetupScore, emaTimingState: item.emaTimingState,
        emaTimingChoppy: item.emaTimingChoppy,
      });
      if (result.success) this.telegram.sendScannerSignal(item.symbol, side === "Buy" ? "LONG" : "SHORT", price, item.rsi, item.ema9, item.ema21, item.freshCross, item.crossoverAgeCandles, item.emaTimingScore, item.finalSetupScore, true);
      else item.executionEligibility = { ...item.executionEligibility, executableNow: false, blockReason: result.message };
    }
  }

  public setAutoTrade(enabled: boolean) {
    this.autoTrade = enabled;
    this.emitter.log(`[Scanner] Auto-Trade set to ${enabled ? "ON" : "OFF"}`);
    this.emitter.updateScanner(this.getState());
  }

  public setMaxConcurrent(count: number) {
    this.maxConcurrent = Math.max(1, Math.min(3, count));
    this.emitter.log(`[Scanner] Max concurrent trades enforced at ${this.maxConcurrent}`);
    this.emitter.updateScanner(this.getState());
  }

  public getState(): ScannerState {
    return { markets: this.scannedItems, autoTrade: this.autoTrade, maxConcurrent: this.maxConcurrent, isScanning: this.isScanning, lastScanTime: this.lastScanTime, topSymbols: this.topSymbols };
  }

  public getPipelineState(): PipelineState {
    return buildPipelineStateFromMarkets(this.scannedItems, this.isScanning, this.lastScanTime);
  }
}
