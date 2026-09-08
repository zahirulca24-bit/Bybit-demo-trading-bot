import { useState, useEffect } from "react";
import { 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  RefreshCw, 
  ShieldAlert, 
  XCircle, 
  DollarSign, 
  Percent, 
  ArrowUpRight,
  Sparkles,
  Layers,
  Zap,
  CheckCircle2,
  Clock,
  Target,
  FileText,
  Sliders
} from "lucide-react";
import { Position, Settings, DailyTradeAnalytics, ClosedTradeAuditItem, SlAuditSummary } from "../types";
import { ClosedTradesExitAuditTable } from "./ClosedTradesExitAuditTable";
import { SlDiagnosticsPanel } from "./SlDiagnosticsPanel";

export interface FormattedPosition {
  symbol: string;
  side: string; // 'Buy' | 'Sell'
  size: string;
  avgPrice: string;
  markPrice?: string;
  unrealisedPnl?: string;
  curRealisedPnl?: string;
  leverage?: string;
  stopLoss?: string;
  takeProfit?: string;
  liqPrice?: string;
}

interface ActiveTradesPageProps {
  positions: Position[];
  settings?: Settings;
  tradeHistory?: any[];
  onClosePosition: (symbol: string) => Promise<void> | void;
  onRefresh?: () => Promise<void> | void;
}

export function ActiveTradesPage({ 
  positions = [], 
  settings,
  tradeHistory,
  onClosePosition,
  onRefresh 
}: ActiveTradesPageProps) {
  const [activePositions, setActivePositions] = useState<FormattedPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [isPanicClosing, setIsPanicClosing] = useState(false);
  const [showPanicModal, setShowPanicModal] = useState(false);
  const [panicSuccessMessage, setPanicSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Daily Trade Analytics & SL Diagnostics State
  const [analytics, setAnalytics] = useState<DailyTradeAnalytics>({
    todayOpenedCount: 0,
    todayClosedCount: 0,
    activePositionsCount: 0,
    maxSlots: settings?.maxPositions || 5,
    tpHitCount: 0,
    trailingStopCount: 0,
    slHitCount: 0,
    manualCloseCount: 0,
    breakEvenCount: 0,
    slAudit: {
      primarySlCause: "5m Volatility Spike / Spread Wick",
      worstPerformingSymbol: "SOLUSDT",
      slCountForWorst: 0,
      averageTimeToSlSeconds: 145,
      strategyFeedbackNote: "Evaluating real-time orderbook depth and 5m candle volatility...",
      totalLossUsdt: 0,
    },
    closedTrades: [],
  });

  const maxSlots = settings?.maxPositions || 5;
  const defaultLev = settings?.leverage || 10;

  // Fetch live active positions directly from Bybit V5 endpoint
  const fetchActivePositions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [posRes, analyticsRes] = await Promise.all([
        fetch("/api/positions/active").then((r) => r.json()).catch(() => ({ success: false })),
        fetch("/api/analytics/daily").then((r) => r.json()).catch(() => ({ success: false })),
      ]);

      if (posRes.success && Array.isArray(posRes.positions)) {
        setActivePositions(posRes.positions);
      } else if (positions.length > 0) {
        setActivePositions(positions as FormattedPosition[]);
      } else {
        setActivePositions([]);
      }

      if (analyticsRes.success && analyticsRes.analytics) {
        setAnalytics(analyticsRes.analytics);
      }
    } catch (err: any) {
      console.error("Failed to fetch active positions / analytics:", err);
      if (positions.length > 0) {
        setActivePositions(positions as FormattedPosition[]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchActivePositions();
    const interval = setInterval(fetchActivePositions, 3000);
    return () => clearInterval(interval);
  }, []);

  // Also sync when parent positions prop updates
  useEffect(() => {
    if (positions.length > 0 && activePositions.length === 0) {
      setActivePositions(positions as FormattedPosition[]);
    }
  }, [positions]);

  // Calculate Aggregated Total Floating / Unrealized PnL and Total Margin
  const { totalUnrealizedPnl, totalPositionValue, totalMargin, aggregateRoiPercent } = activePositions.reduce(
    (acc, pos) => {
      const pnl = parseFloat(pos.unrealisedPnl || "0");
      const price = parseFloat(pos.avgPrice || pos.markPrice || "0");
      const size = parseFloat(pos.size || "0");
      const lev = parseFloat(pos.leverage || String(defaultLev)) || defaultLev;
      const value = price * size;
      const margin = lev > 0 ? value / lev : value;

      acc.totalUnrealizedPnl += isNaN(pnl) ? 0 : pnl;
      acc.totalPositionValue += isNaN(value) ? 0 : value;
      acc.totalMargin += isNaN(margin) ? 0 : margin;
      return acc;
    },
    { totalUnrealizedPnl: 0, totalPositionValue: 0, totalMargin: 0, aggregateRoiPercent: 0 }
  );

  const calculatedRoi = totalMargin > 0 ? (totalUnrealizedPnl / totalMargin) * 100 : 0;
  const isPnlPositive = totalUnrealizedPnl >= 0;

  // Realized PnL Calculations from Trade History (Today starting 00:00 UTC)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const totalRealizedPnl = (tradeHistory || [])
    .filter(t => t.pnl !== undefined && t.time && t.time >= todayStart.getTime())
    .reduce((acc, t) => acc + (parseFloat(t.pnl) || 0), 0);
  
  const netDailyPnl = totalRealizedPnl + totalUnrealizedPnl;
  const isNetPositive = netDailyPnl >= 0;
  const maxLossLimit = settings?.globalMaxLossUsdt || -100;
  const isApproachingLimit = netDailyPnl <= maxLossLimit * 0.8;


  // Handle single position close
  const handleCloseSingle = async (symbol: string) => {
    setClosingSymbol(symbol);
    setError(null);
    try {
      if (onClosePosition) {
        await onClosePosition(symbol);
      } else {
        const res = await fetch("/api/positions/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol }),
        });
        const data = await res.json();
        if (!data.success) {
          setError(data.message || `Failed to close position #${symbol}`);
        }
      }
      await fetchActivePositions();
    } catch (err: any) {
      setError(`Error closing ${symbol}: ${err.message}`);
    } finally {
      setClosingSymbol(null);
    }
  };

  // Handle Panic Close All positions immediately
  const handlePanicCloseAll = async () => {
    setIsPanicClosing(true);
    setError(null);
    setPanicSuccessMessage(null);
    try {
      const res = await fetch("/api/positions/close-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.success) {
        setPanicSuccessMessage(`Successfully closed ${data.closedCount || activePositions.length} active position(s) at Market Price.`);
        setActivePositions([]);
        setShowPanicModal(false);
        if (onRefresh) await onRefresh();
        setTimeout(() => setPanicSuccessMessage(null), 5000);
      } else {
        setError(data.error || "Failed to execute Panic Close All");
      }
    } catch (err: any) {
      setError(`Panic close error: ${err.message}`);
    } finally {
      setIsPanicClosing(false);
      setShowPanicModal(false);
      await fetchActivePositions();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Live PnL Action Bar */}
      <header className="pb-4 border-b border-neutral-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-3xl font-bold tracking-tight text-white">
                Active Positions & Live PnL
              </h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 text-xs font-semibold flex items-center gap-1.5 font-mono">
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                {activePositions.length} Open {activePositions.length === 1 ? "Trade" : "Trades"}
              </span>
            </div>
            <p className="text-neutral-400 text-sm">
              Real-time Bybit Demo Linear Perpetuals position monitoring with live mark price updates and instant execution.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => fetchActivePositions()}
              disabled={isLoading}
              className="p-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-800 transition-colors disabled:opacity-50 cursor-pointer"
              title="Refresh positions"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            </button>

            {/* Panic Close All Button (Red Emergency Button) */}
            <button
              onClick={() => setShowPanicModal(true)}
              disabled={activePositions.length === 0 || isPanicClosing}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-sm shadow-rose-950 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <ShieldAlert className="w-4 h-4" />
              Panic Close All
            </button>
          </div>
        </div>
      </header>

      {/* Notifications / Alerts */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-3 rounded-xl flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-white font-bold cursor-pointer">✕</button>
        </div>
      )}

      {panicSuccessMessage && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-3 rounded-xl flex items-center gap-2 text-xs font-medium">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>{panicSuccessMessage}</span>
        </div>
      )}

      {/* 1. Daily Trade Activity Metric Cards (Placed right below page header) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Today's Total Opened */}
        <div className="bg-neutral-900 border border-neutral-800 p-5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-neutral-400 font-medium">Today's Total Opened</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono">
              {analytics.todayOpenedCount}
            </span>
            <span className="text-xs text-neutral-500 font-mono">Trades</span>
          </div>
          <p className="text-[11px] text-neutral-500 mt-2">Executed today (00:00 UTC to now)</p>
        </div>

        {/* Card 2: Closed Trades */}
        <div className="bg-neutral-900 border border-neutral-800 p-5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-neutral-400 font-medium">Closed Trades</span>
            <FileText className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono">
              {analytics.todayClosedCount}
            </span>
            <span className="text-xs text-neutral-500 font-mono">Completed</span>
          </div>
          <p className="text-[11px] text-neutral-500 mt-2">Past positions fully settled</p>
        </div>

        {/* Card 3: Active Positions (showing current/5 slots) */}
        <div className="bg-neutral-900 border border-neutral-800 p-5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-neutral-400 font-medium">Active Positions</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono">
              {activePositions.length} <span className="text-neutral-500 text-lg font-normal">/ {maxSlots} Slots</span>
            </span>
          </div>
          <div className="mt-2 w-full bg-neutral-950 rounded-full h-1.5 overflow-hidden border border-neutral-800">
            <div 
              className={`h-full transition-all ${
                activePositions.length >= maxSlots ? "bg-rose-500" : "bg-blue-500"
              }`}
              style={{ width: `${Math.min(100, (activePositions.length / maxSlots) * 100)}%` }}
            />
          </div>
        </div>

        {/* Card 4: Exit Breakdown Mini-Stats */}
        <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-neutral-400 font-medium">Exit Breakdown</span>
            <Target className="w-4 h-4 text-purple-400" />
          </div>
          <div className="grid grid-cols-2 gap-1.5 font-mono">
            {/* TP Hit (Green Badge) */}
            <div className="bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-md flex items-center justify-between">
              <span className="text-[10px] text-emerald-400 font-semibold">TP Hit:</span>
              <span className="text-xs font-bold text-emerald-300">{analytics.tpHitCount}</span>
            </div>

            {/* Trailing Stop (Blue Badge) */}
            <div className="bg-blue-500/10 border border-blue-500/20 px-2 py-1 rounded-md flex items-center justify-between">
              <span className="text-[10px] text-blue-400 font-semibold">Trailing:</span>
              <span className="text-xs font-bold text-blue-300">{analytics.trailingStopCount}</span>
            </div>

            {/* SL Hit (Red Badge) */}
            <div className="bg-rose-500/10 border border-rose-500/20 px-2 py-1 rounded-md flex items-center justify-between">
              <span className="text-[10px] text-rose-400 font-semibold">SL Hit:</span>
              <span className="text-xs font-bold text-rose-300">{analytics.slHitCount}</span>
            </div>

            {/* Manual Close (Gray Badge) */}
            <div className="bg-neutral-800 border border-neutral-700 px-2 py-1 rounded-md flex items-center justify-between">
              <span className="text-[10px] text-neutral-300 font-semibold">Manual:</span>
              <span className="text-xs font-bold text-neutral-200">{analytics.manualCloseCount}</span>
            </div>
          </div>
          <p className="text-[10px] text-neutral-500 mt-1.5 text-center">Settled trigger distribution</p>
        </div>
      </div>

      {/* Floating PnL & Margin Summary Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
      
        {/* Today's Realized PnL */}
        <div className={`p-4 rounded-xl border transition-all ${
          totalRealizedPnl === 0
            ? "bg-neutral-900 border-neutral-800"
            : totalRealizedPnl > 0
            ? "bg-emerald-950/20 border-emerald-500/30"
            : "bg-rose-950/20 border-rose-500/30"
        }`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-neutral-400 font-medium">Today's Realized PnL</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold font-mono ${
              totalRealizedPnl === 0 ? "text-white" : totalRealizedPnl > 0 ? "text-emerald-400" : "text-rose-400"
            }`}>
              {totalRealizedPnl > 0 ? "+" : ""}${totalRealizedPnl.toFixed(2)}
            </span>
            <span className="text-xs text-neutral-500 font-mono">USDT</span>
          </div>
        </div>

        {/* Total Floating / Unrealized PnL Metric Card */}
        <div className={`p-4 rounded-xl border transition-all ${
          activePositions.length === 0
            ? "bg-neutral-900 border-neutral-800"
            : isPnlPositive
            ? "bg-emerald-950/20 border-emerald-500/30"
            : "bg-rose-950/20 border-rose-500/30"
        }`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-neutral-400 font-medium">Unrealized Floating PnL</span>
            {isPnlPositive ? (
              <TrendingUp className="w-4 h-4 text-emerald-400" />
            ) : (
              <TrendingDown className="w-4 h-4 text-rose-400" />
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold font-mono ${
              activePositions.length === 0 
                ? "text-white" 
                : isPnlPositive 
                ? "text-emerald-400" 
                : "text-rose-400"
            }`}>
              {totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}
            </span>
            <span className="text-xs text-neutral-500 font-mono">USDT</span>
            <span className={`text-xs font-bold font-mono ml-auto ${
              calculatedRoi >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}>
              ROI: {calculatedRoi >= 0 ? "+" : ""}{calculatedRoi.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Net Daily PnL */}
        <div className={`p-4 rounded-xl border transition-all ${
          isApproachingLimit ? "bg-rose-950/40 border-rose-500 animate-pulse" :
          isNetPositive ? "bg-neutral-900 border-neutral-800" : "bg-neutral-900 border-rose-500/30"
        }`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-neutral-400 font-medium">Net Daily PnL</span>
            {isApproachingLimit && <AlertTriangle className="w-4 h-4 text-rose-500 animate-bounce" />}
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold font-mono ${
              isNetPositive ? "text-white" : "text-rose-400"
            }`}>
              {isNetPositive && netDailyPnl > 0 ? "+" : ""}${netDailyPnl.toFixed(2)}
            </span>
            <span className="text-xs text-neutral-500 font-mono">USDT</span>
            {isApproachingLimit && (
              <span className="text-xs text-rose-500 ml-auto font-bold uppercase tracking-widest">Limit Risk</span>
            )}
          </div>
        </div>

        {/* Total Position Value */}
        <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-neutral-400 font-medium">Total Position Notional Value</span>
            <DollarSign className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-white font-mono">
              ${totalPositionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="text-xs text-neutral-500 font-mono">USDT</span>
          </div>
        </div>

        {/* Total Allocated Margin */}
        <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-neutral-400 font-medium">Active Locked Margin</span>
            <Layers className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-white font-mono">
              ${totalMargin.toFixed(2)}
            </span>
            <span className="text-xs text-neutral-500 font-mono">USDT</span>
            <span className="text-xs text-neutral-400 ml-auto font-mono">
              Leverage: {defaultLev}x
            </span>
          </div>
        </div>
      </div>

      {/* Main Content: Positions Table or Empty State */}
      {activePositions.length > 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-blue-400" />
              <h2 className="font-bold text-white text-sm">Open Contract Details</h2>
            </div>
            <span className="text-xs text-neutral-400">Bybit V5 Linear Perpetuals • Default {defaultLev}x</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-neutral-950 text-neutral-400 border-b border-neutral-800 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3.5 px-4">Symbol</th>
                  <th className="py-3.5 px-4">Side</th>
                  <th className="py-3.5 px-4">Size / Value</th>
                  <th className="py-3.5 px-4">Entry Price</th>
                  <th className="py-3.5 px-4">Mark Price</th>
                  <th className="py-3.5 px-4">Liquidation Price</th>
                  <th className="py-3.5 px-4">Unrealized PnL</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 font-mono">
                {activePositions.map((pos) => {
                  const isLong = pos.side?.toLowerCase() === "buy" || pos.side?.toLowerCase() === "long";
                  const pnlNum = parseFloat(pos.unrealisedPnl || "0");
                  const entryPriceNum = parseFloat(pos.avgPrice || "0");
                  const markPriceNum = parseFloat(pos.markPrice || "0");
                  const sizeNum = parseFloat(pos.size || "0");
                  const valueNum = (markPriceNum || entryPriceNum) * sizeNum;
                  const liqPriceNum = parseFloat(pos.liqPrice || "0");
                  const isPositive = pnlNum >= 0;
                  const isClosing = closingSymbol === pos.symbol;
                  const leverageValue = pos.leverage && parseInt(pos.leverage, 10) > 0 ? pos.leverage : String(defaultLev);

                  return (
                    <tr key={pos.symbol} className="hover:bg-neutral-800/40 transition-colors">
                      {/* Symbol */}
                      <td className="py-3.5 px-4 font-bold text-white text-sm">
                        <div className="flex items-center gap-2">
                          <span>{pos.symbol}</span>
                          <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20 font-mono">
                            {leverageValue}x
                          </span>
                        </div>
                      </td>

                      {/* Side Badge (LONG in green / SHORT in red) */}
                      <td className="py-3.5 px-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold ${
                            isLong
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {isLong ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                          {isLong ? "LONG" : "SHORT"}
                        </span>
                      </td>

                      {/* Size / Value */}
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-white">
                          {pos.size} contracts
                        </div>
                        <div className="text-[11px] text-neutral-400 font-normal">
                          ≈ ${valueNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
                        </div>
                      </td>

                      {/* Entry Price */}
                      <td className="py-3.5 px-4 text-neutral-300 font-semibold">
                        ${entryPriceNum >= 1000 
                          ? entryPriceNum.toLocaleString(undefined, { minimumFractionDigits: 2 }) 
                          : entryPriceNum.toFixed(entryPriceNum < 1 ? 4 : 2)}
                      </td>

                      {/* Mark Price */}
                      <td className="py-3.5 px-4 text-white font-bold">
                        ${markPriceNum >= 1000 
                          ? markPriceNum.toLocaleString(undefined, { minimumFractionDigits: 2 }) 
                          : markPriceNum.toFixed(markPriceNum < 1 ? 4 : 2)}
                      </td>

                      {/* Liquidation Price */}
                      <td className="py-3.5 px-4 text-neutral-400">
                        {liqPriceNum > 0 ? (
                          <span className="text-amber-400/90 font-medium">
                            ${liqPriceNum >= 1000 
                              ? liqPriceNum.toLocaleString(undefined, { minimumFractionDigits: 2 }) 
                              : liqPriceNum.toFixed(liqPriceNum < 1 ? 4 : 2)}
                          </span>
                        ) : (
                          <span className="text-neutral-600">--</span>
                        )}
                      </td>

                      {/* Unrealized PnL (USDT & %) */}
                      <td className="py-3.5 px-4">
                        <div className={`font-bold text-sm ${isPositive ? "text-emerald-400" : "text-rose-400"}`}>
                          {isPositive ? "+" : ""}${pnlNum.toFixed(2)} USDT
                        </div>
                        <div className={`text-[11px] ${isPositive ? "text-emerald-500" : "text-rose-500"}`}>
                          {pos.curRealisedPnl || (isPositive ? "+" : "") + ((entryPriceNum > 0 && sizeNum > 0 ? (pnlNum / ((entryPriceNum * sizeNum) / (parseFloat(leverageValue) || 10))) * 100 : 0).toFixed(2) + "%")}
                        </div>
                      </td>

                      {/* Actions: Individual Market Close Button */}
                      <td className="py-3.5 px-4 text-right">
                        <button
                          onClick={() => handleCloseSingle(pos.symbol)}
                          disabled={isClosing || isPanicClosing}
                          className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-rose-600 text-neutral-300 hover:text-white border border-neutral-700 hover:border-rose-500 text-xs font-semibold transition-all flex items-center gap-1.5 ml-auto disabled:opacity-50 cursor-pointer"
                        >
                          {isClosing ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5" />
                          )}
                          {isClosing ? "Closing..." : "Market Close"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Empty State: Clean centered state */
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-12 text-center flex flex-col items-center justify-center">
          <div className="w-14 h-14 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-3">
            <Activity className="w-7 h-7 text-blue-400 animate-pulse" />
          </div>
          <h3 className="text-base font-bold text-white mb-1.5">
            No Open Positions Currently Active
          </h3>
          <p className="text-xs text-neutral-400 max-w-md leading-relaxed mb-4">
            The automated trading engine is monitoring Bybit perpetuals with up to {maxSlots} concurrent position slots. When an approved 6-Gate signal executes, active trade positions and floating PnL will appear here.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => fetchActivePositions()}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-semibold border border-neutral-700 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh Position Status
            </button>
          </div>
        </div>
      )}

      {/* 2. Closed Trades Exit Reason Table */}
      <ClosedTradesExitAuditTable 
        closedTrades={analytics.closedTrades} 
        isLoading={isLoading} 
      />

      {/* 3. Stop Loss (SL) Root-Cause Diagnostics Panel */}
      <SlDiagnosticsPanel 
        slAudit={analytics.slAudit} 
        closedTrades={analytics.closedTrades} 
        slPercent={settings?.slPercent || 1.0} 
      />

      {/* Panic Close All Confirmation Modal */}
      {showPanicModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl">
                <ShieldAlert className="w-6 h-6 text-rose-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Emergency Panic Close All</h3>
                <p className="text-xs text-neutral-400">Immediate Market Exit Confirmation</p>
              </div>
            </div>

            <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800/80 space-y-2 text-xs">
              <p className="text-neutral-300">
                Are you sure you want to immediately close all <strong className="text-white font-bold">{activePositions.length} active position(s)</strong> at Market Price?
              </p>
              <div className="pt-2 border-t border-neutral-800 text-neutral-400 flex justify-between font-mono">
                <span>Total Floating PnL:</span>
                <span className={`font-bold ${totalUnrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)} USDT
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowPanicModal(false)}
                disabled={isPanicClosing}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handlePanicCloseAll}
                disabled={isPanicClosing}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-md shadow-rose-950 transition-all disabled:opacity-50 cursor-pointer"
              >
                <ShieldAlert className={`w-4 h-4 ${isPanicClosing ? "animate-spin" : ""}`} />
                {isPanicClosing ? "Closing All Positions..." : "Yes, Close All Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
