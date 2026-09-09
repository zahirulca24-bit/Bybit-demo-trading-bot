import { useEffect, useMemo, useState } from "react";
import { Activity, Radar, RefreshCw, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import { Scanner5mResult, Scanner5mSignal } from "../types";
import { finiteNumber, formatFinite } from "../utils/scannerTimingDisplay";

interface Scanner5mPanelProps {
  onSelectSymbol?: (symbol: string) => void;
}

export function Scanner5mPanel({ onSelectSymbol }: Scanner5mPanelProps) {
  const [activeSignals, setActiveSignals] = useState<Scanner5mSignal[]>([]);
  const [marketSetups, setMarketSetups] = useState<Scanner5mResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number | null>(null);
  const [filterGrade, setFilterGrade] = useState<"ALL" | "GRADE_A" | "GRADE_B">("ALL");

  const fetchStatusAndSignals = async (triggerScan = false) => {
    setIsLoading(true);
    try {
      const statusRes = await fetch("/api/scanner/status");
      const statusData = await statusRes.json();
      setTimeRemainingSeconds(typeof statusData.timeRemainingSeconds === "number" && Number.isFinite(statusData.timeRemainingSeconds) ? statusData.timeRemainingSeconds : null);

      const url = triggerScan ? "/api/scanner/signals/scan-now" : "/api/scanner/signals";
      const response = await (triggerScan ? fetch(url, { method: "POST" }) : fetch(url));
      const data = await response.json();
      if (data.success) {
        setActiveSignals(Array.isArray(data.activeSignals) ? data.activeSignals : []);
        setMarketSetups(Array.isArray(data.marketSetups) ? data.marketSetups : []);
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
    const poll = setInterval(() => void fetchStatusAndSignals(false), 20000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemainingSeconds((previous) => previous === null ? null : Math.max(0, previous - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const filteredSignals = useMemo(() => activeSignals.filter((signal) => filterGrade === "ALL" || signal.grade === filterGrade), [activeSignals, filterGrade]);
  const countdown = timeRemainingSeconds === null ? "—" : `${Math.floor(timeRemainingSeconds / 60)}m ${(timeRemainingSeconds % 60).toString().padStart(2, "0")}s`;

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 sm:p-5 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400"><Radar className="w-4 h-4" /></div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-bold text-white">Legacy / Informational Scanner</h2>
              <span className="text-[10px] bg-indigo-500/20 text-indigo-300 font-semibold px-2 py-0.5 rounded border border-indigo-500/30">No order execution</span>
            </div>
            <p className="text-xs text-neutral-400">Manual informational snapshot only. Official auto-entry is the strict six-gate scanner.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono"><span className="text-neutral-500">5m boundary: </span><span className="text-indigo-400 font-bold">{countdown}</span></div>
          <button onClick={() => void fetchStatusAndSignals(true)} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />{isLoading ? "Scanning…" : "Manual Scan"}</button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {(["ALL", "GRADE_A", "GRADE_B"] as const).map((grade) => <button key={grade} onClick={() => setFilterGrade(grade)} className={`px-2.5 py-1 rounded-lg text-xs ${filterGrade === grade ? "bg-neutral-800 text-white border border-neutral-700" : "bg-neutral-950 text-neutral-400 border border-neutral-800"}`}>{grade === "ALL" ? `All (${activeSignals.length})` : grade}</button>)}
        </div>
        <div className="text-xs text-neutral-400 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-indigo-400" />Monitoring {marketSetups.length} pairs</div>
      </div>

      {filteredSignals.length === 0 ? (
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6 text-center text-neutral-400">
          <ShieldCheck className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
          <p className="text-sm text-neutral-300">No legacy informational signals</p>
          <p className="text-xs text-neutral-500 mt-1">This panel is not the official strategy and cannot execute orders.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredSignals.map((signal, index) => {
            const isLong = signal.side === "LONG";
            const price = finiteNumber(signal.price);
            const rsi = finiteNumber(signal.technicals?.rsi14);
            const ema50 = finiteNumber(signal.technicals?.ema50);
            const ema200 = finiteNumber(signal.technicals?.ema200);
            const decimals = price !== null && price < 1 ? 4 : 2;
            return (
              <button key={`${signal.symbol}-${signal.timestamp}-${index}`} onClick={() => onSelectSymbol?.(signal.symbol)} className="text-left p-3.5 rounded-xl bg-neutral-950 border border-neutral-800 hover:border-neutral-700 transition-colors">
                <div className="flex items-center justify-between mb-2"><span className="font-bold text-white font-mono">{signal.symbol}</span><span className={isLong ? "text-emerald-400 text-xs flex items-center gap-1" : "text-rose-400 text-xs flex items-center gap-1"}>{isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{signal.side}</span></div>
                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                  <div><span className="text-neutral-500 block">Price</span><span className="text-white">{price === null ? "—" : `$${formatFinite(price, decimals)}`}</span></div>
                  <div><span className="text-neutral-500 block">RSI14</span><span className="text-indigo-400">{formatFinite(rsi, 1)}</span></div>
                  <div className="col-span-2"><span className="text-neutral-500 block">EMA50 / EMA200</span><span className="text-neutral-300">{ema50 === null ? "—" : `$${formatFinite(ema50, decimals)}`} / {ema200 === null ? "—" : `$${formatFinite(ema200, decimals)}`}</span></div>
                </div>
                <p className="text-[11px] text-neutral-500 mt-2 line-clamp-2">{signal.reason || "—"}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
