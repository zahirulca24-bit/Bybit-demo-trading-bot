import React, { useState, useMemo } from "react";
import { 
  Radar, 
  TrendingUp, 
  TrendingDown, 
  Zap, 
  RefreshCw, 
  CheckCircle2, 
  Clock, 
  Search, 
  Sliders, 
  BarChart2, 
  ArrowUpRight,
  ExternalLink,
  ShieldCheck,
  Activity
} from "lucide-react";
import { ScannedMarketItem, ScannerState, Position } from "../types";

interface MarketScannerTableProps {
  scannerState: ScannerState;
  activePositions: Position[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onToggleAutoTrade: (autoTrade: boolean) => void;
  onScanNow: () => void;
  onRefreshMarkets: () => void;
  onSetMaxConcurrent: (max: number) => void;
  onQuickBuy: (symbol: string) => void;
}

export function MarketScannerTable({
  scannerState,
  activePositions = [],
  selectedSymbol,
  onSelectSymbol,
  onToggleAutoTrade,
  onScanNow,
  onRefreshMarkets,
  onSetMaxConcurrent,
  onQuickBuy,
}: MarketScannerTableProps) {
  const [filterTab, setFilterTab] = useState<"all" | "signals" | "bullish" | "bearish" | "in_position">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const { markets = [], autoTrade, maxConcurrent, isScanning, lastScanTime } = scannerState;

  // Derive counts
  const tradeSignals = useMemo(() => markets.filter((m) => m.signal === "BUY_SIGNAL" || m.signal === "SELL_SIGNAL"), [markets]);
  const bullishCount = useMemo(() => markets.filter((m) => m.trend === "Bullish").length, [markets]);
  const bearishCount = useMemo(() => markets.filter((m) => m.trend === "Bearish").length, [markets]);
  const inPositionCount = useMemo(() => markets.filter((m) => m.signal === "IN_POSITION").length, [markets]);

  // Filter and search markets
  const filteredMarkets = useMemo(() => {
    return markets.filter((item) => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toUpperCase();
        if (!item.symbol.includes(q)) return false;
      }

      // Filter Tab
      if (filterTab === "signals") return item.signal === "BUY_SIGNAL" || item.signal === "SELL_SIGNAL";
      if (filterTab === "bullish") return item.trend === "Bullish";
      if (filterTab === "bearish") return item.trend === "Bearish";
      if (filterTab === "in_position") return item.signal === "IN_POSITION" || activePositions.some(p => p.symbol === item.symbol);

      return true;
    });
  }, [markets, filterTab, searchQuery, activePositions]);

  // Helper formatting for turnover
  const formatTurnover = (val?: number) => {
    if (val === undefined || val === null || !Number.isFinite(val)) return "—";
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
    return `$${val.toFixed(0)}`;
  };

  const formatPrice = (price?: number) => {
    if (price === undefined || price === null || !Number.isFinite(price)) return "—";
    if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (price >= 1) return `$${price.toFixed(3)}`;
    return `$${price.toFixed(5)}`;
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
      {/* Top Header & Controls */}
      <div className="p-5 border-b border-neutral-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-neutral-900/60">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
            <Radar className={`w-5 h-5 ${isScanning ? "animate-spin text-blue-400" : ""}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white tracking-tight">Market Scanner Heatmap</h2>
              {isScanning ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-medium animate-pulse border border-blue-500/30">
                  Scanning 20 pairs...
                </span>
              ) : (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 font-medium">
                  {lastScanTime ? `Last updated: ${new Date(lastScanTime).toLocaleTimeString()}` : "Ready"}
                </span>
              )}
            </div>
            <p className="text-xs text-neutral-400 mt-0.5">
              Official auto-entry: strict six gates on confirmed candles. EMA50/200 = trend filter; EMA9/21 = soft entry timing / quality confirmation.
            </p>
          </div>
        </div>

        {/* Global Scanner Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Max Concurrent Position Selector */}
          <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-300">
            <span className="text-neutral-400">Max Slots:</span>
            <select
              value={maxConcurrent}
              onChange={(e) => onSetMaxConcurrent(parseInt(e.target.value, 10))}
              className="bg-neutral-900 text-white font-semibold rounded px-1.5 py-0.5 border border-neutral-700 text-xs focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="1">1 Trade</option>
              <option value="2">2 Trades (Recommended)</option>
              <option value="3">3 Trades</option>
              <option value="5">5 Trades</option>
            </select>
          </div>

          {/* Auto-Trade Toggle */}
          <button
            onClick={() => onToggleAutoTrade(!autoTrade)}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              autoTrade
                ? "bg-emerald-950/40 text-emerald-300 border-emerald-500/40 hover:bg-emerald-900/50 shadow-sm"
                : "bg-neutral-950 text-neutral-400 border-neutral-800 hover:text-white"
            }`}
            title="When enabled, executes only strict six-gate signals; EMA9/21 and breakout affect soft quality/ranking only"
          >
            <div className={`w-2 h-2 rounded-full ${autoTrade ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`} />
            Auto-Trade Scanner: <span className={autoTrade ? "text-emerald-400" : "text-neutral-500"}>{autoTrade ? "ON" : "OFF"}</span>
          </button>

          {/* Scan Now Action */}
          <button
            onClick={onScanNow}
            disabled={isScanning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? "animate-spin text-blue-400" : ""}`} />
            Scan Now
          </button>

          {/* Re-discover Market Rankings */}
          <button
            onClick={onRefreshMarkets}
            disabled={isScanning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition-all disabled:opacity-50"
            title="Re-query Bybit V5 Linear 24h Turnover leaderboard"
          >
            <BarChart2 className="w-3.5 h-3.5 text-neutral-400" />
            Top 20 Leaderboard
          </button>
        </div>
      </div>

      {/* Summary Stat Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-neutral-800 bg-neutral-950/40 divide-x divide-neutral-800/80">
        <div className="p-3.5 px-5">
          <div className="text-[11px] text-neutral-400 font-medium">Scanned Universe</div>
          <div className="text-base font-bold text-white mt-0.5 flex items-center gap-1.5">
            <span>{markets.length} USDT Pairs</span>
            <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.2 rounded font-mono">Bybit Linear</span>
          </div>
        </div>

        <div className="p-3.5 px-5">
          <div className="text-[11px] text-neutral-400 font-medium">Active Buy Signals</div>
          <div className="text-base font-bold mt-0.5 flex items-center gap-1.5">
            <span className={tradeSignals.length > 0 ? "text-emerald-400" : "text-neutral-400"}>
              {tradeSignals.length} Confirmed
            </span>
            {tradeSignals.length > 0 && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            )}
          </div>
        </div>

        <div className="p-3.5 px-5">
          <div className="text-[11px] text-neutral-400 font-medium">Trend Distribution</div>
          <div className="text-base font-bold text-white mt-0.5 flex items-center gap-2">
            <span className="text-emerald-400 text-xs font-medium">🟢 {bullishCount} Bullish</span>
            <span className="text-neutral-600">|</span>
            <span className="text-red-400 text-xs font-medium">🔴 {bearishCount} Bearish</span>
          </div>
        </div>

        <div className="p-3.5 px-5">
          <div className="text-[11px] text-neutral-400 font-medium">Active Engine Positions</div>
          <div className="text-base font-bold text-white mt-0.5 flex items-center gap-2">
            <span className="text-blue-400 font-mono">{activePositions.length} / {maxConcurrent} slots</span>
            {activePositions.length > 0 && (
              <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 rounded">Active</span>
            )}
          </div>
        </div>
      </div>

      {/* Filter Tabs & Search */}
      <div className="p-3 px-5 border-b border-neutral-800 flex flex-col sm:flex-row items-center justify-between gap-3 bg-neutral-900/30">
        <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto">
          <button
            onClick={() => setFilterTab("all")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              filterTab === "all"
                ? "bg-neutral-800 text-white shadow-sm"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            All ({markets.length})
          </button>
          <button
            onClick={() => setFilterTab("signals")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1 ${
              filterTab === "signals"
                ? "bg-emerald-950/60 text-emerald-300 border border-emerald-500/40"
                : "text-neutral-400 hover:text-emerald-300"
            }`}
          >
            🚀 Trade Signals ({tradeSignals.length})
          </button>
          <button
            onClick={() => setFilterTab("bullish")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              filterTab === "bullish"
                ? "bg-emerald-950/30 text-emerald-400 border border-emerald-800"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            🟢 Bullish ({bullishCount})
          </button>
          <button
            onClick={() => setFilterTab("bearish")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              filterTab === "bearish"
                ? "bg-red-950/30 text-red-400 border border-red-800"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            🔴 Bearish ({bearishCount})
          </button>
          <button
            onClick={() => setFilterTab("in_position")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              filterTab === "in_position"
                ? "bg-blue-950/30 text-blue-400 border border-blue-800"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            In Position ({inPositionCount})
          </button>
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-56">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-neutral-500" />
          <input
            type="text"
            placeholder="Search coin (e.g. DOGE)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1 text-xs text-white uppercase placeholder:normal-case placeholder:text-neutral-600 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
      </div>

      {/* Market Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-950 text-neutral-400 uppercase font-mono text-[11px] tracking-wider">
              <th className="py-3 px-4"># Pair</th>
              <th className="py-3 px-4">Price & 24h</th>
              <th className="py-3 px-4">24h Turnover</th>
              <th className="py-3 px-4">RSI (14)</th>
              <th className="py-3 px-4">EMA 9 / 21</th>
              <th className="py-3 px-4">Signal Status</th>
              <th className="py-3 px-4">Strategy Diagnostics</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60 font-sans">
            {filteredMarkets.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-neutral-500">
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <Radar className="w-8 h-8 text-neutral-600 animate-pulse" />
                    <span>No market entries match the selected filter.</span>
                  </div>
                </td>
              </tr>
            ) : (
              filteredMarkets.map((item, index) => {
                const isSelected = item.symbol === selectedSymbol;
                const isBuySignal = item.signal === "BUY_SIGNAL";
                const isInPos = item.signal === "IN_POSITION" || activePositions.some(p => p.symbol === item.symbol);
                const isBullish = item.trend === "Bullish";

                // RSI color and position
                const rsi = Number.isFinite(item.rsi) ? item.rsi : null;
                const isRsiPrime = rsi !== null && ((item.trend === "Bullish" && rsi >= 50 && rsi <= 64) || (item.trend === "Bearish" && rsi >= 36 && rsi <= 50));
                const rsiColor = isRsiPrime ? "text-emerald-400" : "text-blue-400";
                const rsiBarColor = isRsiPrime ? "bg-emerald-500" : "bg-blue-500";
                const pricePcnt = Number.isFinite(item.price24hPcnt) ? item.price24hPcnt : null;
                const ema9Val = Number.isFinite(item.ema9) ? item.ema9 : null;
                const ema21Val = Number.isFinite(item.ema21) ? item.ema21 : null;
                const priceVal = Number.isFinite(item.price) ? Number(item.price) : null;

                return (
                  <tr
                    key={item.symbol}
                    onClick={() => onSelectSymbol(item.symbol)}
                    className={`transition-colors cursor-pointer group ${
                      isSelected
                        ? "bg-blue-950/20 hover:bg-blue-950/30"
                        : isBuySignal
                        ? "bg-emerald-950/20 hover:bg-emerald-950/30"
                        : "hover:bg-neutral-800/40"
                    }`}
                  >
                    {/* Rank & Symbol */}
                    <td className="py-3 px-4 font-semibold text-white">
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500 font-mono text-[10px] w-4">#{index + 1}</span>
                        <span className="text-sm font-bold text-white group-hover:text-blue-400 transition-colors">
                          {item.symbol}
                        </span>
                        {isSelected && (
                          <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.2 rounded font-mono font-normal">
                            Chart
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Price & 24h Change */}
                    <td className="py-3 px-4 font-mono">
                      <div className="text-white font-medium">{formatPrice(item.price)}</div>
                      <div className={`text-[11px] flex items-center gap-0.5 ${
                        pricePcnt >= 0 ? "text-emerald-400" : "text-red-400"
                      }`}>
                        {pricePcnt === null ? "—" : `${pricePcnt >= 0 ? "+" : ""}${pricePcnt.toFixed(2)}%`}
                      </div>
                    </td>

                    {/* 24h Turnover */}
                    <td className="py-3 px-4 font-mono text-neutral-300">
                      <div className="font-medium text-neutral-200">{formatTurnover(item.turnover24h)}</div>
                      <div className="text-[10px] text-neutral-500">24h Volume</div>
                    </td>

                    {/* RSI (14) */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className={`font-mono font-bold text-xs ${rsiColor}`}>
                          {rsi === null ? "—" : rsi.toFixed(1)}
                        </span>
                        {isRsiPrime && (
                          <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-1 rounded font-semibold">
                            Prime Zone
                          </span>
                        )}
                      </div>
                      <div className="w-24 bg-neutral-800 h-1.5 rounded-full mt-1.5 overflow-hidden">
                        <div
                          className={`h-full ${rsiBarColor} transition-all duration-300`}
                          style={{ width: `${rsi === null ? 0 : Math.min(100, Math.max(0, rsi))}%` }}
                        />
                      </div>
                    </td>

                    {/* EMA 9 / 21 */}
                    <td className="py-3 px-4 font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          isBullish ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
                        }`}>
                          {isBullish ? "EMA9 > EMA21" : "EMA9 < EMA21"}
                        </span>
                      </div>
                      <div className="text-[10px] text-neutral-400 mt-1">
                        9: ${ema9Val.toFixed(priceVal < 1 ? 4 : 2)} | 21: ${ema21Val.toFixed(priceVal < 1 ? 4 : 2)}
                      </div>
                    </td>

                    {/* Signal Status */}
                    <td className="py-3 px-4">
                      {isBuySignal ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-sm animate-pulse">
                          <Zap className="w-3 h-3 text-emerald-400" /> BUY SIGNAL
                        </span>
                      ) : isInPos ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">
                          <CheckCircle2 className="w-3 h-3 text-blue-400" /> IN POSITION
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-neutral-800 text-neutral-400">
                          <Clock className="w-3 h-3 text-neutral-500" /> WAITING
                        </span>
                      )}
                    </td>

                    {/* Diagnostics */}
                    <td className="py-3 px-4 max-w-xs">
                      <div className="text-[11px] text-neutral-300 truncate" title={item.signalReason}>
                        {item.signalReason || "Monitoring strict confirmed 5m scanner conditions..."}
                      </div>
                    </td>

                    {/* Action buttons */}
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => onSelectSymbol(item.symbol)}
                          className="px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium transition-colors"
                          title="View on Interactive Chart"
                        >
                          Chart
                        </button>
                        <button
                          onClick={() => onQuickBuy(item.symbol)}
                          className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors flex items-center gap-1 shadow-sm"
                          title="Execute immediate Market Buy on Bybit Demo"
                        >
                          <ArrowUpRight className="w-3 h-3" /> Quick Buy
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
