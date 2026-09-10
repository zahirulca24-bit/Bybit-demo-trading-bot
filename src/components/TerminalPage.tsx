import { useState, useRef, useEffect } from "react";
import { Wallet, Play, Square, TrendingUp, XCircle, Terminal, Zap, Loader2, ArrowUpRight } from "lucide-react";
import { Position, TradeHistory, KlineUpdatePayload } from "../types";
import { QUICK_TEST_REQUESTED_QTY } from "../utils/frontendContract";
import { CandlestickChart } from "./CandlestickChart";

interface TerminalPageProps {
  balance: string;
  isBotRunning: boolean;
  isCircuitBreaker?: boolean;
  isLoading: boolean;
  toggleBot: () => void;
  onResetCircuitBreaker: () => Promise<void> | void;
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
  isLoading, 
  toggleBot,
  onResetCircuitBreaker, 
  watchlist, 
  prices, 
  positions,
  trades = [],
  latestKlineUpdate,
  logs = [],
  onClosePosition,
  onTestOrder,
}: TerminalPageProps) {
  const [selectedChartSymbol, setSelectedChartSymbol] = useState<string>("BTCUSDT");
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [isPlacingTestOrder, setIsPlacingTestOrder] = useState(false);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Keep selectedChartSymbol valid if watchlist changes
  const activeSymbol = watchlist.includes(selectedChartSymbol) ? selectedChartSymbol : (watchlist[0] || "BTCUSDT");

  // Auto-scroll log console to bottom when new entries arrive
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
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
      await onTestOrder(activeSymbol || "BTCUSDT");
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
        
        {/* Header Action Controls */}
        <div className="flex items-center gap-3">
          {/* Quick Test Long Button */}
          <button
            onClick={handleQuickTestLong}
            disabled={isLoading || isPlacingTestOrder}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/50 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Requests ${QUICK_TEST_REQUESTED_QTY} contracts. Normal pre-order risk validation runs before submission; scanner indicator gates are bypassed.`}
          >
            {isPlacingTestOrder ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                <span>Executing Order...</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 fill-emerald-400 text-emerald-400" />
                <span>Quick Test Long (Market)</span>
                <span className="text-[11px] bg-emerald-500/20 px-1.5 py-0.5 rounded font-mono font-normal">
                  {QUICK_TEST_REQUESTED_QTY} {activeSymbol.replace('USDT', '')} requested
                </span>
              </>
            )}
          </button>

          {/* Engine Start/Stop Button */}
          {isCircuitBreaker ? (
            <button
              onClick={onResetCircuitBreaker}
              disabled={isLoading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-bold text-sm transition-all bg-red-600 text-white hover:bg-red-700 animate-pulse border border-red-500 shadow-[0_0_15px_rgba(220,38,38,0.5)]"
            >
              <Zap className="w-4 h-4" />
              <span>CIRCUIT BREAKER ACTIVE - CLICK TO RESET</span>
            </button>
          ) : (
            <button
              onClick={toggleBot}
              disabled={isLoading}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-sm transition-all ${
                isBotRunning 
                  ? "bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20" 
                  : "bg-blue-600 text-white hover:bg-blue-700"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isBotRunning ? (
                <>
                  <Square className="w-4 h-4" />
                  <span>Pause Entries & Position Management</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  <span>Resume Engine</span>
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Top Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Balance Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col justify-between">
          <div className="flex items-center gap-2 text-neutral-400 mb-4">
            <Wallet className="w-4 h-4" />
            <h2 className="font-medium text-sm">Demo Wallet Balance</h2>
          </div>
          <div>
            <p className="text-3xl font-semibold tracking-tight text-white">
              {balance.trim() !== "" && Number.isFinite(Number(balance)) ? `$${Number(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
            </p>
            <p className="text-xs text-neutral-500 mt-1">USDT Unified Account</p>
          </div>
        </div>

        {/* Ticker Cards */}
        {watchlist.slice(0, 3).map((symbol) => {
          const isSelected = symbol === activeSymbol;
          const currentSymPrice = prices[symbol];
          return (
            <div 
              key={symbol} 
              onClick={() => setSelectedChartSymbol(symbol)}
              className={`bg-neutral-900 border ${isSelected ? 'border-blue-500/50 bg-blue-950/10' : 'border-neutral-800'} rounded-xl p-6 flex flex-col justify-between cursor-pointer hover:border-neutral-700 transition-all`}
            >
               <div className="flex items-center justify-between gap-2 text-neutral-400 mb-4">
                 <div className="flex items-center gap-2">
                   <TrendingUp className={`w-4 h-4 ${isSelected ? 'text-blue-400' : ''}`} />
                   <h2 className={`font-medium text-sm ${isSelected ? 'text-blue-400' : ''}`}>{symbol}</h2>
                 </div>
                 {isSelected && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">Chart View</span>}
               </div>
               <div>
                 <p className="text-3xl font-semibold tracking-tight text-white font-mono">
                   {currentSymPrice !== undefined && currentSymPrice !== null && !isNaN(currentSymPrice)
                     ? `$${Number(currentSymPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
                     : "..."}
                 </p>
                 <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                   <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                   Live ticker stream
                 </p>
               </div>
            </div>
          );
        })}
      </div>

      {/* TradingView Interactive Candlestick Chart */}
      <CandlestickChart 
        selectedSymbol={activeSymbol}
        onSelectSymbol={setSelectedChartSymbol}
        watchlist={watchlist}
        trades={trades}
        latestKlineUpdate={latestKlineUpdate}
        livePrice={prices[activeSymbol]}
      />

      {/* Compact Real-Time Activity Log Card (Directly Under Chart) */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900/70 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <h2 className="font-medium text-white text-sm">Live Strategy Diagnostics & Order Activity Feed</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-400 font-mono">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Real-time Stream ({logs.length} logged)</span>
          </div>
        </div>
        <div 
          ref={logContainerRef}
          className="p-3.5 bg-neutral-950 font-mono text-xs text-neutral-300 h-44 overflow-y-auto space-y-1 scroll-smooth"
        >
          {logs.length === 0 ? (
            <div className="text-neutral-600 italic py-3 text-center">
              Awaiting engine events... Click "Quick Test Long" to verify live Bybit order execution.
            </div>
          ) : (
            logs.slice(-50).map((log, idx) => {
              const isTest = log.includes("[Manual Test") || log.includes("⚡");
              const isBuy = log.includes("Buy") || log.includes("FILLED") || log.includes("Long signal approved") || log.includes("✅");
              const isExit = log.includes("Exit") || log.includes("Trailing Stop") || log.includes("Closed") || log.includes("🎯");
              const isCheck = log.includes("Check]");
              const isError = log.includes("Error") || log.includes("Exception") || log.includes("rejected") || log.includes("❌");

              let color = "text-neutral-300";
              if (isTest) color = "text-amber-300 font-medium";
              else if (isBuy) color = "text-emerald-400 font-medium";
              else if (isExit) color = "text-cyan-300 font-medium";
              else if (isError) color = "text-red-400 font-medium";
              else if (isCheck) color = "text-blue-300/90";

              return (
                <div key={idx} className={`leading-relaxed ${color} flex items-start gap-2`}>
                  <span className="text-neutral-600 select-none flex-shrink-0">›</span>
                  <span className="break-all">{log}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Active Positions Table */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 bg-neutral-900/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-medium text-white flex items-center gap-2">
              Active Positions
              <span className="bg-neutral-800 text-neutral-300 text-xs px-2 py-0.5 rounded-full">{positions.length} / 3 slots</span>
            </h2>
            <span className="text-xs text-neutral-500 hidden sm:inline">
              (Multi-asset concurrency: 1 position per symbol)
            </span>
          </div>
        </div>
        <div className="p-0">
          {positions.length === 0 ? (
            <div className="p-8 text-center text-neutral-500">
              No open positions. Strict automated entries use confirmed 5m scanner signals; live ticker data remains for monitoring.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-neutral-950/50 text-neutral-400">
                  <tr>
                    <th className="px-6 py-3 font-medium">Symbol</th>
                    <th className="px-6 py-3 font-medium">Side</th>
                    <th className="px-6 py-3 font-medium">Size</th>
                    <th className="px-6 py-3 font-medium">Entry Price</th>
                    <th className="px-6 py-3 font-medium">Mark Price</th>
                    <th className="px-6 py-3 font-medium">PnL</th>
                    <th className="px-6 py-3 font-medium">Trailing Stop Status</th>
                    <th className="px-6 py-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {positions.map((pos, i) => {
                    const entryRaw = pos.avgPrice ?? pos.entryPrice;
                    const entryPrice = entryRaw !== undefined ? Number(entryRaw) : Number.NaN;
                    const markPrice = pos.markPrice ? parseFloat(String(pos.markPrice)) : prices[pos.symbol];
                    const isLong = pos.side === "Buy";
                    const isClosing = closingSymbol === pos.symbol;
                    
                    let pnlPercent = 0;
                    if (markPrice && entryPrice) {
                       pnlPercent = ((markPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                    }
                    const isProfit = pnlPercent >= 0;

                    return (
                      <tr key={i} className="hover:bg-neutral-800/20 transition-colors">
                        <td className="px-6 py-4 font-medium text-white">{pos.symbol}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${isLong ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                            {isLong ? 'LONG' : 'SHORT'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-neutral-300 font-mono">{pos.size}</td>
                        <td className="px-6 py-4 text-neutral-300 font-mono">
                          {Number.isFinite(entryPrice) ? `$${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-neutral-300 font-mono">
                          {markPrice !== undefined && markPrice !== null && !isNaN(markPrice) ? `$${markPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '...'}
                        </td>
                        <td className={`px-6 py-4 font-medium font-mono ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
                          {isProfit ? '+' : ''}{pnlPercent.toFixed(2)}%
                        </td>
                        <td className="px-6 py-4">
                          <div className="max-w-[210px] text-xs text-neutral-400 leading-snug">
                            Runtime-managed: BE/trailing begins only after max(1.00%, initial SL distance, 1.25×ATR%); never widens SL.
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => handleManualClose(pos.symbol)}
                            disabled={isClosing}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-all disabled:opacity-50"
                            title="Exit position at market price"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            {isClosing ? "Closing..." : "Close Position"}
                          </button>
                        </td>
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
