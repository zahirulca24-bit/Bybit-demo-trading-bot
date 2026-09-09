import { RestClientV5 } from "bybit-api";

export interface ScannerTicker {
  symbol: string;
  lastPrice: number;
  turnover24h: number;
  volume24h: number;
  price24hPcnt: number;
  highPrice24h: number;
  lowPrice24h: number;
  bid1Price: number;
  ask1Price: number;
}

export interface ScannerOiMetric {
  available: boolean;
  openInterest: number | null;
  changePercent: number | null;
}

export class ScannerMarketDataService {
  private tickerSnapshot: { at: number; map: Map<string, ScannerTicker> } | null = null;
  private readonly tickerCacheMs = 5_000;
  private readonly oiCacheMs = 3 * 60 * 1000;
  private oiCache = new Map<string, { at: number; value: ScannerOiMetric }>();
  private cycleKlineCache = new Map<string, Promise<any[]>>();

  constructor(private bybit: RestClientV5) {}

  public async beginCycle(): Promise<Map<string, ScannerTicker>> {
    this.cycleKlineCache.clear();
    return this.getTickerMap(false);
  }

  public async getTickerMap(force = false): Promise<Map<string, ScannerTicker>> {
    if (!force && this.tickerSnapshot && Date.now() - this.tickerSnapshot.at < this.tickerCacheMs) {
      return this.tickerSnapshot.map;
    }
    const res = await this.bybit.getTickers({ category: "linear" });
    if (res.retCode !== 0 || !res.result?.list) throw new Error(res.retMsg || "Ticker snapshot unavailable");
    const map = new Map<string, ScannerTicker>();
    for (const raw of res.result.list as any[]) {
      const symbol = String(raw.symbol || "");
      if (!symbol) continue;
      map.set(symbol, {
        symbol,
        lastPrice: Number(raw.lastPrice || 0),
        turnover24h: Number(raw.turnover24h || 0),
        volume24h: Number(raw.volume24h || 0),
        price24hPcnt: Number(raw.price24hPcnt || 0) * 100,
        highPrice24h: Number(raw.highPrice24h || 0),
        lowPrice24h: Number(raw.lowPrice24h || 0),
        bid1Price: Number(raw.bid1Price || 0),
        ask1Price: Number(raw.ask1Price || 0),
      });
    }
    this.tickerSnapshot = { at: Date.now(), map };
    return map;
  }

  public async getClosedKlines(symbol: string, interval: "5" | "15", limit: number): Promise<any[]> {
    const intervalMs = interval === "5" ? 5 * 60 * 1000 : 15 * 60 * 1000;
    const key = `${symbol}:${interval}:${limit}`;
    let pending = this.cycleKlineCache.get(key);
    if (!pending) {
      pending = (async () => {
        const res = await this.bybit.getKline({ category: "linear", symbol, interval, limit });
        if (res.retCode !== 0 || !res.result?.list) throw new Error(res.retMsg || `${symbol} ${interval}m klines unavailable`);
        const now = Date.now();
        return [...res.result.list].reverse().filter((c: any) => Number(c[0]) + intervalMs <= now);
      })();
      this.cycleKlineCache.set(key, pending);
    }
    return pending;
  }

  public async getOpenInterest(symbol: string): Promise<ScannerOiMetric> {
    const cached = this.oiCache.get(symbol);
    if (cached && Date.now() - cached.at < this.oiCacheMs) return cached.value;
    let value: ScannerOiMetric;
    try {
      const res: any = await (this.bybit as any).getOpenInterest({ category: "linear", symbol, intervalTime: "1h", limit: 2 });
      if (res?.retCode !== 0 || !res?.result?.list || res.result.list.length < 2) throw new Error("Insufficient OI history");
      const rows = [...res.result.list].sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));
      const previous = Number(rows[rows.length - 2].openInterest || 0);
      const current = Number(rows[rows.length - 1].openInterest || 0);
      if (!(previous > 0) || !(current > 0)) throw new Error("Invalid OI history");
      value = { available: true, openInterest: current, changePercent: ((current - previous) / previous) * 100 };
    } catch {
      value = { available: false, openInterest: null, changePercent: null };
    }
    this.oiCache.set(symbol, { at: Date.now(), value });
    return value;
  }
}
