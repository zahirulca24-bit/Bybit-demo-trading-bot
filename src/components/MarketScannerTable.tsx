import React, { useMemo, useState } from "react";
import {
  ArrowUpRight,
  BarChart2,
  CheckCircle2,
  Clock,
  Radar,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react";
import { Position, ScannerState } from "../types";
import {
  STRICT_MAX_CONCURRENT_POSITIONS,
  finiteNumber,
  formatFinite,
  getScannerTimingDisplay,
} from "../utils/scannerTimingDisplay";

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

function formatTurnover(value: unknown): string {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  if (numeric >= 1e9) return `$${(numeric / 1e9).toFixed(2)}B`;
  if (numeric >= 1e6) return `$${(numeric / 1e6).toFixed(1)}M`;
  if (numeric >= 1e3) return `$${(numeric / 1e3).toFixed(0)}K`;
  return `$${numeric.toFixed(0)}`;
}

function formatPrice(value: unknown): string {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  if (numeric >= 1000) return `$${numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (numeric >= 1) return `$${numeric.toFixed(3)}`;
  return `$${numeric.toFixed(5)}`;
}

function timingBadgeClass(state: "Bullish" | "Bearish" | "Neutral" | "Unavailable"): string {
  if (state === "Bullish") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  if (state === "Bearish") return "bg-rose-500/10 text-rose-400 border-rose-500/20";
  if (state === "Neutral") return "bg-amber-500/10 text-amber-300 border-amber-500/20";
  return "bg-neutral-800 text-neutral-500 border-neutral-700";
}

export function MarketScannerTable({
  scannerState,
  activePositions = [],
  selectedSymbol,
  onSelectSymbol,
  onToggleAutoTrade,
  onScanNow,
  onRefreshMarkets,
  onQuickBuy,
}: MarketScannerTableProps) {
  const [filterTab, setFilterTab] = useState<"all" | "signals" | "bullish" | "bearish" | "in_position">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { markets = [], autoTrade, isScanning, lastScanTime } = scannerState;
  const tradeSignals = useMemo(() => markets.filter((m) => m.signal === "BUY_SIGNAL" || m.signal === "SELL_SIGNAL"), [markets]);
  const bullishCount = useMemo(() => markets.filter((m) => m.trend === "Bullish").length, [markets]);
  const bearishCount = useMemo(() => markets.filter((m) => m.trend === "Bearish").length, [markets]);
  const inPositionCount = useMemo(() => markets.filter((m) => m.signal === "IN_POSITION").length, [markets]);

  const filteredMarkets = useMemo(() => markets.filter((item) => {
    const query = searchQuery.trim().toUpperCase();
    if (query && !item.symbol.includes(query)) return false;
    if (filterTab === "signals") return item.signal === "BUY_SIGNAL" || item.signal === "SELL_SIGNAL";
    if (filterTab === "bullish") return item.trend === "Bullish";
    if (filterTab === "bearish") return item.trend === "Bearish";
    if (filterTab === "in_position") return item.signal === "IN_POSITION" || activePositions.some((p) => p.symbol === item.symbol);
    return true;
  }), [markets, filterTab, searchQuery, activePositions]);

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
      <div className="p-4 sm:p-5 border-b border-neutral-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-neutral-900/60">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20 shrink-0">
            <Radar className={`w-5 h-5 ${isScanning ? "animate-spin" : ""}`} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-white tracking-tight">Market Scanner Heatmap</h2>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${isScanning ? "bg-blue-500/20 text-blue-400 border-blue-500/30" : "bg-neutral-800 text-neutral-400 border-neutral-700"}`}>
                {isScanning ? "Scanning markets…" : lastScanTime ? `Updated ${new Date(lastScanTime).toLocaleTimeString()}` : "Ready"}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mt-0.5">
              EMA50/200 = trend filter. EMA9/21 = soft entry timing / quality confirmation and never blocks an otherwise valid six-gate setup.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs">
            <div className="text-neutral-500">Max Concurrent Positions</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-bold text-white">{STRICT_MAX_CONCURRENT_POSITIONS}</span>
              <span className="text-[10px] text-amber-300">Locked by strict risk profile</span>
            </div>
          </div>

          <button
            onClick={() => onToggleAutoTrade(!autoTrade)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold border transition-all ${autoTrade ? "bg-emerald-950/40 text-emerald-300 border-emerald-500/40" : "bg-neutral-950 text-neutral-400 border-neutral-800"}`}
            title="Auto-entry still requires all six hard gates; EMA9/21 and breakout are soft quality signals only"
          >
            <div className={`w-2 h-2 rounded-full ${autoTrade ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`} />
            Auto-Trade: {autoTrade ? "ON" : "OFF"}
          </button>

          <button onClick={onScanNow} disabled={isScanning} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? "animate-spin" : ""}`} /> Scan Now
          </button>
          <button onClick={onRefreshMarkets} disabled={isScanning} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 disabled:opacity-50">
            <BarChart2 className="w-3.5 h-3.5" /> Refresh Markets
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-neutral-800 bg-neutral-950/40 divide-x divide-neutral-800/80">
        <div className="p-3 sm:px-5"><div className="text-[11px] text-neutral-400">Scanned Universe</div><div className="font-bold text-white mt-1">{markets.length} pairs</div></div>
        <div className="p-3 sm:px-5"><div className="text-[11px] text-neutral-400">Trade Signals</div><div className="font-bold text-emerald-400 mt-1">{tradeSignals.length}</div></div>
        <div className="p-3 sm:px-5"><div className="text-[11px] text-neutral-400">Trend Distribution</div><div className="text-xs mt-1"><span className="text-emerald-400">{bullishCount} Bullish</span> <span className="text-neutral-600">/</span> <span className="text-rose-400">{bearishCount} Bearish</span></div></div>
        <div className="p-3 sm:px-5"><div className="text-[11px] text-neutral-400">Active Positions</div><div className="font-bold text-blue-400 mt-1">{activePositions.length} / {STRICT_MAX_CONCURRENT_POSITIONS}</div></div>
      </div>

      <div className="p-3 sm:px-5 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {([
            ["all", `All (${markets.length})`],
            ["signals", `Signals (${tradeSignals.length})`],
            ["bullish", `Bullish (${bullishCount})`],
            ["bearish", `Bearish (${bearishCount})`],
            ["in_position", `In Position (${inPositionCount})`],
          ] as const).map(([key, label]) => (
            <button key={key} onClick={() => setFilterTab(key)} className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap ${filterTab === key ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}>{label}</button>
          ))}
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-neutral-500" />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search pair…" className="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white uppercase focus:outline-none focus:border-blue-500" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse min-w-[980px]">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-950 text-neutral-400 uppercase font-mono text-[11px] tracking-wider">
              <th className="py-3 px-4">Pair</th>
              <th className="py-3 px-4">Price & 24h</th>
              <th className="py-3 px-4">Turnover</th>
              <th className="py-3 px-4">RSI14</th>
              <th className="py-3 px-4">EMA9/21 Timing</th>
              <th className="py-3 px-4">Signal</th>
              <th className="py-3 px-4">Diagnostics</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {filteredMarkets.length === 0 ? (
              <tr><td colSpan={8} className="py-12 text-center text-neutral-500">No market entries match the selected filter.</td></tr>
            ) : filteredMarkets.map((item) => {
              const isSelected = item.symbol === selectedSymbol;
              const isBuySignal = item.signal === "BUY_SIGNAL";
              const isSellSignal = item.signal === "SELL_SIGNAL";
              const isInPosition = item.signal === "IN_POSITION" || activePositions.some((p) => p.symbol === item.symbol);
              const rsi = finiteNumber(item.rsi);
              const priceChange = finiteNumber(item.price24hPcnt);
              const timing = getScannerTimingDisplay(item);
              const ema9 = finiteNumber(item.ema9);
              const ema21 = finiteNumber(item.ema21);
              const price = finiteNumber(item.price);
              const emaDecimals = price !== null && price < 1 ? 4 : 2;
              const isRsiPrime = rsi !== null && ((item.trend === "Bullish" && rsi >= 50 && rsi <= 64) || (item.trend === "Bearish" && rsi >= 36 && rsi <= 50));

              return (
                <tr key={item.symbol} onClick={() => onSelectSymbol(item.symbol)} className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-950/20" : "hover:bg-neutral-800/40"}`}>
                  <td className="py-3 px-4 font-bold text-white">{item.symbol}</td>
                  <td className="py-3 px-4 font-mono">
                    <div className="text-white">{formatPrice(item.price)}</div>
                    <div className={priceChange === null ? "text-neutral-500" : priceChange >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      {priceChange === null ? "—" : `${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono text-neutral-300">{formatTurnover(item.turnover24h)}</td>
                  <td className="py-3 px-4">
                    <span className={isRsiPrime ? "font-mono font-bold text-emerald-400" : "font-mono font-bold text-blue-400"}>{rsi === null ? "—" : rsi.toFixed(1)}</span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${timingBadgeClass(timing.state)}`}>{timing.state === "Unavailable" ? "—" : timing.state}</span>
                      <span className="text-[10px] text-neutral-300">{timing.relation}</span>
                    </div>
                    <div className="text-[10px] text-neutral-400 mt-1 font-mono">
                      9: {ema9 === null ? "—" : `$${formatFinite(ema9, emaDecimals)}`} · 21: {ema21 === null ? "—" : `$${formatFinite(ema21, emaDecimals)}`}
                    </div>
                    <div className="text-[10px] text-neutral-400 mt-1">Cross: <span className="text-neutral-200">{timing.cross}</span></div>
                    <div className="text-[10px] text-neutral-400">EMA Timing: <span className="text-neutral-200">{timing.score}</span></div>
                    <div className="text-[9px] text-neutral-600 mt-1" title="EMA9/21 is a soft timing-quality signal and does not block a valid six-gate setup.">Soft quality only · non-blocking</div>
                  </td>
                  <td className="py-3 px-4">
                    {isBuySignal ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><Zap className="w-3 h-3" /> BUY</span>
                    ) : isSellSignal ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30"><Zap className="w-3 h-3" /> SELL</span>
                    ) : isInPosition ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30"><CheckCircle2 className="w-3 h-3" /> IN POSITION</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-neutral-800 text-neutral-400"><Clock className="w-3 h-3" /> WAITING</span>
                    )}
                  </td>
                  <td className="py-3 px-4 max-w-xs"><div className="text-[11px] text-neutral-300 line-clamp-2" title={item.signalReason}>{item.signalReason || "Monitoring strict confirmed-candle conditions…"}</div></td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => onSelectSymbol(item.symbol)} className="px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs">Chart</button>
                      <button onClick={() => onQuickBuy(item.symbol)} className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1" title="Manual quick buy; separate from scanner signal direction"><ArrowUpRight className="w-3 h-3" /> Quick Buy</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
