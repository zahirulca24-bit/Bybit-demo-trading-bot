import React, { useEffect, useMemo, useState } from "react";
import { Activity, Clock, Filter, Radar, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";
import { Scanner5mResult, Scanner5mSignal, ScannerState, Position } from "../types";
import { finiteNumber, formatFinite } from "../utils/scannerTimingDisplay";

interface HighDensityScannerGridProps {
  scannerState?: ScannerState;
  activePositions?: Position[];
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onQuickBuy?: (symbol: string) => void;
}

function formatLegacyPrice(value: unknown): string {
  const price = finiteNumber(value);
  if (price === null) return "—";
  if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${price.toFixed(price < 1 ? 4 : 2)}`;
}

export function HighDensityScannerGrid({ selectedSymbol, onSelectSymbol }: HighDensityScannerGridProps) {
  const [activeSignals, setActiveSignals] = useState<Scanner5mSignal[]>([]);
  const [marketSetups, setMarketSetups] = useState<Scanner5mResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastScanTime, setLastScanTime] = useState<number | null>(null);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number | null>(null);
  const [filterGrade, setFilterGrade] = useState<"ALL" | "GRADE_A" | "GRADE_B">("ALL");
  const [filterBias, setFilterBias] = useState<"ALL" | "LONG" | "SHORT">("ALL");

  const fetchStatusAndSignals = async (triggerScan = false) => {
    setIsLoading(true);
    try {
      const statusRes = await fetch("/api/scanner/status");
      const statusData = await statusRes.json();
      setTimeRemainingSeconds(typeof statusData.timeRemainingSeconds === "number" && Number.isFinite(statusData.timeRemainingSeconds) ? statusData.timeRemainingSeconds : null);
      setLastScanTime(statusData.lastScanTime ? new Date(statusData.lastScanTime).getTime() : null);

      const url = triggerScan ? "/api/scanner/signals/scan-now" : "/api/scanner/signals";
      const res = await (triggerScan ? fetch(url, { method: "POST" }) : fetch(url));
      const data = await res.json();
      if (data.success) {
        setActiveSignals(Array.isArray(data.activeSignals) ? data.activeSignals : []);
        setMarketSetups(Array.isArray(data.marketSetups) ? data.marketSetups : []);
        if (typeof data.lastScanTime === "number" && Number.isFinite(data.lastScanTime)) setLastScanTime(data.lastScanTime);
      }
    } catch (error) {
      console.error("Failed to fetch legacy informational scanner:", error);
      setTimeRemainingSeconds(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatusAndSignals(false);
    const poll = setInterval(() => void fetchStatusAndSignals(false), 15000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemainingSeconds((previous) => previous === null ? null : Math.max(0, previous - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const filteredSignals = useMemo(() => activeSignals.filter((signal) => {
    if (filterGrade !== "ALL" && signal.grade !== filterGrade) return false;
    if (filterBias !== "ALL" && signal.side !== filterBias) return false;
    return true;
  }), [activeSignals, filterGrade, filterBias]);

  const countdown = timeRemainingSeconds === null
    ? "—"
    : `${Math.floor(timeRemainingSeconds / 60).toString().padStart(2, "0")}:${(timeRemainingSeconds % 60).toString().padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400"><Radar className="w-5 h-5" /></div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-bold text-white">Legacy / Informational Scanner</h2>
              <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px] font-semibold flex items-center gap-1"><Zap className="w-3 h-3" /> Informational only</span>
            </div>
            <p className="text-xs text-neutral-400">Manual diagnostics only. Official auto-entry is the strict six-gate scanner; this panel does not control order execution.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs">
            <div className="text-neutral-500">Reference 5m boundary</div>
            <div className="font-mono font-bold text-blue-400">{countdown}</div>
          </div>
          <button onClick={() => void fetchStatusAndSignals(true)} disabled={isLoading} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} /> {isLoading ? "Scanning…" : "Manual Scan"}
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-neutral-900/60 border border-neutral-800 rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500 flex items-center gap-1"><Filter className="w-3.5 h-3.5" /> Grade</span>
          {(["ALL", "GRADE_A", "GRADE_B"] as const).map((grade) => <button key={grade} onClick={() => setFilterGrade(grade)} className={`px-3 py-1 rounded-lg text-xs ${filterGrade === grade ? "bg-blue-600 text-white" : "bg-neutral-950 text-neutral-400 border border-neutral-800"}`}>{grade}</button>)}
          <span className="text-xs text-neutral-500 ml-2">Bias</span>
          {(["ALL", "LONG", "SHORT"] as const).map((bias) => <button key={bias} onClick={() => setFilterBias(bias)} className={`px-3 py-1 rounded-lg text-xs ${filterBias === bias ? "bg-neutral-800 text-white" : "bg-neutral-950 text-neutral-400 border border-neutral-800"}`}>{bias}</button>)}
        </div>
        <div className="text-xs text-neutral-400 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1"><Activity className="w-3.5 h-3.5 text-blue-400" /> Monitored: <strong className="text-white">{marketSetups.length}</strong></span>
          <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Last scan: {lastScanTime === null ? "—" : new Date(lastScanTime).toLocaleTimeString()}</span>
        </div>
      </div>

      {filteredSignals.length === 0 ? (
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6 text-center text-neutral-500">No legacy informational signals.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredSignals.map((signal, index) => {
            const isLong = signal.side === "LONG";
            const price = finiteNumber(signal.price);
            const rsi = finiteNumber(signal.technicals?.rsi14);
            const ema50 = finiteNumber(signal.technicals?.ema50);
            const ema200 = finiteNumber(signal.technicals?.ema200);
            const volumeRatio = finiteNumber(signal.technicals?.volumeRatio);
            const decimals = price !== null && price < 1 ? 4 : 2;
            return (
              <button key={`${signal.symbol}-${signal.timestamp}-${index}`} onClick={() => onSelectSymbol?.(signal.symbol)} className={`text-left p-4 rounded-xl border transition-colors ${selectedSymbol === signal.symbol ? "bg-blue-950/20 border-blue-500" : "bg-neutral-900 border-neutral-800 hover:border-neutral-700"}`}>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="font-mono font-bold text-white">{signal.symbol}</span>
                  <span className={isLong ? "text-emerald-400 text-xs flex items-center gap-1" : "text-rose-400 text-xs flex items-center gap-1"}>{isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{signal.side}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div><div className="text-neutral-500 text-[10px]">Price</div><div className="text-white">{formatLegacyPrice(price)}</div></div>
                  <div><div className="text-neutral-500 text-[10px]">RSI14</div><div className="text-blue-400">{formatFinite(rsi, 1)}</div></div>
                  <div><div className="text-neutral-500 text-[10px]">EMA50 / 200</div><div className="text-neutral-300">{ema50 === null ? "—" : `$${formatFinite(ema50, decimals)}`} / {ema200 === null ? "—" : `$${formatFinite(ema200, decimals)}`}</div></div>
                  <div><div className="text-neutral-500 text-[10px]">Volume ratio</div><div className="text-neutral-300">{volumeRatio === null ? "—" : `${formatFinite(volumeRatio * 100, 0)}%`}</div></div>
                </div>
                <p className="text-[11px] text-neutral-400 mt-3 line-clamp-2">{signal.reason || "—"}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
