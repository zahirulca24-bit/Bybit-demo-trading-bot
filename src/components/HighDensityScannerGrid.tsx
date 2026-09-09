import React, { useState, useEffect } from "react";
import { 
  Radar, 
  RefreshCw, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Clock, 
  CheckCircle2, 
  ShieldAlert, 
  Award,
  Zap,
  Filter,
  Layers,
  ArrowUpRight,
  Sparkles
} from "lucide-react";
import { Scanner5mSignal, Scanner5mResult, ScannerState, Position } from "../types";

interface HighDensityScannerGridProps {
  scannerState?: ScannerState;
  activePositions?: Position[];
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onQuickBuy?: (symbol: string) => void;
}

export function HighDensityScannerGrid({
  selectedSymbol,
  onSelectSymbol,
  onQuickBuy,
}: HighDensityScannerGridProps) {
  const [activeSignals, setActiveSignals] = useState<Scanner5mSignal[]>([]);
  const [marketSetups, setMarketSetups] = useState<Scanner5mResult[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastScanTime, setLastScanTime] = useState<number>(0);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number>(0);
  const [filterGrade, setFilterGrade] = useState<"ALL" | "GRADE_A" | "GRADE_B">("ALL");
  const [filterBias, setFilterBias] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");

  const fetchStatusAndSignals = async (triggerScan = false) => {
    setIsLoading(true);
    try {
      // 1. Fetch Status (scheduler metadata & countdown)
      const statusRes = await fetch("/api/scanner/status");
      const statusData = await statusRes.json();
      if (typeof statusData.timeRemainingSeconds === "number") {
        setTimeRemainingSeconds(statusData.timeRemainingSeconds);
      }
      if (statusData.lastScanTime) {
        setLastScanTime(new Date(statusData.lastScanTime).getTime());
      }

      // 2. Fetch Signals / Results
      const url = triggerScan ? "/api/scanner/signals/scan-now" : "/api/scanner/signals";
      const res = await (triggerScan ? fetch(url, { method: "POST" }) : fetch(url));
      const data = await res.json();
      if (data.success) {
        if (data.activeSignals) setActiveSignals(data.activeSignals);
        if (data.marketSetups) setMarketSetups(data.marketSetups);
        if (data.lastScanTime) setLastScanTime(data.lastScanTime);
      }
    } catch (e) {
      console.error("Failed to fetch 5m scanner status & signals:", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatusAndSignals(false);
    const pollInterval = setInterval(() => fetchStatusAndSignals(false), 15000);
    return () => clearInterval(pollInterval);
  }, []);

  // 1-second countdown ticker for smooth MM:SS timer
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 300));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const filteredSignals = activeSignals.filter((s) => {
    if (filterGrade !== "ALL" && s.grade !== filterGrade) return false;
    if (filterBias !== "ALL" && s.side !== filterBias) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Top Bar: 5-Minute Candle Countdown Widget & Scan Controls */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <Radar className="w-5 h-5 animate-spin-slow" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-white text-base">Legacy / Informational Scanner</h2>
              <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px] font-semibold flex items-center gap-1">
                <Zap className="w-3 h-3" /> Informational only
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              Legacy informational 5m diagnostics only. It is isolated from auto-entry and Telegram execution signals.
            </p>
          </div>
        </div>

        {/* Countdown & Action Buttons */}
        <div className="flex items-center gap-3 self-end md:self-center">
          <div className="flex items-center gap-2.5 px-3.5 py-2 bg-neutral-950 border border-neutral-800 rounded-xl">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <div className="flex flex-col">
              <span className="text-[10px] text-neutral-500 font-medium uppercase tracking-wider">Next 5m Candle Scan In</span>
              <span className="text-sm font-mono font-bold text-blue-400">
                {formatCountdown(timeRemainingSeconds)}
              </span>
            </div>
          </div>

          <button
            onClick={() => fetchStatusAndSignals(true)}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            {isLoading ? "Scanning..." : "Scan Now"}
          </button>
        </div>
      </div>

      {/* Filter and View Toggle Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-900/60 border border-neutral-800/80 rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500 flex items-center gap-1 mr-1">
            <Filter className="w-3.5 h-3.5" /> Grade:
          </span>
          {(["ALL", "GRADE_A", "GRADE_B"] as const).map((grade) => (
            <button
              key={grade}
              onClick={() => setFilterGrade(grade)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                filterGrade === grade
                  ? "bg-blue-600 text-white shadow-sm font-semibold"
                  : "bg-neutral-950 text-neutral-400 hover:text-white border border-neutral-800"
              }`}
            >
              {grade === "ALL" ? `All Grades (${activeSignals.length})` : grade === "GRADE_A" ? "Grade A (High Conviction)" : "Grade B (Moderate)"}
            </button>
          ))}

          <span className="text-xs text-neutral-500 flex items-center gap-1 ml-2 mr-1">
            Bias:
          </span>
          {(["ALL", "LONG", "SHORT"] as const).map((bias) => (
            <button
              key={bias}
              onClick={() => setFilterBias(bias)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                filterBias === bias
                  ? "bg-neutral-800 text-white border border-neutral-700 font-semibold"
                  : "bg-neutral-950 text-neutral-400 hover:text-white border border-neutral-800"
              }`}
            >
              {bias}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <div className="flex items-center gap-1.5 bg-neutral-950 px-2.5 py-1 rounded-lg border border-neutral-800">
            <Activity className="w-3.5 h-3.5 text-blue-400" />
            <span>Monitored: <strong className="text-white">{marketSetups.length || 15}</strong> USDT Pairs</span>
          </div>

          <div className="flex items-center border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
            <button
              onClick={() => setViewMode("cards")}
              className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "cards" ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"
              }`}
            >
              Cards
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === "table" ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"
              }`}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Main Body: Detected Setups Grid / Table */}
      {filteredSignals.length > 0 ? (
        viewMode === "cards" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSignals.map((sig, idx) => {
              const isLong = sig.side === "LONG";
              const isGradeA = sig.grade === "GRADE_A";
              const isSelected = selectedSymbol === sig.symbol;

              return (
                <div
                  key={`${sig.symbol}_${sig.timestamp}_${idx}`}
                  onClick={() => onSelectSymbol && onSelectSymbol(sig.symbol)}
                  className={`p-4 rounded-xl border transition-all cursor-pointer group flex flex-col justify-between ${
                    isSelected
                      ? "bg-blue-950/20 border-blue-500 shadow-sm"
                      : isGradeA
                      ? isLong
                        ? "bg-neutral-900/90 border-emerald-500/40 hover:border-emerald-500 hover:bg-neutral-900"
                        : "bg-neutral-900/90 border-rose-500/40 hover:border-rose-500 hover:bg-neutral-900"
                      : "bg-neutral-900/90 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900"
                  }`}
                >
                  <div>
                    {/* Symbol & Grade Header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-base font-mono tracking-tight">{sig.symbol}</span>
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded flex items-center gap-1 ${
                            isLong
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {sig.side}
                        </span>
                      </div>

                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded flex items-center gap-1 ${
                          isGradeA
                            ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                            : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                        }`}
                      >
                        {isGradeA && <Award className="w-3 h-3" />}
                        {sig.grade.replace("_", " ")}
                      </span>
                    </div>

                    {/* Metrics Grid */}
                    <div className="grid grid-cols-2 gap-2 bg-neutral-950 p-3 rounded-lg border border-neutral-800/80 mb-3 text-xs font-mono">
                      <div>
                        <span className="text-neutral-500 text-[10px] block">Trigger / Mark Price</span>
                        <span className="text-white font-bold">
                          ${sig.price >= 1000
                            ? sig.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : sig.price.toFixed(sig.price < 1 ? 4 : 2)}
                        </span>
                      </div>

                      <div>
                        <span className="text-neutral-500 text-[10px] block">RSI (14-Period)</span>
                        <span className={`font-bold ${sig.technicals.rsi14 >= 70 ? "text-rose-400" : sig.technicals.rsi14 <= 30 ? "text-emerald-400" : "text-blue-400"}`}>
                          {sig.technicals.rsi14.toFixed(1)}
                        </span>
                      </div>

                      <div>
                        <span className="text-neutral-500 text-[10px] block">EMA 50 / 200 Status</span>
                        <span className="text-neutral-300 text-[11px]">
                          ${sig.technicals.ema50.toFixed(sig.price < 1 ? 4 : 2)} / ${sig.technicals.ema200.toFixed(sig.price < 1 ? 4 : 2)}
                        </span>
                      </div>

                      <div>
                        <span className="text-neutral-500 text-[10px] block">Vol vs 20-EMA</span>
                        <span className={`font-bold ${sig.technicals.volumeRatio >= 1.2 ? "text-emerald-400" : "text-amber-400"}`}>
                          {(sig.technicals.volumeRatio * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>

                    {/* Technical Strategy Rationale */}
                    <p className="text-xs text-neutral-300 leading-relaxed bg-neutral-950/40 p-2.5 rounded-lg border border-neutral-800/50 mb-3">
                      {sig.reason}
                    </p>
                  </div>

                  {/* Card Footer: Timestamp & Quick Action */}
                  <div className="pt-3 border-t border-neutral-800 flex items-center justify-between text-xs">
                    <span className="text-neutral-500 flex items-center gap-1 text-[11px]">
                      <Clock className="w-3 h-3" />
                      {new Date(sig.timestamp).toLocaleTimeString()}
                    </span>

                    {onQuickBuy && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onQuickBuy(sig.symbol);
                        }}
                        className="px-2.5 py-1 rounded-lg bg-blue-600/10 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/20 text-xs font-medium transition-all flex items-center gap-1"
                      >
                        Quick Trade <ArrowUpRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Table View for High Density */
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-neutral-950 text-neutral-400 border-b border-neutral-800 font-semibold">
                    <th className="py-3 px-4">Symbol</th>
                    <th className="py-3 px-4">Direction / Bias</th>
                    <th className="py-3 px-4">Setup Grade</th>
                    <th className="py-3 px-4">Trigger Price</th>
                    <th className="py-3 px-4">RSI (14)</th>
                    <th className="py-3 px-4">50 / 200 EMA</th>
                    <th className="py-3 px-4">Volume Ratio</th>
                    <th className="py-3 px-4">Scan Time</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 font-mono">
                  {filteredSignals.map((sig, idx) => {
                    const isLong = sig.side === "LONG";
                    const isGradeA = sig.grade === "GRADE_A";
                    return (
                      <tr 
                        key={`${sig.symbol}_table_${idx}`}
                        onClick={() => onSelectSymbol && onSelectSymbol(sig.symbol)}
                        className="hover:bg-neutral-800/50 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-4 font-bold text-white">{sig.symbol}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${
                              isLong
                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                            }`}
                          >
                            {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {sig.side}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${
                              isGradeA
                                ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                : "bg-neutral-800 text-neutral-400"
                            }`}
                          >
                            {isGradeA && <Award className="w-3 h-3" />}
                            {sig.grade.replace("_", " ")}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-white font-semibold">
                          ${sig.price >= 1000
                            ? sig.price.toLocaleString(undefined, { minimumFractionDigits: 2 })
                            : sig.price.toFixed(sig.price < 1 ? 4 : 2)}
                        </td>
                        <td className="py-3 px-4 font-bold text-blue-400">
                          {sig.technicals.rsi14.toFixed(1)}
                        </td>
                        <td className="py-3 px-4 text-neutral-300 text-[11px]">
                          ${sig.technicals.ema50.toFixed(2)} / ${sig.technicals.ema200.toFixed(2)}
                        </td>
                        <td className="py-3 px-4">
                          <span className={sig.technicals.volumeRatio >= 1.2 ? "text-emerald-400 font-bold" : "text-amber-400"}>
                            {(sig.technicals.volumeRatio * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="py-3 px-4 text-neutral-500 text-[11px]">
                          {new Date(sig.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {onQuickBuy && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onQuickBuy(sig.symbol);
                              }}
                              className="px-2 py-1 rounded bg-blue-600/10 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/20 text-xs font-medium transition-colors"
                            >
                              Trade
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : (
        /* Empty State: Centered Radar Icon stating monitoring message */
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-12 text-center flex flex-col items-center justify-center">
          <div className="relative mb-4">
            <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Radar className="w-8 h-8 animate-pulse text-blue-400" />
            </div>
            <div className="absolute inset-0 rounded-full border border-blue-500/20 animate-ping opacity-25" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">
            Monitoring 5m candles. No trade setups right now.
          </h3>
          <p className="text-xs text-neutral-400 max-w-md mb-6 leading-relaxed">
            The automated momentum engine continuously analyzes 50/200 EMA alignment, RSI golden pullbacks (40-65), and volume surges on closed 5-minute candles. New Grade A/B breakout signals will appear immediately upon candle close.
          </p>
          <button
            onClick={() => fetchStatusAndSignals(true)}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-semibold border border-neutral-700 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Force Re-Scan Markets Now
          </button>
        </div>
      )}
    </div>
  );
}
