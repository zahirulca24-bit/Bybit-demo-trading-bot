import { RestClientV5 } from "bybit-api";
import { EMA, RSI } from "technicalindicators";
import cron, { ScheduledTask } from "node-cron";

export interface Scanner5mSignal {
  symbol: string;
  timeframe: string;
  candleTime: number;
  price: number;
  side: "LONG" | "SHORT";
  grade: "GRADE_A" | "GRADE_B";
  reason: string;
  technicals: {
    ema50: number;
    ema200: number;
    rsi14: number;
    prevRsi14: number;
    currentVolume: number;
    avgVolume20: number;
    volumeRatio: number;
  };
  timestamp: number;
  alertSent?: boolean;
}

export interface Scanner5mResult {
  symbol: string;
  price: number;
  ema50: number;
  ema200: number;
  rsi: number;
  prevRsi: number;
  currentVolume: number;
  avgVolume20: number;
  volumeRatio: number;
  isVolumeConfirmed: boolean;
  isVolumeModerate: boolean;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  signal: "LONG" | "SHORT" | "NONE";
  grade: "GRADE_A" | "GRADE_B" | "NONE";
  signalReason: string;
  candleTime: number;
}

export class LegacyInformationalScanner5m {
  public symbols: string[] = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "DOGEUSDT",
    "XRPUSDT",
    "BNBUSDT",
    "SUIUSDT",
    "NEARUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "PEPEUSDT",
    "ADAUSDT",
    "APTUSDT",
    "WIFUSDT",
    "LTCUSDT",
  ];

  public lastScanTime: number = 0;
  public isScanning: boolean = false;
  public detectedSignals: Scanner5mSignal[] = [];
  public scanResults: Scanner5mResult[] = [];
  private cronTask: ScheduledTask | null = null;
  private signalCooldownMap: Map<string, number> = new Map();

  constructor(
    private bybit: RestClientV5,
    private onSignalDetected?: (signal: Scanner5mSignal) => void
  ) {}

  public startScheduler() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }

    this.scanAllSymbols();

    this.cronTask = cron.schedule("3 */5 * * * *", async () => {
      console.log(`[Legacy / Informational Scanner] Triggering scan at ${new Date().toISOString()} (3s post-close buffer)`);
      await this.scanAllSymbols();
    });

    console.log("[Legacy / Informational Scanner] Scheduled with pattern '3 */5 * * * *'");
  }

  public stopScheduler() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
  }

  public getScheduleStatus() {
    const now = Date.now();
    const nextFiveMinBoundary = Math.ceil((now + 1) / (5 * 60 * 1000)) * (5 * 60 * 1000);
    let targetNextScan = nextFiveMinBoundary + 3000;
    if (targetNextScan <= now) {
      targetNextScan += 5 * 60 * 1000;
    }

    const timeRemainingSeconds = Math.max(0, Math.round((targetNextScan - now) / 1000));

    return {
      lastScanTime: this.lastScanTime > 0 ? new Date(this.lastScanTime).toISOString() : null,
      nextScanTime: new Date(targetNextScan).toISOString(),
      timeRemainingSeconds,
      activeSignalsCount: this.detectedSignals.length,
      isScanning: this.isScanning,
    };
  }

  public setSymbols(symbols: string[]) {
    if (symbols && symbols.length > 0) {
      this.symbols = symbols.map((s) => s.toUpperCase().trim());
    }
  }

  public async analyzeSymbol5m(symbol: string): Promise<Scanner5mResult | null> {
    try {
      const response = await this.bybit.getKline({
        category: "linear",
        symbol: symbol.toUpperCase(),
        interval: "5",
        limit: 220,
      });

      if (response.retCode !== 0 || !response.result?.list || response.result.list.length < 200) {
        return null;
      }

      const now = Date.now();
      const rawList = [...response.result.list].reverse().filter((c: any) => Number(c[0]) + 5 * 60 * 1000 <= now);

      const closes: number[] = [];
      const volumes: number[] = [];
      const timestamps: number[] = [];

      for (const candle of rawList) {
        timestamps.push(parseInt(candle[0], 10));
        closes.push(parseFloat(candle[4]));
        volumes.push(parseFloat(candle[5]));
      }

      const totalCandles = closes.length;
      if (totalCandles < 200) return null;

      const ema50Values = EMA.calculate({ period: 50, values: closes });
      const ema200Values = EMA.calculate({ period: 200, values: closes });

      const rsiValues = RSI.calculate({ period: 14, values: closes });

      if (ema50Values.length === 0 || rsiValues.length < 2) {
        return null;
      }

      const currentPrice = closes[totalCandles - 1];
      const candleTime = timestamps[totalCandles - 1];

      const currentEma50 = ema50Values[ema50Values.length - 1];
      const prevEma50 = ema50Values.length > 1 ? ema50Values[ema50Values.length - 2] : currentEma50;
      const currentEma200 = ema200Values.length > 0 ? ema200Values[ema200Values.length - 1] : currentEma50;

      const currentRsi = rsiValues[rsiValues.length - 1];
      const prevRsi = rsiValues[rsiValues.length - 2];

      const recentVolumes = volumes.slice(-21, -1);
      const avgVolume20 = recentVolumes.length > 0
        ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
        : volumes[totalCandles - 1];

      const currentVolume = volumes[totalCandles - 1];
      const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;
      const isVolumeConfirmed = volumeRatio >= 1.05;
      const isVolumeModerate = volumeRatio >= 0.85;

      const isBullishTrend = currentPrice > currentEma200;
      const isBearishTrend = currentPrice < currentEma200;
      const trend: "BULLISH" | "BEARISH" | "NEUTRAL" = isBullishTrend
        ? "BULLISH"
        : isBearishTrend
        ? "BEARISH"
        : "NEUTRAL";

      let signal: "LONG" | "SHORT" | "NONE" = "NONE";
      let grade: "GRADE_A" | "GRADE_B" | "NONE" = "NONE";
      let signalReason = "";

      const isLongRsiCross = (prevRsi <= 50 && currentRsi >= 48 && currentRsi <= 68) || (currentRsi >= 50 && currentRsi <= 62 && prevRsi < currentRsi);
      const isLongEmaSupport = currentPrice >= currentEma50 && (currentEma50 >= prevEma50 * 0.9995);

      if (isBullishTrend && isLongEmaSupport && isLongRsiCross) {
        signal = "LONG";
        if (isVolumeConfirmed) {
          grade = "GRADE_A";
          signalReason = `Price > 200 EMA ($${currentEma200.toFixed(2)}), 50 EMA Support ($${currentEma50.toFixed(2)}), RSI (${currentRsi.toFixed(1)}) crossed above 48-50 zone with High Volume (${(volumeRatio * 100).toFixed(0)}% avg).`;
        } else if (isVolumeModerate) {
          grade = "GRADE_B";
          signalReason = `Bullish setup: Price > 200 EMA, RSI (${currentRsi.toFixed(1)}) upward momentum, moderate volume (${(volumeRatio * 100).toFixed(0)}% avg).`;
        }
      }

      const isShortRsiCross = (prevRsi >= 50 && currentRsi <= 52 && currentRsi >= 32) || (currentRsi <= 50 && currentRsi >= 38 && prevRsi > currentRsi);
      const isShortEmaResistance = currentPrice <= currentEma50 && (currentEma50 <= prevEma50 * 1.0005);

      if (isBearishTrend && isShortEmaResistance && isShortRsiCross) {
        signal = "SHORT";
        if (isVolumeConfirmed) {
          grade = "GRADE_A";
          signalReason = `Price < 200 EMA ($${currentEma200.toFixed(2)}), 50 EMA Resistance ($${currentEma50.toFixed(2)}), RSI (${currentRsi.toFixed(1)}) rejected below 50 with High Volume (${(volumeRatio * 100).toFixed(0)}% avg).`;
        } else if (isVolumeModerate) {
          grade = "GRADE_B";
          signalReason = `Bearish setup: Price < 200 EMA, RSI (${currentRsi.toFixed(1)}) downward momentum, moderate volume (${(volumeRatio * 100).toFixed(0)}% avg).`;
        }
      }

      return {
        symbol,
        price: currentPrice,
        ema50: currentEma50,
        ema200: currentEma200,
        rsi: currentRsi,
        prevRsi,
        currentVolume,
        avgVolume20,
        volumeRatio,
        isVolumeConfirmed,
        isVolumeModerate,
        trend,
        signal,
        grade,
        signalReason,
        candleTime,
      };
    } catch (err) {
      return null;
    }
  }

  public async scanAllSymbols(): Promise<Scanner5mResult[]> {
    if (this.isScanning) return this.scanResults;
    this.isScanning = true;
    const results: Scanner5mResult[] = [];

    try {
      const chunkSize = 4;
      for (let i = 0; i < this.symbols.length; i += chunkSize) {
        const batch = this.symbols.slice(i, i + chunkSize);
        const batchPromises = batch.map((sym) => this.analyzeSymbol5m(sym));
        const batchResults = await Promise.all(batchPromises);

        for (const res of batchResults) {
          if (res) {
            results.push(res);

            if (res.signal !== "NONE" && res.grade !== "NONE") {
              this.handleDetectedSignal(res);
            }
          }
        }
      }

      this.scanResults = results;
      this.lastScanTime = Date.now();
      return results;
    } finally {
      this.isScanning = false;
    }
  }

  private handleDetectedSignal(res: Scanner5mResult) {
    const cooldownKey = `${res.symbol}_${res.signal}_${res.candleTime}`;
    const lastTrigger = this.signalCooldownMap.get(cooldownKey) || 0;

    if (Date.now() - lastTrigger < 5 * 60 * 1000) {
      return;
    }
    this.signalCooldownMap.set(cooldownKey, Date.now());

    const signalItem: Scanner5mSignal = {
      symbol: res.symbol,
      timeframe: "5m",
      candleTime: res.candleTime,
      price: res.price,
      side: res.signal as "LONG" | "SHORT",
      grade: res.grade as "GRADE_A" | "GRADE_B",
      reason: res.signalReason,
      technicals: {
        ema50: parseFloat(res.ema50.toFixed(4)),
        ema200: parseFloat(res.ema200.toFixed(4)),
        rsi14: parseFloat(res.rsi.toFixed(2)),
        prevRsi14: parseFloat(res.prevRsi.toFixed(2)),
        currentVolume: parseFloat(res.currentVolume.toFixed(2)),
        avgVolume20: parseFloat(res.avgVolume20.toFixed(2)),
        volumeRatio: parseFloat(res.volumeRatio.toFixed(2)),
      },
      timestamp: Date.now(),
    };

    this.detectedSignals = [signalItem, ...this.detectedSignals.filter(s => s.symbol !== signalItem.symbol || Math.abs(s.timestamp - signalItem.timestamp) > 60000)].slice(0, 30);

    if (this.onSignalDetected) {
      this.onSignalDetected(signalItem);
    }
  }
}
