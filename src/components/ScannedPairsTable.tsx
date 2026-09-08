import React, { useState } from "react";
import { 
  TrendingUp, 
  TrendingDown, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  ShieldCheck, 
  Zap, 
  ArrowUpRight, 
  Search, 
  Filter, 
  ExternalLink,
  ChevronRight,
  Activity
} from "lucide-react";
import { PipelineScannedSymbol } from "../types";

interface ScannedPairsTableProps {
  symbols: PipelineScannedSymbol[];
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onQuickBuy?: (symbol: string) => void;
  isScanning?: boolean;
}

export function ScannedPairsTable({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  onQuickBuy,
  isScanning = false,
}: ScannedPairsTableProps) {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filterAction, setFilterAction] = useState<"ALL" | "LONG" | "SHORT" | "PASSED">("ALL");

  const filteredSymbols = symbols.filter((sym) => {
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      if (!sym.symbol.includes(q)) return false;
    }

    if (filterAction === "PASSED") return sym.gates.passedAll;
    if (filterAction === "LONG") return sym.actionType === "LONG";
    if (filterAction === "SHORT") return sym.actionType === "SHORT";

    return true;
  });

  const formatPrice = (price?: number) => {
    if (price === undefined || price === null || isNaN(price)) return "$0.00";
    if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (price >= 1) return `$${price.toFixed(3)}`;
    return `$${price.toFixed(5)}`;
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm flex flex-col">
      {/* Table Controls Bar */}
      <div className="p-4 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-neutral-900/80">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-white text-sm">Top 20 Filtered Perpetuals</h3>
            <p className="text-xs text-neutral-400">
              Live quantitative telemetry evaluated across all 6 verification gates (including 15m HTF Trend & 5m RSI Entry Trigger).
            </p>
          </div>
        </div>

        {/* Search & Filter Pills */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              placeholder="Search pair..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 transition-colors w-32 sm:w-40"
            />
          </div>

          {/* Action Filter Pills */}
          <div className="flex items-center border border-neutral-800 rounded-lg bg-neutral-950 p-0.5 text-xs">
            <button
              onClick={() => setFilterAction("ALL")}
              className={`px-2.5 py-1 rounded font-medium transition-all ${
                filterAction === "ALL" ? "bg-neutral-800 text-white font-semibold" : "text-neutral-400 hover:text-white"
              }`}
            >
              All ({symbols.length})
            </button>
            <button
              onClick={() => setFilterAction("PASSED")}
              className={`px-2.5 py-1 rounded font-medium transition-all ${
                filterAction === "PASSED" ? "bg-emerald-600/30 text-emerald-400 font-semibold" : "text-neutral-400 hover:text-white"
              }`}
            >
              Passed 6 ({symbols.filter((s) => s.gates.passedAll).length})
            </button>
            <button
              onClick={() => setFilterAction("LONG")}
              className={`px-2.5 py-1 rounded font-medium transition-all ${
                filterAction === "LONG" ? "bg-emerald-500/20 text-emerald-400 font-semibold" : "text-neutral-400 hover:text-white"
              }`}
            >
              Longs
            </button>
            <button
              onClick={() => setFilterAction("SHORT")}
              className={`px-2.5 py-1 rounded font-medium transition-all ${
                filterAction === "SHORT" ? "bg-rose-500/20 text-rose-400 font-semibold" : "text-neutral-400 hover:text-white"
              }`}
            >
              Shorts
            </button>
          </div>
        </div>
      </div>

      {/* Responsive Table Area */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-950/70 text-neutral-400 font-semibold uppercase text-[10px] tracking-wider">
              <th className="py-3 px-4">Symbol</th>
              <th className="py-3 px-3">24h Turnover</th>
              <th className="py-3 px-3">15m Trend</th>
              <th className="py-3 px-3">Spread %</th>
              <th className="py-3 px-3">ATR (5m) %</th>
              <th className="py-3 px-3">OI Change (1h)</th>
              <th className="py-3 px-3">5m RSI</th>
              <th className="py-3 px-3">Pipeline Status</th>
              <th className="py-3 px-4 text-right">Action / Signal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {filteredSymbols.length > 0 ? (
              filteredSymbols.map((item) => {
                const isSelected = selectedSymbol === item.symbol;
                const passedAll = item.gates.passedAll;
                const isLong = item.actionType === "LONG";
                const isShort = item.actionType === "SHORT";
                const isBullishHtf = item.trend15m === "Bullish HTF";
                const isBearishHtf = item.trend15m === "Bearish HTF";

                return (
                  <tr
                    key={item.symbol}
                    onClick={() => onSelectSymbol && onSelectSymbol(item.symbol)}
                    className={`transition-colors cursor-pointer group ${
                      isSelected
                        ? "bg-blue-950/25 hover:bg-blue-950/35"
                        : passedAll
                        ? "bg-emerald-950/10 hover:bg-neutral-850"
                        : "hover:bg-neutral-850"
                    }`}
                  >
                    {/* 1. Symbol & Price */}
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col">
                          <span className="font-bold text-white font-mono text-sm tracking-tight group-hover:text-blue-400 transition-colors">
                            {item.symbol}
                          </span>
                          <span className="text-[11px] font-mono text-neutral-400">
                            {formatPrice(item.price)}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* 2. 24h Turnover (Gate 1) */}
                    <td className="py-3.5 px-3">
                      <div className="flex flex-col">
                        <span className="font-mono font-bold text-neutral-200">
                          {item.turnoverFormatted}
                        </span>
                        <span className="text-[10px] text-neutral-500">
                          {item.turnover24h >= 5000000 ? "High Liquid" : "Low Vol"}
                        </span>
                      </div>
                    </td>

                    {/* 3. 15m Trend Column (Gate 2: 15m EMA 50/200) */}
                    <td className="py-3.5 px-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center gap-1 ${
                            isBullishHtf
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : isBearishHtf
                              ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                              : "bg-neutral-800 text-neutral-400"
                          }`}
                        >
                          {isBullishHtf ? (
                            <TrendingUp className="w-3 h-3 text-emerald-400" />
                          ) : isBearishHtf ? (
                            <TrendingDown className="w-3 h-3 text-rose-400" />
                          ) : null}
                          {item.trend15m || "Neutral"}
                        </span>
                      </div>
                    </td>

                    {/* 4. Spread % (Gate 3) - Highlighted Green <=0.15%, Red if Above */}
                    <td className="py-3.5 px-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`font-mono font-bold px-2 py-0.5 rounded text-[11px] ${
                            item.isSpreadValid
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {item.spreadPercent.toFixed(3)}%
                        </span>
                      </div>
                    </td>

                    {/* 5. ATR (5m) % (Gate 4) */}
                    <td className="py-3.5 px-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`font-mono text-xs font-semibold ${
                            item.isAtrValid ? "text-neutral-200" : "text-neutral-500"
                          }`}
                        >
                          {item.atr5mPercent.toFixed(2)}%
                        </span>
                        {item.isAtrValid && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="5m Volatility Active" />
                        )}
                      </div>
                    </td>

                    {/* 6. OI Change (Gate 5) */}
                    <td className="py-3.5 px-3">
                      <div className="flex items-center gap-1">
                        <span
                          className={`font-mono font-semibold text-xs ${
                            item.oiChangePercent1h >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {item.oiChangePercent1h >= 0 ? `+${item.oiChangePercent1h.toFixed(1)}%` : `${item.oiChangePercent1h.toFixed(1)}%`}
                        </span>
                        {item.oiChangePercent1h >= 0 ? (
                          <TrendingUp className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <TrendingDown className="w-3 h-3 text-rose-400" />
                        )}
                      </div>
                    </td>

                    {/* 7. 5m RSI Column (Gate 6: 5m RSI 14) */}
                    <td className="py-3.5 px-3">
                      <div className="flex flex-col">
                        <span
                          className={`font-mono font-bold text-xs ${
                            item.isRsi5mValid
                              ? "text-emerald-400"
                              : item.rsi14_5m > 65
                              ? "text-rose-400"
                              : item.rsi14_5m < 35
                              ? "text-amber-400"
                              : "text-neutral-400"
                          }`}
                        >
                          {item.rsi14_5m?.toFixed(1) || "50.0"}
                        </span>
                        <span className="text-[9px] text-neutral-500">{item.rsiZone5m || "Neutral"}</span>
                      </div>
                    </td>

                    {/* 8. Pipeline Status Badge (Passed All 6 Gates / Blocked at Gate X) */}
                    <td className="py-3.5 px-3">
                      {passedAll ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-xs">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          Passed All 6 Gates
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-800 text-neutral-400 border border-neutral-700">
                          <XCircle className="w-2.5 h-2.5 text-rose-400" />
                          Blocked at Gate {item.gates.failedGateNumber || "X"}
                        </span>
                      )}
                    </td>

                    {/* 9. Action / Signal (Grade A Long, Grade A Short, Standby) */}
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {isLong ? (
                          <div className="flex items-center gap-1.5">
                            <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-500 text-black shadow-sm flex items-center gap-1 animate-pulse">
                              <Zap className="w-3 h-3 fill-black" />
                              Grade A Long
                            </span>
                            {onQuickBuy && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onQuickBuy(item.symbol);
                                }}
                                className="p-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white transition-all text-xs"
                                title={`Execute Quick Buy for ${item.symbol}`}
                              >
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ) : isShort ? (
                          <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-500 text-white shadow-sm flex items-center gap-1 animate-pulse">
                            <Zap className="w-3 h-3 fill-white" />
                            Grade A Short
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-xs font-medium text-neutral-500 bg-neutral-950 border border-neutral-800">
                            Standby
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={9} className="py-8 text-center text-neutral-500 text-xs">
                  No symbols matched the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer Details */}
      <div className="p-3 bg-neutral-950/80 border-t border-neutral-800 flex items-center justify-between text-[11px] text-neutral-500 px-4">
        <span>Showing top filtered USDT perpetuals by quantitative multi-gate criteria</span>
        <span>Updates in real-time via Bybit Demo linear stream</span>
      </div>
    </div>
  );
}
