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
  executeScannerEntry: (
    symbol: string,
    currentPrice: number,
    ema9: number,
    ema21: number,
    rsi: number
  ) => Promise<{ success: boolean; message: string; orderId?: string }>;
}

export class MarketScanner {
  public topSymbols: string[] = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "DOGEUSDT",
    "XRPUSDT",
    "NEARUSDT",
    "SUIUSDT",
    "BNBUSDT",
    "PEPEUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "ADAUSDT",
    "WIFUSDT",
    "APTUSDT",
    "LTCUSDT",
    "SHIBUSDT",
    "TRXUSDT",
    "DOTUSDT",
    "UNIUSDT",
    "OPUSDT",
  ];

  public scannedItems: ScannedMarketItem[] = [];
  public autoTrade: boolean = true;
  public maxConcurrent: number = 2;
  public isScanning: boolean = false;
  public lastScanTime: number = 0;
  public scanIntervalSec: number = 20;

  private tickerCache: Map<string, any> = new Map();

  private cooldownMap: Map<string, number> = new Map();
  private scanTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    private bybit: RestClientV5,
    private emitter: WebSocketEmitter,
    private telegram: TelegramNotifier,
    private executor: ScannerTradeExecutor
  ) {}

  public async init() {
    this.emitter.log("📡 [Market Scanner] Initializing Dynamic Market Ingestion Engine...");
    
    // 1. Initial market discovery
    await this.discoverTopMarkets();

    // 2. Schedule Market Discovery every 30 minutes
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = setInterval(() => {
      this.discoverTopMarkets();
    }, 30 * 60 * 1000);

    // 3. Start Periodic Scanner Loop every 20 seconds
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = setInterval(() => {
      this.scanMarkets();
    }, this.scanIntervalSec * 1000);

    // Run first scan immediately
    setTimeout(() => {
      this.scanMarkets();
    }, 1500);
  }

  /**
   * 1. Dynamic Market Ingestion: Queries Bybit V5 Linear Tickers & ranks Top 20 USDT-Perpetuals by 24h Turnover
   */
  public async discoverTopMarkets(): Promise<string[]> {
    try {
      this.emitter.log("🔍 [Market Scanner] Fetching Bybit V5 linear ticker rankings by 24h Turnover...");
      const res = await this.bybit.getTickers({ category: "linear" });

      if (res.retCode === 0 && res.result?.list) {
        const list = res.result.list;

        // Filter valid USDT perpetuals with high liquidity
        const validUsdtPairs = list.filter((item: any) => {
          const sym = item.symbol || "";
          const turnover = parseFloat(item.turnover24h || "0");
          const price = parseFloat(item.lastPrice || "0");
          return (
            sym.endsWith("USDT") &&
            !sym.includes("-") && // filter out delivery futures / USDC combos
            price > 0 &&
            turnover >= 10000000 // min $10M 24h turnover to filter dead pairs
          );
        });

        // Sort descending by 24h Turnover volume
        validUsdtPairs.sort((a: any, b: any) => {
          const tA = parseFloat(a.turnover24h || "0");
          const tB = parseFloat(b.turnover24h || "0");
          return tB - tA;
        });

        // Store ticker metrics in cache
        this.tickerCache.clear();
        for (const item of validUsdtPairs) {
          this.tickerCache.set(item.symbol, {
            lastPrice: parseFloat(item.lastPrice || "0"),
            turnover24h: parseFloat(item.turnover24h || "0"),
            volume24h: parseFloat(item.volume24h || "0"),
            price24hPcnt: parseFloat(item.price24hPcnt || "0") * 100,
            highPrice24h: parseFloat(item.highPrice24h || "0"),
            lowPrice24h: parseFloat(item.lowPrice24h || "0"),
            bid1Price: parseFloat(item.bid1Price || item.lastPrice),
            ask1Price: parseFloat(item.ask1Price || item.lastPrice),
            openInterest: parseFloat(item.openInterest || "0"),
          });
        }

        // Take Top 20 symbols
        const top20 = validUsdtPairs.slice(0, 20).map((i: any) => i.symbol);
        if (top20.length >= 5) {
          this.topSymbols = top20;
          this.emitter.log(
            `📊 [Market Scanner] Dynamic Top 20 Ingested: ${this.topSymbols.slice(0, 6).join(", ")} + ${this.topSymbols.length - 6} more`
          );
        }
      }
    } catch (err: any) {
      this.emitter.log(`⚠️ [Market Scanner] Market discovery warning: ${err.message}`);
    }

    return this.topSymbols;
  }

  /**
   * 2. Concurrent Strategy Scanner Loop: Evaluates 1m/5m technicals across all Top 20 pairs
   */
  public async scanMarkets(): Promise<ScannedMarketItem[]> {
    if (this.isScanning) return this.scannedItems;
    this.isScanning = true;

    try {
      const symbolsToScan = [...this.topSymbols];
      const newScannedItems: ScannedMarketItem[] = [];

      // Scan in batches of 5 concurrent requests to respect rate limits and maximize speed
      const batchSize = 5;
      for (let i = 0; i < symbolsToScan.length; i += batchSize) {
        const batch = symbolsToScan.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((sym) => this.evaluateSingleSymbol(sym))
        );

        for (const item of batchResults) {
          if (item) newScannedItems.push(item);
        }
      }

      // Sort: BUY_SIGNAL first, then IN_POSITION, then by 24h Turnover
      newScannedItems.sort((a, b) => {
        if (a.signal === "BUY_SIGNAL" && b.signal !== "BUY_SIGNAL") return -1;
        if (b.signal === "BUY_SIGNAL" && a.signal !== "BUY_SIGNAL") return 1;
        if (a.signal === "IN_POSITION" && b.signal !== "IN_POSITION") return -1;
        if (b.signal === "IN_POSITION" && a.signal !== "IN_POSITION") return 1;
        return b.turnover24h - a.turnover24h;
      });

      this.scannedItems = newScannedItems;
      this.lastScanTime = Date.now();

      // Emit scanner state to UI
      this.emitter.updateScanner(this.getState());

      // Telemetry summary
      const buySignals = this.scannedItems.filter((i) => i.signal === "BUY_SIGNAL");
      const bullishCount = this.scannedItems.filter((i) => i.trend === "Bullish").length;

      if (buySignals.length > 0) {
        this.emitter.log(
          `🚀 [Market Scanner] ${buySignals.length} BUY SIGNAL(S) DETECTED! (${buySignals.map((s) => s.symbol).join(", ")}) | ${bullishCount}/20 Bullish`
        );
      }

      // 3. Auto-Trade Execution Logic
      if (this.autoTrade && this.executor.getIsRunning()) {
        await this.handleAutoTradeTriggers(buySignals);
      }
    } catch (err: any) {
      this.emitter.log(`⚠️ [Market Scanner] Scanner loop error: ${err.message}`);
    } finally {
      this.isScanning = false;
    }

    return this.scannedItems;
  }

  /**
   * Evaluates technicals and generates a scan record for a single symbol
   */
  private async evaluateSingleSymbol(symbol: string): Promise<ScannedMarketItem | null> {
    try {
      const cachedTicker = this.tickerCache.get(symbol);
      if (!cachedTicker) return null;

      const currentPrice = cachedTicker.lastPrice;
      this.executor.currentPrices[symbol] = currentPrice;

      // Gate 1: Turnover >= 10,000,000 (handled in fetchTopMarkets)
      let gatePassed = 1;

      // Fetch 15m klines for HTF Trend (EMA 50/200)
      const kline15mRes = await this.bybit.getKline({ category: "linear", symbol, interval: "15", limit: 201 });
      if (kline15mRes.retCode !== 0 || !kline15mRes.result?.list || kline15mRes.result.list.length < 200) return null;
      
      const closes15m = [...kline15mRes.result.list].reverse().map((k: any) => parseFloat(k[4]));
      const ema50List = EMA.calculate({ period: 50, values: closes15m });
      const ema200List = EMA.calculate({ period: 200, values: closes15m });
      if (ema50List.length === 0 || ema200List.length === 0) return null;
      
      const ema50_15m = ema50List[ema50List.length - 1];
      const ema200_15m = ema200List[ema200List.length - 1];
      
      const trend15m = ema50_15m > ema200_15m ? "Bullish HTF" : (ema50_15m < ema200_15m ? "Bearish HTF" : "Neutral HTF");
      if (trend15m === "Bullish HTF" || trend15m === "Bearish HTF") gatePassed = 2;
      
      // Gate 3: Spread <= 0.15%
      const bid = cachedTicker.bid1Price || currentPrice;
      const ask = cachedTicker.ask1Price || currentPrice;
      const spreadPcnt = bid > 0 ? ((ask - bid) / bid) * 100 : 0;
      if (gatePassed === 2 && spreadPcnt <= 0.15) gatePassed = 3;

      // Gate 4 & 6: 5m ATR (14) >= 0.3% & 5m RSI (14)
      const kline5mRes = await this.bybit.getKline({ category: "linear", symbol, interval: "5", limit: 35 });
      if (kline5mRes.retCode !== 0 || !kline5mRes.result?.list || kline5mRes.result.list.length < 25) return null;
      
      const raw5m = [...kline5mRes.result.list].reverse();
      const highs5m = raw5m.map((k: any) => parseFloat(k[2]));
      const lows5m = raw5m.map((k: any) => parseFloat(k[3]));
      const closes5m = raw5m.map((k: any) => parseFloat(k[4]));
      
      const rsiList = RSI.calculate({ period: 14, values: closes5m });
      const atrList = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m });
      
      if (rsiList.length === 0 || atrList.length === 0) return null;
      const currentRsi = rsiList[rsiList.length - 1];
      const currentAtr = atrList[atrList.length - 1];
      const atrPcnt = (currentAtr / currentPrice) * 100;
      
      if (gatePassed === 3 && atrPcnt >= 0.3) gatePassed = 4;
      
      // Gate 5: OI Surge
      const oiPositive = cachedTicker.openInterest > 0;
      if (gatePassed === 4 && oiPositive) gatePassed = 5;

      // Gate 6: 5m RSI Momentum Trigger (50-65 Long, 35-50 Short)
      let signal: "BUY_SIGNAL" | "SELL_SIGNAL" | "WAITING" | "IN_POSITION" = "WAITING";
      let signalReason = "";
      
      if (gatePassed === 5) {
        if (trend15m === "Bullish HTF" && currentRsi >= 50 && currentRsi <= 65) {
          gatePassed = 6;
          signal = "BUY_SIGNAL";
          signalReason = `Bullish Entry: 15m Trend + RSI ${currentRsi.toFixed(1)}`;
        } else if (trend15m === "Bearish HTF" && currentRsi >= 35 && currentRsi <= 50) {
          gatePassed = 6;
          signal = "SELL_SIGNAL";
          signalReason = `Bearish Entry: 15m Trend + RSI ${currentRsi.toFixed(1)}`;
        }
      }

      if (signal === "WAITING") {
        signalReason = `Rejected at Gate ${gatePassed + 1}`;
      }

      const inPosition = this.executor.activePositions.some((p) => p.symbol === symbol);
      if (inPosition) {
        signal = "IN_POSITION";
        signalReason = "Active position currently held on Bybit";
      }

      return {
        symbol,
        price: currentPrice,
        lastPrice: currentPrice,
        turnover24h: cachedTicker.turnover24h,
        volume24h: cachedTicker.volume24h,
        price24hPcnt: cachedTicker.price24hPcnt,
        highPrice24h: cachedTicker.highPrice24h,
        lowPrice24h: cachedTicker.lowPrice24h,
        rsi: currentRsi,
        ema9: ema50_15m, // reuse fields for UI
        ema21: ema200_15m,
        trend: trend15m === "Bullish HTF" ? "Bullish" : "Bearish",
        trend15m,
        spreadPcnt,
        atrPcnt,
        oiPositive,
        gatePassed,
        signal,
        signalReason,
        lastScannedAt: Date.now(),
      };
    } catch (err: any) {
      return null;
    }
  }


  /**
   * Automated execution of confirmed scanner signals
   */
  private async handleAutoTradeTriggers(buySignals: ScannedMarketItem[]) {
    if (buySignals.length === 0) return;

    const maxConcurrentPositions = this.executor.settings?.maxPositions || this.maxConcurrent || 5;

    for (const item of buySignals) {
      // 1. Check max active positions
      const currentActiveCount = this.executor.activePositions.length;
      if (currentActiveCount >= maxConcurrentPositions) {
        this.emitter.log(
          `[Scanner] Signal on ${item.symbol} skipped: Maximum active concurrent positions reached (${currentActiveCount}/${maxConcurrentPositions}).`
        );
        break;
      }

      // 2. Check if already holding this coin
      const alreadyOpen = this.executor.activePositions.some((p) => p.symbol === item.symbol);
      if (alreadyOpen) continue;

      // 3. Check cooldown (min 3 mins between auto entries on same symbol)
      const lastTraded = this.cooldownMap.get(item.symbol) || 0;
      if (Date.now() - lastTraded < 180000) {
        continue;
      }

      // Set cooldown immediately
      this.cooldownMap.set(item.symbol, Date.now());

      this.emitter.log(
        `⚡ [Scanner Auto-Trade] Dispatching Market Buy for ${item.symbol} (Slot ${currentActiveCount + 1}/${maxConcurrentPositions}) | RSI: ${item.rsi.toFixed(1)}...`
      );

      // Execute Order
      const result = await this.executor.executeScannerEntry(
        item.symbol,
        item.price,
        item.ema9,
        item.ema21,
        item.rsi
      );

      // Send Telegram notification
      if (result.success) {
        this.telegram.sendScannerSignal(
          item.symbol,
          item.price,
          item.rsi,
          item.ema9,
          item.ema21,
          true
        );
      }
    }
  }

  public setAutoTrade(enabled: boolean) {
    this.autoTrade = enabled;
    this.emitter.log(`[Scanner] Auto-Trade Scanner Signals set to: ${enabled ? "ON" : "OFF"}`);
    this.emitter.updateScanner(this.getState());
  }

  public setMaxConcurrent(count: number) {
    this.maxConcurrent = Math.max(1, Math.min(10, count));
    this.emitter.log(`[Scanner] Max Concurrent Trades set to: ${this.maxConcurrent}`);
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
