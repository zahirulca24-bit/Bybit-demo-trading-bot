import { RestClientV5 } from "bybit-api";
import { EMA, RSI, ATR } from "technicalindicators";
import { WebSocketEmitter } from "./TradingEngine";
import { TelegramNotifier } from "./TelegramNotifier";
import { ScannedMarketItem, ScannerState } from "../types";

export interface ScannerTradeExecutor {
  getIsRunning: () => boolean;
  activePositions: any[];
  currentPrices: Record<string, number>;
  settings?: { maxPositions?: number };
  canOpenSymbol: (symbol: string) => Promise<{ allowed: boolean; reason?: string }>;
  executeScannerEntry: (
    symbol: string,
    side: "Buy" | "Sell",
    currentPrice: number,
    ema50: number,
    ema200: number,
    rsi: number
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

  private tickerCache: Map<string, any> = new Map();
  private scanTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

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
  ) {}

  public async init() {
    this.emitter.log("📡 [Market Scanner] Starting strict 6-gate market scanner...");
    await this.discoverTopMarkets();
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = setInterval(() => void this.discoverTopMarkets(), 30 * 60 * 1000);
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = setInterval(() => void this.scanMarkets(), this.scanIntervalSec * 1000);
    setTimeout(() => void this.scanMarkets(), 1500);
  }

  public async discoverTopMarkets(): Promise<string[]> {
    try {
      const res = await this.bybit.getTickers({ category: "linear" });
      if (res.retCode !== 0 || !res.result?.list) return this.topSymbols;
      const valid = res.result.list
        .filter((item: any) => {
          const symbol = String(item.symbol || "");
          const turnover = Number(item.turnover24h || 0);
          const price = Number(item.lastPrice || 0);
          return symbol.endsWith("USDT") && !symbol.includes("-") && price > 0 && turnover >= this.minTurnover;
        })
        .sort((a: any, b: any) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0));
      this.tickerCache.clear();
      for (const item of valid) this.tickerCache.set(item.symbol, this.normalizeTicker(item));
      const top20 = valid.slice(0, 20).map((item: any) => item.symbol);
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
      const newItems: ScannedMarketItem[] = [];
      for (let i = 0; i < this.topSymbols.length; i += 5) {
        const results = await Promise.all(this.topSymbols.slice(i, i + 5).map((symbol) => this.evaluateSingleSymbol(symbol)));
        for (const item of results) if (item) newItems.push(item);
      }
      newItems.sort((a, b) => {
        const rank = (s: string) => s === "BUY_SIGNAL" || s === "SELL_SIGNAL" ? 0 : s === "IN_POSITION" ? 1 : 2;
        const diff = rank(a.signal) - rank(b.signal);
        return diff !== 0 ? diff : b.turnover24h - a.turnover24h;
      });
      this.scannedItems = newItems;
      this.lastScanTime = Date.now();
      this.emitter.updateScanner(this.getState());
      const tradeSignals = newItems.filter((item) => item.signal === "BUY_SIGNAL" || item.signal === "SELL_SIGNAL");
      if (tradeSignals.length > 0) this.emitter.log(`🚀 [Strict Scanner] ${tradeSignals.length} Grade-A signal(s): ${tradeSignals.map((s) => `${s.symbol}:${s.signal}`).join(", ")}`);
      if (this.autoTrade && this.executor.getIsRunning()) await this.handleAutoTradeTriggers(tradeSignals);
    } catch (err: any) {
      this.emitter.log(`⚠️ [Market Scanner] Scan error: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
    return this.scannedItems;
  }

  private async evaluateSingleSymbol(symbol: string): Promise<ScannedMarketItem | null> {
    try {
      const tickerRes = await this.bybit.getTickers({ category: "linear", symbol });
      const rawTicker = tickerRes.result?.list?.[0];
      if (tickerRes.retCode !== 0 || !rawTicker) return null;
      const ticker = this.normalizeTicker(rawTicker);
      this.tickerCache.set(symbol, ticker);
      this.executor.currentPrices[symbol] = ticker.lastPrice;
      let gatePassed = ticker.turnover24h >= this.minTurnover ? 1 : 0;

      const [kline15mRes, kline5mRes, oiMetric] = await Promise.all([
        this.bybit.getKline({ category: "linear", symbol, interval: "15", limit: 210 }),
        this.bybit.getKline({ category: "linear", symbol, interval: "5", limit: 80 }),
        this.getOpenInterestDelta(symbol),
      ]);
      if (kline15mRes.retCode !== 0 || !kline15mRes.result?.list || kline5mRes.retCode !== 0 || !kline5mRes.result?.list) return null;
      const closed15m = this.closedCandles(kline15mRes.result.list, 15 * 60 * 1000);
      const closed5m = this.closedCandles(kline5mRes.result.list, 5 * 60 * 1000);
      if (closed15m.length < 200 || closed5m.length < 30) return null;

      const closes15m = closed15m.map((k: any) => Number(k[4]));
      const ema50List = EMA.calculate({ period: 50, values: closes15m });
      const ema200List = EMA.calculate({ period: 200, values: closes15m });
      if (!ema50List.length || !ema200List.length) return null;
      const ema50 = ema50List[ema50List.length - 1];
      const ema200 = ema200List[ema200List.length - 1];
      const confirmed15mPrice = closes15m[closes15m.length - 1];
      let trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral HTF" = "Neutral HTF";
      if (ema50 > ema200 && confirmed15mPrice > ema50) trend15m = "Bullish HTF";
      else if (ema50 < ema200 && confirmed15mPrice < ema50) trend15m = "Bearish HTF";
      if (gatePassed === 1 && trend15m !== "Neutral HTF") gatePassed = 2;

      const bid = ticker.bid1Price;
      const ask = ticker.ask1Price;
      const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : 0;
      const spreadPcnt = mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY;
      if (gatePassed === 2 && spreadPcnt <= this.maxSpreadPercent) gatePassed = 3;

      const highs5m = closed5m.map((k: any) => Number(k[2]));
      const lows5m = closed5m.map((k: any) => Number(k[3]));
      const closes5m = closed5m.map((k: any) => Number(k[4]));
      const confirmed5mPrice = closes5m[closes5m.length - 1];
      const atrList = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m });
      const rsiList = RSI.calculate({ period: 14, values: closes5m });
      if (!atrList.length || !rsiList.length || !confirmed5mPrice) return null;
      const atrPcnt = (atrList[atrList.length - 1] / confirmed5mPrice) * 100;
      if (gatePassed === 3 && atrPcnt >= this.minAtrPercent && atrPcnt <= this.maxAtrPercent) gatePassed = 4;
      const oiPositive = oiMetric.available && oiMetric.changePercent >= this.minOiExpansionPercent;
      if (gatePassed === 4 && oiPositive) gatePassed = 5;

      const currentRsi = rsiList[rsiList.length - 1];
      let signal: ScannedMarketItem["signal"] = "WAITING";
      let signalReason = `Rejected at Gate ${Math.min(gatePassed + 1, 6)}`;
      const previousCandle = closed5m[closed5m.length - 2];
      const latestCandle = closed5m[closed5m.length - 1];
      const previousClose = Number(previousCandle?.[4] || 0);
      const latestOpen = Number(latestCandle?.[1] || 0);
      const latestClose = Number(latestCandle?.[4] || 0);
      const longSoftConfirmed = latestClose > previousClose && latestClose > latestOpen;
      const shortSoftConfirmed = latestClose < previousClose && latestClose < latestOpen;
      const breakoutBonusLong = latestClose > Number(previousCandle?.[2] || 0);
      const breakoutBonusShort = latestClose < Number(previousCandle?.[3] || 0);

      if (gatePassed === 5 && trend15m === "Bullish HTF" && currentRsi >= 52 && currentRsi <= 62 && longSoftConfirmed) {
        gatePassed = 6;
        signal = "BUY_SIGNAL";
        signalReason = `Grade A Long: RSI ${currentRsi.toFixed(1)} | bullish close confirmation${breakoutBonusLong ? " + breakout bonus" : ""}`;
      } else if (gatePassed === 5 && trend15m === "Bearish HTF" && currentRsi >= 38 && currentRsi <= 48 && shortSoftConfirmed) {
        gatePassed = 6;
        signal = "SELL_SIGNAL";
        signalReason = `Grade A Short: RSI ${currentRsi.toFixed(1)} | bearish close confirmation${breakoutBonusShort ? " + breakdown bonus" : ""}`;
      }

      const inPosition = this.executor.activePositions.some((p) => p.symbol === symbol && Number(p.size || 0) > 0);
      if (inPosition) {
        signal = "IN_POSITION";
        signalReason = "Same-symbol position already open; duplicate entry blocked";
      }

      return {
        symbol,
        price: confirmed5mPrice,
        lastPrice: confirmed5mPrice,
        turnover24h: ticker.turnover24h,
        volume24h: ticker.volume24h,
        price24hPcnt: ticker.price24hPcnt,
        highPrice24h: ticker.highPrice24h,
        lowPrice24h: ticker.lowPrice24h,
        rsi: currentRsi,
        ema9: ema50,
        ema21: ema200,
        trend: trend15m === "Bullish HTF" ? "Bullish" : trend15m === "Bearish HTF" ? "Bearish" : "Neutral",
        trend15m,
        spreadPcnt,
        atrPcnt,
        oiPositive,
        gatePassed,
        signal,
        signalReason,
        lastScannedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async handleAutoTradeTriggers(signals: ScannedMarketItem[]) {
    for (const item of signals) {
      const risk = await this.executor.canOpenSymbol(item.symbol);
      if (!risk.allowed) {
        this.emitter.log(`[Scanner] ${item.symbol} skipped: ${risk.reason || "risk rule blocked entry"}`);
        continue;
      }
      const side: "Buy" | "Sell" = item.signal === "SELL_SIGNAL" ? "Sell" : "Buy";
      const price = item.price || item.lastPrice;
      this.emitter.log(`⚡ [Strict Scanner] ${side === "Buy" ? "LONG" : "SHORT"} ${item.symbol} | Slot ${this.executor.activePositions.length + 1}/${this.executor.settings?.maxPositions || 3} | RSI ${item.rsi.toFixed(1)}`);
      const result = await this.executor.executeScannerEntry(item.symbol, side, price, item.ema9, item.ema21, item.rsi);
      if (result.success) this.telegram.sendScannerSignal(item.symbol, price, item.rsi, item.ema9, item.ema21, true);
    }
  }

  private async getOpenInterestDelta(symbol: string): Promise<{ available: boolean; changePercent: number }> {
    try {
      const res: any = await (this.bybit as any).getOpenInterest({ category: "linear", symbol, intervalTime: "1h", limit: 2 });
      if (res?.retCode !== 0 || !res?.result?.list || res.result.list.length < 2) return { available: false, changePercent: 0 };
      const rows = [...res.result.list].sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));
      const previous = Number(rows[rows.length - 2].openInterest || 0);
      const current = Number(rows[rows.length - 1].openInterest || 0);
      if (!(previous > 0) || !(current > 0)) return { available: false, changePercent: 0 };
      return { available: true, changePercent: ((current - previous) / previous) * 100 };
    } catch {
      return { available: false, changePercent: 0 };
    }
  }

  private closedCandles(list: any[], intervalMs: number): any[] {
    const now = Date.now();
    return [...list].reverse().filter((c: any) => Number(c[0]) + intervalMs <= now);
  }

  private normalizeTicker(item: any) {
    return {
      lastPrice: Number(item.lastPrice || 0),
      turnover24h: Number(item.turnover24h || 0),
      volume24h: Number(item.volume24h || 0),
      price24hPcnt: Number(item.price24hPcnt || 0) * 100,
      highPrice24h: Number(item.highPrice24h || 0),
      lowPrice24h: Number(item.lowPrice24h || 0),
      bid1Price: Number(item.bid1Price || 0),
      ask1Price: Number(item.ask1Price || 0),
    };
  }

  public setAutoTrade(enabled: boolean) {
    this.autoTrade = enabled;
    this.emitter.log(`[Scanner] Auto-Trade set to ${enabled ? "ON" : "OFF"}`);
    this.emitter.updateScanner(this.getState());
  }

  public setMaxConcurrent(count: number) {
    this.maxConcurrent = Math.max(1, Math.min(3, count));
    this.emitter.log(`[Scanner] Max concurrent trades capped at ${this.maxConcurrent}`);
    this.emitter.updateScanner(this.getState());
  }

  public getState(): ScannerState {
    return {
      markets: this.scannedItems,
      autoTrade: this.autoTrade,
      maxConcurrent: this.maxConcurrent,
      isScanning: this.isScanning,
      lastScanTime: this.lastScanTime,
      topSymbols: this.topSymbols,
    };
  }
}
