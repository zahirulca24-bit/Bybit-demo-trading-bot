import { useState, useRef, useEffect } from "react";
import { Wallet, Play, Square, TrendingUp, XCircle, Terminal, Zap, Loader2, AlertTriangle } from "lucide-react";
import { Position, TradeHistory, KlineUpdatePayload, RuntimeRiskStatus } from "../types";
import { CandlestickChart } from "./CandlestickChart";

interface TerminalPageProps {
  balance: string;
  isBotRunning: boolean;
  isCircuitBreaker?: boolean;
  runtimeStatus: RuntimeRiskStatus;
  isLoading: boolean;
  toggleBot: () => void;
  watchlist: string[];
  prices: Record<string, number>;
  positions: Position[];
  trades?: TradeHistory[];
  latestKlineUpdate?: KlineUpdatePayload | null;
  logs?: string[];
  onClosePosition?: (symbol: string) => Promise<void> | void;
  onTestOrder?: (symbol: string) => Promise<void> | void;
}

export function TerminalPage({
  balance,
  isBotRunning,
  isCircuitBreaker,
  runtimeStatus,
  isLoading,
  toggleBot,
  watchlist,
  prices,
  positions,
  trades = [],
  latestKlineUpdate,
  logs = [],
  onClosePosition,
  onTestOrder,
}: TerminalPageProps) {
  const [selectedChartSymbol, setSelectedChartSymbol] = useState<string>("");
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [isPlacingTestOrder, setIsPlacingTestOrder] = useState(false);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const activeSymbol = watchlist.includes(selectedChartSymbol) ? selectedChartSymbol : (watchlist[0] || "BTCUSDT");

  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [logs]);

  const handleManualClose = async (symbol: string) => {
    if (!onClosePosition) return;
    setClosingSymbol(symbol);
    try {
      await onClosePosition(symbol);
    } finally {
      setClosingSymbol(null);
    }
  };

  const handleQuickTestLong = async () => {
    if (!onTestOrder || isPlacingTestOrder) return;
    setIsPlacingTestOrder(true);
    try {
      await onTestOrder(activeSymbol);
    } finally {
      setIsPlacingTestOrder(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row justify-between sm:items-end gap-4 pb-4 border-b border-neutral-800">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Terminal</h1>
          <p className="text-neutral-400">Live dashboard, candlestick technicals, and active positions.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleQuickTestLong}
            disabled={isLoading || isPlacingTestOrder || runtimeStatus.breakerActive}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/50 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title="Place a risk-sized market test order. Final quantity is validated by the backend."
          >
            {isPlacingTestOrder ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            <span>{isPlacingTestOrder ? "Submitting..." : "Risk-Sized Test Long"}</span>
          </button>

          <button
            onClick={toggleBot}
            disabled={isLoading}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-sm transition-all ${isBotRunning ? "bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20" : "bg-blue-600 text-white hover:bg-blue-700"} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isBotRunning ? <><Square className="w-4 h-4" /><span>Stop Engine</span></> : <><Play className="w-4 h-4" /><span>Start Engine</span></>}
          </button>
        </div>
      </header>

      {isCircuitBreaker && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 px-4 py-3 rounded-xl flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div className="text-sm">
            <strong>New entries blocked:</strong> {runtimeStatus.breakerReason || "runtime risk breaker active"}. Existing positions remain visible and managed by the engine when management is running.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col justify-between">
          <div className="flex items-center gap-2 text-neutral-400 mb-4"><Wallet className="w-4 h-4" /><h2 className="font-medium text-sm">Demo Wallet Balance</h2></div>
          <div>
            <p className="text-3xl font-semibold tracking-tight text-white">{balance.trim() !== "" && Number.isFinite(Number(balance)) ? `$${Number(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</p>
            <p className="text-xs text-neutral-500 mt-1">USDT Unified Account</p>
          </div>
        </div>

        {watchlist.slice(0, 3).map((symbol) => {
          const isSelected = symbol === activeSymbol;
          const currentSymPrice = prices[symbol];
          return (
            <div key={symbol} onClick={() => setSelectedChartSymbol(symbol)} className={`bg-neutral-900 border ${isSelected ? "border-blue-500/50 bg-blue-950/10" : "border-neutral-800"} rounded-xl p-6 flex flex-col justify-between cursor-pointer hover:border-neutral-700 transition-all`}>
              <div className="flex items-center justify-between gap-2 text-neutral-400 mb-4">
                <div className="flex items-center gap-2"><TrendingUp className={`w-4 h-4 ${isSelected ? "text-blue-400" : ""}`} /><h2 className={`font-medium text-sm ${isSelected ? "text-blue-400" : ""}`}>{symbol}</h2></div>
                {isSelected && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">Chart View</span>}
              </div>
              <div>
                <p className="text-3xl font-semibold tracking-tight text-white font-mono">{currentSymPrice !== undefined && Number.isFinite(currentSymPrice) ? `$${Number(currentSymPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : "..."}</p>
                <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />Live ticker stream</p>
              </div>
            </div>
          );
        })}
      </div>

      <CandlestickChart selectedSymbol={activeSymbol} onSelectSymbol={setSelectedChartSymbol} watchlist={watchlist} trades={trades} latestKlineUpdate={latestKlineUpdate} livePrice={prices[activeSymbol]} />

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900/70 flex items-center justify-between">
          <div className="flex items-center gap-2"><Terminal className="w-4 h-4 text-emerald-400" /><h2 className="font-medium text-white text-sm">Live Strategy Diagnostics & Order Activity Feed</h2></div>
          <div className="flex items-center gap-2 text-xs text-neutral-400 font-mono"><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /><span>Real-time Stream ({logs.length} logged)</span></div>
        </div>
        <div ref={logContainerRef} className="p-3.5 bg-neutral-950 font-mono text-xs text-neutral-300 h-44 overflow-y-auto space-y-1 scroll-smooth">
          {logs.length === 0 ? (
            <div className="text-neutral-600 italic py-3 text-center">Awaiting engine events...</div>
          ) : logs.slice(-50).map((log, idx) => {
            const isTest = log.includes("[Manual Test") || log.includes("⚡");
            const isBuy = log.includes("Buy") || log.includes("FILLED") || log.includes("Long signal approved") || log.includes("✅");
            const isExit = log.includes("Exit") || log.includes("Trailing Stop") || log.includes("Closed") || log.includes("🎯");
            const isCheck = log.includes("Check]");
            const isError = log.includes("Error") || log.includes("Exception") || log.includes("rejected") || log.includes("UNAVAILABLE") || log.includes("❌");
            let color = "text-neutral-300";
            if (isTest) color = "text-amber-300 font-medium";
            else if (isBuy) color = "text-emerald-400 font-medium";
            else if (isExit) color = "text-cyan-300 font-medium";
            else if (isError) color = "text-red-400 font-medium";
            else if (isCheck) color = "text-blue-300/90";
            return <div key={idx} className={`leading-relaxed ${color} flex items-start gap-2`}><span className="text-neutral-600 select-none flex-shrink-0">›</span><span className="break-all">{log}</span></div>;
          })}
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 bg-neutral-900/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-medium text-white flex items-center gap-2">Active Positions <span className="bg-neutral-800 text-neutral-300 text-xs px-2 py-0.5 rounded-full">{positions.length} / {runtimeStatus.maxPositions} slots</span></h2>
            <span className="text-xs text-neutral-500 hidden sm:inline">({runtimeStatus.duplicateSymbolPolicy === "DENY_SAME_SYMBOL" ? "One position per symbol" : runtimeStatus.duplicateSymbolPolicy})</span>
          </div>
        </div>
        <div className="p-0">
          {positions.length === 0 ? (
            <div className="p-8 text-center text-neutral-500">No confirmed open positions.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-neutral-950/50 text-neutral-400"><tr><th className="px-6 py-3 font-medium">Symbol</th><th className="px-6 py-3 font-medium">Side</th><th className="px-6 py-3 font-medium">Size</th><th className="px-6 py-3 font-medium">Entry Price</th><th className="px-6 py-3 font-medium">Mark Price</th><th className="px-6 py-3 font-medium">PnL</th><th className="px-6 py-3 font-medium">Stop Discipline</th><th className="px-6 py-3 font-medium text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-neutral-800">
                  {positions.map((pos, i) => {
                    const entryRaw = pos.avgPrice ?? pos.entryPrice;
                    const entryPrice = entryRaw !== undefined ? Number(entryRaw) : Number.NaN;
                    const markPrice = pos.markPrice ? parseFloat(String(pos.markPrice)) : prices[pos.symbol];
                    const isLong = pos.side === "Buy";
                    const isClosing = closingSymbol === pos.symbol;
                    let pnlPercent = 0;
                    if (markPrice && entryPrice) pnlPercent = ((markPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                    const isProfit = pnlPercent >= 0;
                    return (
                      <tr key={`${pos.symbol}-${pos.positionIdx ?? i}`} className="hover:bg-neutral-800/20 transition-colors">
                        <td className="px-6 py-4 font-medium text-white">{pos.symbol}</td>
                        <td className="px-6 py-4"><span className={`px-2 py-1 rounded text-xs font-medium ${isLong ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>{isLong ? "LONG" : "SHORT"}</span></td>
                        <td className="px-6 py-4 text-neutral-300 font-mono">{pos.size}</td>
                        <td className="px-6 py-4 text-neutral-300 font-mono">{Number.isFinite(entryPrice) ? `$${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</td>
                        <td className="px-6 py-4 text-neutral-300 font-mono">{markPrice !== undefined && Number.isFinite(markPrice) ? `$${markPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "..."}</td>
                        <td className={`px-6 py-4 font-medium font-mono ${isProfit ? "text-emerald-400" : "text-red-400"}`}>{isProfit ? "+" : ""}{pnlPercent.toFixed(2)}%</td>
                        <td className="px-6 py-4"><div className="max-w-[210px] text-xs text-neutral-400 leading-snug">{runtimeStatus.stopLossDiscipline.neverWiden ? "Runtime-managed; protective stops may only tighten." : runtimeStatus.stopLossDiscipline.mode}</div></td>
                        <td className="px-6 py-4 text-right"><button onClick={() => void handleManualClose(pos.symbol)} disabled={isClosing} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-all disabled:opacity-50" title="Submit reduce-only market close and await confirmation"><XCircle className="w-3.5 h-3.5" />{isClosing ? "Submitting..." : "Close Position"}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
