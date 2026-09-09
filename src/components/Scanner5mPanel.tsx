import { useState, useEffect } from "react";
import { Radar, Zap, RefreshCw, TrendingUp, TrendingDown, Activity, BarChart2, ShieldCheck, CheckCircle2 } from "lucide-react";
import { Scanner5mSignal, Scanner5mResult } from "../types";

interface Scanner5mPanelProps {
  onSelectSymbol?: (symbol: string) => void;
}

export function Scanner5mPanel({ onSelectSymbol }: Scanner5mPanelProps) {
  const [activeSignals, setActiveSignals] = useState<Scanner5mSignal[]>([]);
  const [marketSetups, setMarketSetups] = useState<Scanner5mResult[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastScanTime, setLastScanTime] = useState<number>(0);
  const [nextScanTime, setNextScanTime] = useState<string>("");
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number>(0);
  const [filterGrade, setFilterGrade] = useState<"ALL" | "GRADE_A" | "GRADE_B">("ALL");

  const fetchStatusAndSignals = async (triggerScan = false) => {
    setIsLoading(true);
    try {
      // 1. Fetch Status (scheduler metadata & countdown)
      const statusRes = await fetch("/api/scanner/status");
      const statusData = await statusRes.json();
      if (statusData.nextScanTime) {
        setNextScanTime(statusData.nextScanTime);
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
    const pollInterval = setInterval(() => fetchStatusAndSignals(false), 20000);
    return () => clearInterval(pollInterval);
  }, []);

  // 1-second countdown ticker for smooth UI
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs < 10 ? "0" : ""}${secs}s`;
  };

  const filteredSignals = activeSignals.filter((s) => {
    if (filterGrade === "ALL") return true;
    return s.grade === filterGrade;
  });

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-sm space-y-4">
      {/* Header with quick stats and manual scan button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <Radar className="w-4 h-4 animate-spin-slow" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-white text-base">Legacy / Informational Scanner</h2>
              <span className="text-[10px] bg-indigo-500/20 text-indigo-300 font-semibold px-2 py-0.5 rounded border border-indigo-500/30">
                No order execution
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              Manual informational snapshot only. The official auto-entry strategy is the strict six-gate scanner; this panel cannot execute orders.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-neutral-400 text-[11px]">Next 5m Close:</span>
            <span className="text-indigo-400 font-bold">{formatCountdown(timeRemainingSeconds)}</span>
          </div>

          <button
            onClick={() => fetchStatusAndSignals(true)}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            {isLoading ? "Scanning 5m..." : "Scan Now"}
          </button>
        </div>
      </div>

      {/* Grade Filters & Signal Count */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {(["ALL", "GRADE_A", "GRADE_B"] as const).map((grade) => (
            <button
              key={grade}
              onClick={() => setFilterGrade(grade)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                filterGrade === grade
                  ? "bg-neutral-800 text-white border border-neutral-700 font-bold"
                  : "bg-neutral-950 text-neutral-400 hover:text-white border border-neutral-800/80"
              }`}
            >
              {grade === "ALL" ? `All Signals (${activeSignals.length})` : grade === "GRADE_A" ? "GRADE_A (High Conviction)" : "GRADE_B (Moderate Vol)"}
            </button>
          ))}
        </div>

        <div className="text-xs text-neutral-400 flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-indigo-400" />
          <span>Monitoring {marketSetups.length} active USDT pairs</span>
        </div>
      </div>

      {/* Detected Signals Cards */}
      {filteredSignals.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredSignals.map((sig, idx) => {
            const isLong = sig.side === "LONG";
            const isGradeA = sig.grade === "GRADE_A";
            return (
              <div
                key={`${sig.symbol}_${sig.timestamp}_${idx}`}
                onClick={() => onSelectSymbol && onSelectSymbol(sig.symbol)}
                className={`p-3.5 rounded-xl border transition-all cursor-pointer group ${
                  isGradeA
                    ? isLong
                      ? "bg-emerald-950/20 border-emerald-500/40 hover:border-emerald-500"
                      : "bg-rose-950/20 border-rose-500/40 hover:border-rose-500"
                    : "bg-neutral-950 border-neutral-800 hover:border-neutral-700"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white font-mono">{sig.symbol}</span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5 ${
                        isLong
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                          : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                      }`}
                    >
                      {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {sig.side}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      isGradeA ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-neutral-800 text-neutral-400"
                    }`}
                  >
                    {sig.grade}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] mb-2 font-mono">
                  <div>
                    <span className="text-neutral-500 block text-[10px]">Price</span>
                    <span className="text-white font-semibold">
                      ${sig.price >= 1000 ? sig.price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : sig.price.toFixed(sig.price < 1 ? 4 : 2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[10px]">RSI (14)</span>
                    <span className="text-indigo-400 font-semibold">{sig.technicals.rsi14.toFixed(1)}</span>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[10px]">50 / 200 EMA</span>
                    <span className="text-neutral-300 text-[10px]">
                      ${sig.technicals.ema50.toFixed(sig.price < 1 ? 4 : 2)} / ${sig.technicals.ema200.toFixed(sig.price < 1 ? 4 : 2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[10px]">Volume vs 20-EMA</span>
                    <span className={`font-semibold ${sig.technicals.volumeRatio >= 1 ? "text-emerald-400" : "text-amber-400"}`}>
                      {(sig.technicals.volumeRatio * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-neutral-400 leading-snug line-clamp-2">
                  {sig.reason}
                </p>

                <div className="mt-2 pt-2 border-t border-neutral-800/80 flex items-center justify-between text-[10px] text-neutral-500">
                  <span>Candle: 5m</span>
                  <span>{new Date(sig.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-neutral-950 border border-neutral-800/80 rounded-xl p-6 text-center text-neutral-400">
          <ShieldCheck className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
          <p className="text-sm font-medium text-neutral-300">No legacy informational signals</p>
          <p className="text-xs text-neutral-500 mt-1">
            This legacy panel is not the official strategy and cannot execute orders. Use the strict six-gate scanner for production auto-entry state.
          </p>
        </div>
      )}
    </div>
  );
}
