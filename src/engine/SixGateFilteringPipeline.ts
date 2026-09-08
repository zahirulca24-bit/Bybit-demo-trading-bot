import { RestClientV5 } from "bybit-api";
import { EMA, RSI, ATR } from "technicalindicators";
import {
  PipelineScannedSymbol,
  PipelineState,
  PipelineGateSummary,
  GateResultSummary,
} from "../types";

type Trend15m = "Bullish HTF" | "Bearish HTF" | "Neutral";

type OiMetric = {
  oi: number;
  oiChange1h: number;
  timestamp: number;
};

export class SixGateFilteringPipeline {
  public state: PipelineState = {
    totalDiscovered: 0,
    passedAllCount: 0,
    activeSignalsCount: 0,
    gates: [
      {
        gateNumber: 1,
        name: "24h Volume / Turnover",
        ruleDescription: "Filters top traded USDT linear perpetuals on Bybit (Min $10M 24h turnover)",
        status: "Passed",
        inputCount: 0,
        passCount: 0,
        passRatePercent: 100,
      },
      {
        gateNumber: 2,
        name: "15m HTF Trend Structure (EMA 50/200)",
        ruleDescription: "Requires confirmed 15m EMA 50 > 200 for Long or EMA 50 < 200 for Short",
        status: "Filtering",
        inputCount: 0,
        passCount: 0,
        passRatePercent: 100,
      },
      {
        gateNumber: 3,
        name: "Orderbook Spread",
        ruleDescription: "Uses the current scan ticker and requires Bid-Ask Spread <= 0.15%",
        status: "Filtering",
        inputCount: 0,
        passCount: 0,
        passRatePercent: 100,
      },
      {
        gateNumber: 4,
        name: "5m Volatility (ATR)",
        ruleDescription: "Requires confirmed-candle 5m ATR >= 0.30% of price",
        status: "Filtering",
        inputCount: 0,
        passCount: 0,
        passRatePercent: 100,
      },
      {
        gateNumber: 5,
        name: "Open Interest (OI)",
        ruleDescription: "Requires real Bybit 1h Open Interest delta >= 0%; no synthetic/pseudo OI values",
        status: "Filtering",
        inputCount: 0,
        passCount: 0,
        passRatePercent: 100,
      },
      {
        gateNumber: 6,
        name: "5m RSI (14) Entry Trigger",
        ruleDescription: "Confirmed 5m candle RSI 50-65 for Long Entry, 35-50 for Short Entry",
        status: "Active",
        inputCount: 0,
        passCount: 0,
        passRatePercent: 100,
      },
    ],
    symbols: [],
    lastScanTimestamp: 0,
    isScanning: false,
  };

  private oiCache: Map<string, OiMetric> = new Map();
  private scanIntervalTimer: NodeJS.Timeout | null = null;

  private readonly minTurnover = 10_000_000;
  private readonly maxSpreadPercent = 0.15;
  private readonly minAtrPercent = 0.3;
  private readonly oiCacheMs = 3 * 60 * 1000;

  constructor(private bybit: RestClientV5) {}

  public start() {
    void this.executePipelineScan();
    if (this.scanIntervalTimer) clearInterval(this.scanIntervalTimer);
    this.scanIntervalTimer = setInterval(() => {
      void this.executePipelineScan();
    }, 15_000);
  }

  public stop() {
    if (this.scanIntervalTimer) {
      clearInterval(this.scanIntervalTimer);
      this.scanIntervalTimer = null;
    }
  }

  public getState(): PipelineState {
    return this.state;
  }

  public async executePipelineScan(): Promise<PipelineState> {
    if (this.state.isScanning) return this.state;
    this.state.isScanning = true;

    try {
      const tickersRes = await this.bybit.getTickers({ category: "linear" });
      if (tickersRes.retCode !== 0 || !tickersRes.result?.list) {
        this.state.isScanning = false;
        return this.state;
      }

      const validPairs = tickersRes.result.list
        .filter((item: any) => {
          const symbol = item.symbol || "";
          const turnover = Number(item.turnover24h || 0);
          const price = Number(item.lastPrice || 0);
          return symbol.endsWith("USDT") && !symbol.includes("-") && price > 0 && turnover >= this.minTurnover;
        })
        .sort((a: any, b: any) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0))
        .slice(0, 40);

      const scannedSymbols: PipelineScannedSymbol[] = [];
      const chunkSize = 5;
      for (let i = 0; i < validPairs.length; i += chunkSize) {
        const results = await Promise.all(validPairs.slice(i, i + chunkSize).map((ticker: any) => this.evaluateSymbolThroughGates(ticker)));
        for (const item of results) if (item) scannedSymbols.push(item);
      }

      const g1Passed = scannedSymbols.filter((s) => s.gates.gate1_volume.passed);
      const g2Passed = g1Passed.filter((s) => s.gates.gate2_trend.passed);
      const g3Passed = g2Passed.filter((s) => s.gates.gate3_spread.passed);
      const g4Passed = g3Passed.filter((s) => s.gates.gate4_atr.passed);
      const g5Passed = g4Passed.filter((s) => s.gates.gate5_oi.passed);
      const g6Passed = g5Passed.filter((s) => s.gates.gate6_rsi.passed);

      const gateSummaries: PipelineGateSummary[] = [
        this.summary(1, "24h Volume / Turnover", "Min $10M 24h turnover", validPairs.length, g1Passed.length, "Passed"),
        this.summary(2, "15m HTF Trend Structure (EMA 50/200)", "Confirmed 15m EMA 50/200 structure", g1Passed.length, g2Passed.length),
        this.summary(3, "Orderbook Spread", "Fresh scan spread <= 0.15%", g2Passed.length, g3Passed.length),
        this.summary(4, "5m Volatility (ATR)", "Confirmed 5m ATR >= 0.30%", g3Passed.length, g4Passed.length),
        this.summary(5, "Open Interest (OI)", "Real Bybit 1h OI delta >= 0%", g4Passed.length, g5Passed.length),
        this.summary(6, "5m RSI (14) Entry Trigger", "Confirmed 5m RSI entry zone", g5Passed.length, g6Passed.length, g6Passed.length > 0 ? "Active" : "Filtering"),
      ];

      scannedSymbols.sort((a, b) => {
        if (a.gates.passedAll && !b.gates.passedAll) return -1;
        if (!a.gates.passedAll && b.gates.passedAll) return 1;
        const aFailed = a.gates.failedGateNumber ?? 7;
        const bFailed = b.gates.failedGateNumber ?? 7;
        if (aFailed !== bFailed) return bFailed - aFailed;
        return b.turnover24h - a.turnover24h;
      });

      this.state = { totalDiscovered: validPairs.length, passedAllCount: g6Passed.length, activeSignalsCount: g6Passed.length, gates: gateSummaries, symbols: scannedSymbols.slice(0, 20), lastScanTimestamp: Date.now(), isScanning: false };
      return this.state;
    } catch (err: any) {
      console.error("[Pipeline] Pipeline execution error:", err?.message || err);
      this.state.isScanning = false;
      return this.state;
    }
  }

  private summary(gateNumber: number, name: string, ruleDescription: string, inputCount: number, passCount: number, forcedStatus?: "Passed" | "Filtering" | "Active"): PipelineGateSummary {
    return { gateNumber, name, ruleDescription, status: forcedStatus || (inputCount > 0 && passCount === inputCount ? "Passed" : "Filtering"), inputCount, passCount, passRatePercent: inputCount > 0 ? Math.round((passCount / inputCount) * 100) : 100 };
  }

  private async evaluateSymbolThroughGates(ticker: any): Promise<PipelineScannedSymbol | null> {
    try {
      const symbol = String(ticker.symbol || "");
      const lastPrice = Number(ticker.lastPrice || 0);
      const turnover24h = Number(ticker.turnover24h || 0);
      if (!symbol || lastPrice <= 0) return null;
      const isVolumeValid = turnover24h >= this.minTurnover;

      const [kline15mRes, kline5mRes, oiMetric] = await Promise.all([
        this.bybit.getKline({ category: "linear", symbol, interval: "15", limit: 210 }).catch(() => null),
        this.bybit.getKline({ category: "linear", symbol, interval: "5", limit: 80 }).catch(() => null),
        this.getOpenInterestMetrics(symbol),
      ]);
      if (!kline15mRes || kline15mRes.retCode !== 0 || !kline15mRes.result?.list || !kline5mRes || kline5mRes.retCode !== 0 || !kline5mRes.result?.list) return null;

      const closed15m = this.closedCandles(kline15mRes.result.list, 15 * 60 * 1000);
      const closed5m = this.closedCandles(kline5mRes.result.list, 5 * 60 * 1000);
      if (closed15m.length < 200 || closed5m.length < 30) return null;

      const closes15m = closed15m.map((c: any) => Number(c[4]));
      const highs5m = closed5m.map((c: any) => Number(c[2]));
      const lows5m = closed5m.map((c: any) => Number(c[3]));
      const closes5m = closed5m.map((c: any) => Number(c[4]));
      const confirmedPrice = closes5m[closes5m.length - 1];
      if (!confirmedPrice || confirmedPrice <= 0) return null;

      const ema50Values = EMA.calculate({ period: 50, values: closes15m });
      const ema200Values = EMA.calculate({ period: 200, values: closes15m });
      if (!ema50Values.length || !ema200Values.length) return null;
      const currentEma50_15m = ema50Values[ema50Values.length - 1];
      const currentEma200_15m = ema200Values[ema200Values.length - 1];
      let trend15m: Trend15m = "Neutral";
      if (currentEma50_15m > currentEma200_15m) trend15m = "Bullish HTF";
      else if (currentEma50_15m < currentEma200_15m) trend15m = "Bearish HTF";
      const isTrend15mValid = trend15m !== "Neutral";

      const bidPrice = Number(ticker.bid1Price || ticker.bidPrice || 0);
      const askPrice = Number(ticker.ask1Price || ticker.askPrice || 0);
      const hasRealBook = bidPrice > 0 && askPrice > 0 && askPrice >= bidPrice;
      const midPrice = hasRealBook ? (bidPrice + askPrice) / 2 : 0;
      const spreadPercent = hasRealBook && midPrice > 0 ? ((askPrice - bidPrice) / midPrice) * 100 : Number.POSITIVE_INFINITY;
      const isSpreadValid = hasRealBook && spreadPercent <= this.maxSpreadPercent;

      const atrValues = ATR.calculate({ high: highs5m, low: lows5m, close: closes5m, period: 14 });
      if (!atrValues.length) return null;
      const currentAtr = atrValues[atrValues.length - 1];
      const atr5mPercent = (currentAtr / confirmedPrice) * 100;
      const isAtrValid = atr5mPercent >= this.minAtrPercent;
      const isOiValid = Number.isFinite(oiMetric.oiChange1h) && oiMetric.oiChange1h >= 0;

      const rsiValues = RSI.calculate({ period: 14, values: closes5m });
      if (!rsiValues.length) return null;
      const currentRsi5m = Number(rsiValues[rsiValues.length - 1].toFixed(1));
      let rsiZone5m: "Long (50-65)" | "Short (35-50)" | "Overbought (>65)" | "Oversold (<35)" | "Neutral" = "Neutral";
      let isRsi5mValid = false;
      if (trend15m === "Bullish HTF") {
        if (currentRsi5m >= 50 && currentRsi5m <= 65) { rsiZone5m = "Long (50-65)"; isRsi5mValid = true; }
        else if (currentRsi5m > 65) rsiZone5m = "Overbought (>65)";
      } else if (trend15m === "Bearish HTF") {
        if (currentRsi5m >= 35 && currentRsi5m <= 50) { rsiZone5m = "Short (35-50)"; isRsi5mValid = true; }
        else if (currentRsi5m < 35) rsiZone5m = "Oversold (<35)";
      }

      let failedGateNumber: number | null = null;
      let failedGateName: string | null = null;
      if (!isVolumeValid) { failedGateNumber = 1; failedGateName = "Gate 1: Low 24h Turnover (<$10M)"; }
      else if (!isTrend15mValid) { failedGateNumber = 2; failedGateName = "Gate 2: 15m HTF Trend Neutral / Choppy"; }
      else if (!isSpreadValid) { failedGateNumber = 3; failedGateName = "Gate 3: Missing/Wide Bid-Ask Spread (>0.15%)"; }
      else if (!isAtrValid) { failedGateNumber = 4; failedGateName = "Gate 4: Low Confirmed 5m Volatility (<0.30% ATR)"; }
      else if (!isOiValid) { failedGateNumber = 5; failedGateName = "Gate 5: Real 1h Open Interest Delta Negative/Unavailable"; }
      else if (!isRsi5mValid) { failedGateNumber = 6; failedGateName = "Gate 6: Confirmed 5m RSI Entry Trigger Out of Range"; }
      const passedAll = failedGateNumber === null;

      let signalAction: "Grade A Long" | "Grade A Short" | "Standby" = "Standby";
      let actionType: "LONG" | "SHORT" | "STANDBY" = "STANDBY";
      if (passedAll && trend15m === "Bullish HTF") { signalAction = "Grade A Long"; actionType = "LONG"; }
      else if (passedAll && trend15m === "Bearish HTF") { signalAction = "Grade A Short"; actionType = "SHORT"; }
      const pipelineStatus = passedAll ? "Passed All 6 Gates" : `Blocked at Gate ${failedGateNumber}`;

      const gateResults: GateResultSummary = {
        gate1_volume: { passed: isVolumeValid, valueDisplay: this.formatTurnover(turnover24h), detail: isVolumeValid ? "High 24h Volume Liquidity" : "Below $10M minimum threshold" },
        gate2_trend: { passed: isTrend15mValid, valueDisplay: trend15m, detail: trend15m === "Bullish HTF" ? "Confirmed 15m EMA 50 > 200" : trend15m === "Bearish HTF" ? "Confirmed 15m EMA 50 < 200" : "No confirmed HTF trend" },
        gate3_spread: { passed: isSpreadValid, valueDisplay: Number.isFinite(spreadPercent) ? `${spreadPercent.toFixed(3)}%` : "N/A", detail: isSpreadValid ? "Fresh tight book (<=0.15%)" : "Book unavailable or spread too wide" },
        gate4_atr: { passed: isAtrValid, valueDisplay: `${atr5mPercent.toFixed(2)}%`, detail: isAtrValid ? "Confirmed 5m ATR >=0.30%" : "Confirmed 5m ATR below 0.30%" },
        gate5_oi: { passed: isOiValid, valueDisplay: Number.isFinite(oiMetric.oiChange1h) ? `${oiMetric.oiChange1h >= 0 ? "+" : ""}${oiMetric.oiChange1h.toFixed(2)}%` : "N/A", detail: isOiValid ? "Real 1h OI inflow/non-negative" : "Real 1h OI negative or unavailable" },
        gate6_rsi: { passed: isRsi5mValid, valueDisplay: `${currentRsi5m.toFixed(1)} (${rsiZone5m})`, detail: isRsi5mValid ? "Confirmed 5m candle in entry zone" : "Confirmed 5m candle outside entry zone" },
        passedAll, failedGateNumber, failedGateName,
      };

      return { symbol, price: confirmedPrice, turnover24h, turnoverFormatted: this.formatTurnover(turnover24h), ema50_15m: currentEma50_15m, ema200_15m: currentEma200_15m, trend15m, isTrend15mValid, bidPrice, askPrice, spreadPercent, isSpreadValid, atr5m: currentAtr, atr5mPercent, isAtrValid, openInterest: oiMetric.oi, oiChangePercent1h: oiMetric.oiChange1h, isOiValid, rsi14_5m: currentRsi5m, rsiZone5m, isRsi5mValid, gates: gateResults, pipelineStatus, signalAction, actionType, lastUpdated: Date.now() };
    } catch (err: any) {
      console.warn(`[Pipeline] Failed to evaluate symbol: ${err?.message || err}`);
      return null;
    }
  }

  private closedCandles(list: any[], intervalMs: number): any[] {
    const now = Date.now();
    return [...list].reverse().filter((c: any) => Number(c[0]) + intervalMs <= now);
  }

  private async getOpenInterestMetrics(symbol: string): Promise<OiMetric> {
    const cached = this.oiCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.oiCacheMs) return cached;
    try {
      const res: any = await (this.bybit as any).getOpenInterest({ category: "linear", symbol, intervalTime: "1h", limit: 2 });
      if (res?.retCode !== 0 || !res?.result?.list || res.result.list.length < 2) throw new Error("Insufficient OI history");
      const rows = [...res.result.list].sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));
      const previousOi = Number(rows[rows.length - 2].openInterest || 0);
      const currentOi = Number(rows[rows.length - 1].openInterest || 0);
      if (!(previousOi > 0) || !(currentOi > 0)) throw new Error("Invalid OI history");
      const metric: OiMetric = { oi: currentOi, oiChange1h: ((currentOi - previousOi) / previousOi) * 100, timestamp: Date.now() };
      this.oiCache.set(symbol, metric);
      return metric;
    } catch (err: any) {
      console.warn(`[Pipeline] OI unavailable for ${symbol}: ${err?.message || err}`);
      return { oi: 0, oiChange1h: Number.NaN, timestamp: Date.now() };
    }
  }

  private formatTurnover(val?: number): string {
    if (!val || val === 0 || isNaN(val)) return "$0";
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
    return `$${val.toFixed(0)}`;
  }
}
