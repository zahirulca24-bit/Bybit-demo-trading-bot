import { RestClientV5 } from "bybit-api";
import { EMA, RSI, ATR } from "technicalindicators";
import { PipelineScannedSymbol, PipelineState, PipelineGateSummary, GateResultSummary, RsiZone5m } from "../types";

type Trend15m = "Bullish HTF" | "Bearish HTF" | "Neutral";
type OiMetric = { oi: number; oiChange1h: number; timestamp: number; available: boolean };

export class SixGateFilteringPipeline {
  public state: PipelineState = {
    totalDiscovered: 0,
    passedAllCount: 0,
    activeSignalsCount: 0,
    gates: [
      { gateNumber: 1, name: "24h Volume / Turnover", ruleDescription: "Min $25M 24h turnover", status: "Passed", inputCount: 0, passCount: 0, passRatePercent: 100 },
      { gateNumber: 2, name: "15m HTF Trend Structure (EMA 50/200)", ruleDescription: "EMA direction must match and price must be on the correct side of EMA50", status: "Filtering", inputCount: 0, passCount: 0, passRatePercent: 100 },
      { gateNumber: 3, name: "Orderbook Spread", ruleDescription: "Fresh bid-ask spread <= 0.08%", status: "Filtering", inputCount: 0, passCount: 0, passRatePercent: 100 },
      { gateNumber: 4, name: "5m Volatility (ATR)", ruleDescription: "Confirmed 5m ATR between 0.30% and 1.20%", status: "Filtering", inputCount: 0, passCount: 0, passRatePercent: 100 },
      { gateNumber: 5, name: "Open Interest (OI)", ruleDescription: "Real Bybit 1h OI expansion >= +0.50%", status: "Filtering", inputCount: 0, passCount: 0, passRatePercent: 100 },
      { gateNumber: 6, name: "5m RSI + Candle Confirmation", ruleDescription: "Long RSI 50-64 / Short RSI 36-50 on confirmed candle; breakout is bonus only", status: "Active", inputCount: 0, passCount: 0, passRatePercent: 100 },
    ],
    symbols: [],
    lastScanTimestamp: 0,
    isScanning: false,
  };

  private oiCache = new Map<string, OiMetric>();
  private scanIntervalTimer: NodeJS.Timeout | null = null;
  private readonly minTurnover = 25_000_000;
  private readonly maxSpreadPercent = 0.08;
  private readonly minAtrPercent = 0.30;
  private readonly maxAtrPercent = 1.20;
  private readonly minOiExpansionPercent = 0.50;
  private readonly oiCacheMs = 3 * 60 * 1000;

  constructor(private bybit: RestClientV5) {}

  public start() {
    void this.executePipelineScan();
    if (this.scanIntervalTimer) clearInterval(this.scanIntervalTimer);
    this.scanIntervalTimer = setInterval(() => void this.executePipelineScan(), 15_000);
  }

  public stop() {
    if (this.scanIntervalTimer) clearInterval(this.scanIntervalTimer);
    this.scanIntervalTimer = null;
  }

  public getState(): PipelineState { return this.state; }

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
          const symbol = String(item.symbol || "");
          const turnover = Number(item.turnover24h || 0);
          const price = Number(item.lastPrice || 0);
          return symbol.endsWith("USDT") && !symbol.includes("-") && price > 0 && turnover >= this.minTurnover;
        })
        .sort((a: any, b: any) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0))
        .slice(0, 40);

      const scanned: PipelineScannedSymbol[] = [];
      for (let i = 0; i < validPairs.length; i += 5) {
        const batch = await Promise.all(validPairs.slice(i, i + 5).map((ticker: any) => this.evaluateSymbol(ticker)));
        for (const item of batch) if (item) scanned.push(item);
      }

      const g1 = scanned.filter((s) => s.gates.gate1_volume.passed);
      const g2 = g1.filter((s) => s.gates.gate2_trend.passed);
      const g3 = g2.filter((s) => s.gates.gate3_spread.passed);
      const g4 = g3.filter((s) => s.gates.gate4_atr.passed);
      const g5 = g4.filter((s) => s.gates.gate5_oi.passed);
      const g6 = g5.filter((s) => s.gates.gate6_rsi.passed);

      const gates: PipelineGateSummary[] = [
        this.summary(1, "24h Volume / Turnover", "Min $25M 24h turnover", scanned.length, g1.length, "Passed"),
        this.summary(2, "15m HTF Trend Structure (EMA 50/200)", "EMA direction + price side of EMA50", g1.length, g2.length),
        this.summary(3, "Orderbook Spread", "Fresh spread <= 0.08%", g2.length, g3.length),
        this.summary(4, "5m Volatility (ATR)", "Confirmed ATR 0.30%-1.20%", g3.length, g4.length),
        this.summary(5, "Open Interest (OI)", "Real 1h OI expansion >= +0.50%", g4.length, g5.length),
        this.summary(6, "5m RSI + Candle Confirmation", "Long 50-64 / Short 36-50; breakout bonus only", g5.length, g6.length, g6.length > 0 ? "Active" : "Filtering"),
      ];

      scanned.sort((a, b) => {
        if (a.gates.passedAll !== b.gates.passedAll) return a.gates.passedAll ? -1 : 1;
        return (b.gates.failedGateNumber ?? 7) - (a.gates.failedGateNumber ?? 7) || b.turnover24h - a.turnover24h;
      });

      this.state = {
        totalDiscovered: scanned.length,
        passedAllCount: g6.length,
        activeSignalsCount: g6.length,
        gates,
        symbols: scanned.slice(0, 20),
        lastScanTimestamp: Date.now(),
        isScanning: false,
      };
      return this.state;
    } catch (err: any) {
      console.error("[Pipeline] Pipeline execution error:", err?.message || err);
      this.state.isScanning = false;
      return this.state;
    }
  }

  private summary(gateNumber: number, name: string, ruleDescription: string, inputCount: number, passCount: number, forcedStatus?: "Passed" | "Filtering" | "Active"): PipelineGateSummary {
    return {
      gateNumber,
      name,
      ruleDescription,
      status: forcedStatus || (inputCount > 0 && inputCount === passCount ? "Passed" : "Filtering"),
      inputCount,
      passCount,
      passRatePercent: inputCount > 0 ? Math.round((passCount / inputCount) * 100) : 100,
    };
  }

  private async evaluateSymbol(ticker: any): Promise<PipelineScannedSymbol | null> {
    try {
      const symbol = String(ticker.symbol || "");
      const turnover24h = Number(ticker.turnover24h || 0);
      if (!symbol) return null;

      const [k15, k5, oi] = await Promise.all([
        this.bybit.getKline({ category: "linear", symbol, interval: "15", limit: 210 }).catch(() => null),
        this.bybit.getKline({ category: "linear", symbol, interval: "5", limit: 80 }).catch(() => null),
        this.getOpenInterestMetrics(symbol),
      ]);
      if (!k15 || k15.retCode !== 0 || !k15.result?.list || !k5 || k5.retCode !== 0 || !k5.result?.list) return null;

      const closed15 = this.closedCandles(k15.result.list, 15 * 60 * 1000);
      const closed5 = this.closedCandles(k5.result.list, 5 * 60 * 1000);
      if (closed15.length < 200 || closed5.length < 30) return null;

      const closes15 = closed15.map((c: any) => Number(c[4]));
      const ema50s = EMA.calculate({ period: 50, values: closes15 });
      const ema200s = EMA.calculate({ period: 200, values: closes15 });
      if (!ema50s.length || !ema200s.length) return null;
      const ema50 = ema50s[ema50s.length - 1];
      const ema200 = ema200s[ema200s.length - 1];
      const confirmed15Price = closes15[closes15.length - 1];
      let trend15m: Trend15m = "Neutral";
      if (ema50 > ema200 && confirmed15Price > ema50) trend15m = "Bullish HTF";
      else if (ema50 < ema200 && confirmed15Price < ema50) trend15m = "Bearish HTF";
      const isTrend15mValid = trend15m !== "Neutral";

      const bid = Number(ticker.bid1Price || 0);
      const ask = Number(ticker.ask1Price || 0);
      const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : 0;
      const spreadPercent = mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY;
      const isSpreadValid = Number.isFinite(spreadPercent) && spreadPercent <= this.maxSpreadPercent;

      const highs5 = closed5.map((c: any) => Number(c[2]));
      const lows5 = closed5.map((c: any) => Number(c[3]));
      const closes5 = closed5.map((c: any) => Number(c[4]));
      const latest = closed5[closed5.length - 1];
      const previous = closed5[closed5.length - 2];
      const confirmedPrice = Number(latest[4]);
      const atrs = ATR.calculate({ period: 14, high: highs5, low: lows5, close: closes5 });
      const rsis = RSI.calculate({ period: 14, values: closes5 });
      if (!atrs.length || !rsis.length || !(confirmedPrice > 0)) return null;
      const currentAtr = atrs[atrs.length - 1];
      const atr5mPercent = (currentAtr / confirmedPrice) * 100;
      const isAtrValid = atr5mPercent >= this.minAtrPercent && atr5mPercent <= this.maxAtrPercent;
      const isOiValid = oi.available && oi.oiChange1h >= this.minOiExpansionPercent;

      const currentRsi = Number(rsis[rsis.length - 1].toFixed(1));
      const latestOpen = Number(latest[1]);
      const latestClose = Number(latest[4]);
      const previousClose = Number(previous[4]);
      const longConfirm = latestClose > previousClose && latestClose > latestOpen;
      const shortConfirm = latestClose < previousClose && latestClose < latestOpen;
      const breakoutLong = latestClose > Number(previous[2]);
      const breakoutShort = latestClose < Number(previous[3]);

      let rsiZone5m: RsiZone5m = "Neutral";
      let isRsi5mValid = false;
      if (trend15m === "Bullish HTF" && currentRsi >= 50 && currentRsi <= 64 && longConfirm) {
        rsiZone5m = "Long (50-64)";
        isRsi5mValid = true;
      } else if (trend15m === "Bearish HTF" && currentRsi >= 36 && currentRsi <= 50 && shortConfirm) {
        rsiZone5m = "Short (36-50)";
        isRsi5mValid = true;
      } else if (currentRsi > 64) rsiZone5m = "Overbought (>64)";
      else if (currentRsi < 36) rsiZone5m = "Oversold (<36)";

      const isVolumeValid = turnover24h >= this.minTurnover;
      let failedGateNumber: number | null = null;
      let failedGateName: string | null = null;
      if (!isVolumeValid) { failedGateNumber = 1; failedGateName = "Gate 1: Turnover below $25M"; }
      else if (!isTrend15mValid) { failedGateNumber = 2; failedGateName = "Gate 2: EMA trend / EMA50 price-side mismatch"; }
      else if (!isSpreadValid) { failedGateNumber = 3; failedGateName = "Gate 3: Spread above 0.08% or unavailable"; }
      else if (!isAtrValid) { failedGateNumber = 4; failedGateName = "Gate 4: ATR outside 0.30%-1.20%"; }
      else if (!isOiValid) { failedGateNumber = 5; failedGateName = "Gate 5: OI expansion below +0.50% or unavailable"; }
      else if (!isRsi5mValid) { failedGateNumber = 6; failedGateName = "Gate 6: RSI/candle confirmation out of range"; }
      const passedAll = failedGateNumber === null;

      const gateResults: GateResultSummary = {
        gate1_volume: { passed: isVolumeValid, valueDisplay: this.formatTurnover(turnover24h), detail: isVolumeValid ? ">= $25M turnover" : "Below $25M" },
        gate2_trend: { passed: isTrend15mValid, valueDisplay: trend15m, detail: isTrend15mValid ? "EMA50/EMA200 and price-side aligned" : "Trend or EMA50 price-side mismatch" },
        gate3_spread: { passed: isSpreadValid, valueDisplay: Number.isFinite(spreadPercent) ? `${spreadPercent.toFixed(3)}%` : "N/A", detail: isSpreadValid ? "Fresh spread <= 0.08%" : "Spread too wide/unavailable" },
        gate4_atr: { passed: isAtrValid, valueDisplay: `${atr5mPercent.toFixed(2)}%`, detail: isAtrValid ? "ATR inside 0.30%-1.20%" : "ATR outside strict band" },
        gate5_oi: { passed: isOiValid, valueDisplay: oi.available ? `${oi.oiChange1h >= 0 ? "+" : ""}${oi.oiChange1h.toFixed(2)}%` : "N/A", detail: isOiValid ? "1h OI expansion >= +0.50%" : "OI expansion insufficient/unavailable" },
        gate6_rsi: { passed: isRsi5mValid, valueDisplay: `${currentRsi.toFixed(1)} (${rsiZone5m})`, detail: isRsi5mValid ? (trend15m === "Bullish HTF" ? (breakoutLong ? "Bullish confirm + breakout bonus" : "Bullish close confirm") : (breakoutShort ? "Bearish confirm + breakdown bonus" : "Bearish close confirm")) : "RSI or directional candle confirmation failed" },
        passedAll,
        failedGateNumber,
        failedGateName,
      };

      let signalAction: "Grade A Long" | "Grade A Short" | "Standby" = "Standby";
      let actionType: "LONG" | "SHORT" | "STANDBY" = "STANDBY";
      if (passedAll && trend15m === "Bullish HTF") { signalAction = "Grade A Long"; actionType = "LONG"; }
      else if (passedAll && trend15m === "Bearish HTF") { signalAction = "Grade A Short"; actionType = "SHORT"; }

      return {
        symbol,
        price: confirmedPrice,
        turnover24h,
        turnoverFormatted: this.formatTurnover(turnover24h),
        ema50_15m: ema50,
        ema200_15m: ema200,
        trend15m,
        isTrend15mValid,
        bidPrice: bid,
        askPrice: ask,
        spreadPercent,
        isSpreadValid,
        atr5m: currentAtr,
        atr5mPercent,
        isAtrValid,
        openInterest: oi.oi,
        oiChangePercent1h: oi.available ? oi.oiChange1h : 0,
        oiAvailable: oi.available,
        isOiValid,
        rsi14_5m: currentRsi,
        rsiZone5m,
        isRsi5mValid,
        gates: gateResults,
        pipelineStatus: passedAll ? "Passed All 6 Gates" : `Blocked at Gate ${failedGateNumber}`,
        signalAction,
        actionType,
        lastUpdated: Date.now(),
      };
    } catch (err: any) {
      console.warn(`[Pipeline] ${err?.message || err}`);
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
      const previous = Number(rows[rows.length - 2].openInterest || 0);
      const current = Number(rows[rows.length - 1].openInterest || 0);
      if (!(previous > 0) || !(current > 0)) throw new Error("Invalid OI history");
      const metric: OiMetric = { oi: current, oiChange1h: ((current - previous) / previous) * 100, timestamp: Date.now(), available: true };
      this.oiCache.set(symbol, metric);
      return metric;
    } catch {
      return { oi: 0, oiChange1h: 0, timestamp: Date.now(), available: false };
    }
  }

  private formatTurnover(value?: number): string {
    if (!value || !Number.isFinite(value)) return "$0";
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
    return `$${value.toFixed(0)}`;
  }
}
