import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  FileText,
  Layers,
  RefreshCw,
  ShieldAlert,
  Target,
  XCircle,
  Zap,
} from "lucide-react";
import { DailyTradeAnalytics, Position, RuntimeRiskStatus, Settings } from "../types";
import { ClosedTradesExitAuditTable } from "./ClosedTradesExitAuditTable";
import { SlDiagnosticsPanel } from "./SlDiagnosticsPanel";

export interface FormattedPosition {
  symbol: string;
  side: string;
  size: string;
  avgPrice: string;
  markPrice?: string;
  unrealisedPnl?: string;
  curRealisedPnl?: string;
  leverage?: string;
  stopLoss?: string;
  takeProfit?: string;
  liqPrice?: string;
  createdTime?: number;
  positionIdx?: number;
}

interface ActiveTradesPageProps {
  positions: Position[];
  settings: Settings;
  runtimeStatus: RuntimeRiskStatus;
  tradeHistory?: any[];
  onClosePosition: (symbol: string) => Promise<void> | void;
  onRefresh?: () => Promise<void> | void;
}

export function ActiveTradesPage({
  positions = [],
  settings,
  runtimeStatus,
  onClosePosition,
  onRefresh,
}: ActiveTradesPageProps) {
  const [activePositions, setActivePositions] = useState<FormattedPosition[]>([]);
  const [analytics, setAnalytics] = useState<DailyTradeAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [isPanicClosing, setIsPanicClosing] = useState(false);
  const [showPanicModal, setShowPanicModal] = useState(false);
  const [panicSuccessMessage, setPanicSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const maxSlots = runtimeStatus.maxPositions;
  const defaultLev = runtimeStatus.leverage;

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
      }

      if (analyticsRes.success && analyticsRes.analytics) setAnalytics(analyticsRes.analytics);
    } catch (err: any) {
      console.error("Failed to fetch active positions / analytics:", err);
      if (positions.length > 0) setActivePositions(positions as FormattedPosition[]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchActivePositions();
    const interval = setInterval(() => void fetchActivePositions(), 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (positions.length > 0) setActivePositions(positions as FormattedPosition[]);
  }, [positions]);

  const { totalPositionValue, totalMargin } = activePositions.reduce(
    (acc, pos) => {
      const pnl = Number(pos.unrealisedPnl || 0);
      const price = Number(pos.markPrice || pos.avgPrice || 0);
      const size = Number(pos.size || 0);
      const leverage = Number(pos.leverage || defaultLev) || defaultLev;
      const value = price * size;
      const margin = leverage > 0 ? value / leverage : value;
      acc.totalPositionValue += Number.isFinite(value) ? value : 0;
      acc.totalMargin += Number.isFinite(margin) ? margin : 0;
      acc.unrealized += Number.isFinite(pnl) ? pnl : 0;
      return acc;
    },
    { totalPositionValue: 0, totalMargin: 0, unrealized: 0 },
  );
  const calculatedRoiValue = analytics && totalMargin > 0 ? (analytics.unrealizedPnlToday / totalMargin) * 100 : null;

  const totalRealizedPnl = analytics ? Number(analytics.realizedPnlToday) : null;
  const totalUnrealizedPnl = analytics ? Number(analytics.unrealizedPnlToday) : null;
  const netDailyPnl = analytics ? Number(analytics.netDailyPnl) : null;
  const isNetPositive = netDailyPnl !== null && netDailyPnl >= 0;
  const maxLossLimit = runtimeStatus.dailyLossBreaker.limitUsdt;
  const isApproachingLimit = netDailyPnl !== null && maxLossLimit < 0 && netDailyPnl <= maxLossLimit * 0.8;

  const exitBreakdownTotal = analytics
    ? analytics.tpHitCount + analytics.slHitCount + analytics.trailingStopCount + analytics.manualCloseCount + analytics.otherExitCount
    : null;

  const handleCloseSingle = async (symbol: string) => {
    setClosingSymbol(symbol);
    setError(null);
    try {
      await onClosePosition(symbol);
      await fetchActivePositions();
    } catch (err: any) {
      setError(`Error submitting close for ${symbol}: ${err.message}`);
    } finally {
      setClosingSymbol(null);
    }
  };

  const handlePanicCloseAll = async () => {
    setIsPanicClosing(true);
    setError(null);
    setPanicSuccessMessage(null);
    try {
      const res = await fetch("/api/positions/close-all", { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await res.json();
      if (data.success) {
        const pending = Array.isArray(data.results) ? data.results.filter((item: any) => item.acknowledged && !item.fullyClosedFill).length : 0;
        setPanicSuccessMessage(`Close orders acknowledged. Fully confirmed closes: ${data.closedCount}; pending confirmation: ${pending}.`);
        setShowPanicModal(false);
        if (onRefresh) await onRefresh();
        setTimeout(() => setPanicSuccessMessage(null), 5000);
      } else {
        setError(data.error || data.results?.[0]?.error || "Failed to submit Panic Close All");
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
      <header className="pb-4 border-b border-neutral-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="text-3xl font-bold tracking-tight text-white">Active Positions & Live PnL</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 text-xs font-semibold font-mono">{activePositions.length} Open</span>
            </div>
            <p className="text-neutral-400 text-sm">Real-time Bybit Demo Linear Perpetuals position monitoring.</p>
            <div className="flex flex-wrap gap-2 mt-2 text-[11px] font-mono"><span className="px-2 py-1 rounded-md bg-neutral-900 border border-neutral-800 text-neutral-300">Trading Day: UTC</span><span className="px-2 py-1 rounded-md bg-neutral-900 border border-neutral-800 text-neutral-400">Window: 00:00 UTC – now</span></div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => void fetchActivePositions()} disabled={isLoading} className="p-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-800 disabled:opacity-50" title="Refresh positions"><RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} /></button>
            <button onClick={() => setShowPanicModal(true)} disabled={activePositions.length === 0 || isPanicClosing} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold disabled:opacity-40"><ShieldAlert className="w-4 h-4" />Panic Close All</button>
          </div>
        </div>
      </header>

      {runtimeStatus.breakerActive && <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 px-4 py-3 rounded-xl flex items-center gap-2 text-xs"><AlertTriangle className="w-4 h-4" /><span>New-entry breaker: {runtimeStatus.breakerReason}. Close/manage operations remain available.</span></div>}
      {error && <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-3 rounded-xl flex items-center gap-2 text-xs"><AlertTriangle className="w-4 h-4" /><span>{error}</span></div>}
      {panicSuccessMessage && <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-3 rounded-xl flex items-center gap-2 text-xs"><CheckCircle2 className="w-4 h-4" /><span>{panicSuccessMessage}</span></div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Today's Total Opened" value={analytics?.todayOpenedCount} detail="Opened since 00:00 UTC today" icon={<Zap className="w-4 h-4 text-amber-400" />} />
        <StatCard label="Closed Trades Today" value={analytics?.todayClosedCount} detail={`Wins ${analytics?.winningTradesCount ?? "—"} / Losses ${analytics?.losingTradesCount ?? "—"}`} icon={<FileText className="w-4 h-4 text-blue-400" />} />
        <StatCard label="Active Positions" value={`${activePositions.length} / ${maxSlots}`} detail="Live positions do not reset at midnight" icon={<Activity className="w-4 h-4 text-emerald-400" />} />
        <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl">
          <div className="flex items-center justify-between mb-2"><span className="text-xs text-neutral-400 font-medium">Exit Breakdown Today</span><Target className="w-4 h-4 text-purple-400" /></div>
          <div className="grid grid-cols-2 gap-1.5 font-mono"><StatBadge label="TP" value={analytics?.tpHitCount} className="text-emerald-300" /><StatBadge label="SL" value={analytics?.slHitCount} className="text-rose-300" /><StatBadge label="Trailing" value={analytics?.trailingStopCount} className="text-blue-300" /><StatBadge label="Manual" value={analytics?.manualCloseCount} className="text-neutral-200" /><div className="col-span-2"><StatBadge label="Other / Unknown" value={analytics?.otherExitCount} className="text-amber-300" /></div></div>
          <p className={`text-[10px] mt-1.5 text-center ${analytics && exitBreakdownTotal === analytics.todayClosedCount ? "text-neutral-500" : "text-rose-400"}`}>Categorized {exitBreakdownTotal ?? "—"} / {analytics?.todayClosedCount ?? "—"} closed</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
        <PnlCard label="Today's Realized PnL" value={totalRealizedPnl} />
        <PnlCard label="Unrealized PnL" value={totalUnrealizedPnl} suffix={calculatedRoiValue === null ? undefined : `ROI ${calculatedRoiValue >= 0 ? "+" : ""}${calculatedRoiValue.toFixed(2)}%`} />
        <div className={`p-4 rounded-xl border ${isApproachingLimit ? "bg-rose-950/40 border-rose-500" : "bg-neutral-900 border-neutral-800"}`}><div className="flex items-center justify-between mb-1"><span className="text-xs text-neutral-400 font-medium">Net Daily PnL</span>{isApproachingLimit && <AlertTriangle className="w-4 h-4 text-rose-500" />}</div><span className={`text-xl font-bold font-mono ${isNetPositive ? "text-white" : "text-rose-400"}`}>{netDailyPnl === null ? "—" : `${netDailyPnl > 0 ? "+" : ""}$${netDailyPnl.toFixed(2)}`}</span></div>
        <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl"><div className="flex items-center justify-between mb-1"><span className="text-xs text-neutral-400 font-medium">Total Position Notional</span><DollarSign className="w-4 h-4 text-blue-400" /></div><span className="text-xl font-bold text-white font-mono">${totalPositionValue.toFixed(2)}</span></div>
        <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl"><div className="flex items-center justify-between mb-1"><span className="text-xs text-neutral-400 font-medium">Active Locked Margin</span><Layers className="w-4 h-4 text-indigo-400" /></div><span className="text-xl font-bold text-white font-mono">${totalMargin.toFixed(2)}</span></div>
      </div>

      {activePositions.length > 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-neutral-800 flex items-center justify-between"><h2 className="font-bold text-white text-sm">Open Contract Details</h2><span className="text-xs text-neutral-400">Bybit V5 Linear Perpetuals • policy leverage {defaultLev}x</span></div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="bg-neutral-950 text-neutral-400 border-b border-neutral-800 uppercase text-[11px]"><th className="py-3.5 px-4">Symbol</th><th className="py-3.5 px-4">Side</th><th className="py-3.5 px-4">Size / Value</th><th className="py-3.5 px-4">Entry</th><th className="py-3.5 px-4">Mark</th><th className="py-3.5 px-4">Unrealized PnL</th><th className="py-3.5 px-4 text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-neutral-800 font-mono">
                {activePositions.map((pos) => {
                  const isLong = pos.side?.toLowerCase() === "buy" || pos.side?.toLowerCase() === "long";
                  const pnlNum = Number(pos.unrealisedPnl || 0);
                  const entryPriceNum = Number(pos.avgPrice || 0);
                  const markPriceNum = Number(pos.markPrice || 0);
                  const sizeNum = Number(pos.size || 0);
                  const valueNum = (markPriceNum || entryPriceNum) * sizeNum;
                  const isClosing = closingSymbol === pos.symbol;
                  return (
                    <tr key={`${pos.symbol}-${pos.positionIdx ?? 0}`} className="hover:bg-neutral-800/40">
                      <td className="py-3.5 px-4 font-bold text-white">{pos.symbol}</td>
                      <td className="py-3.5 px-4"><span className={`px-2.5 py-1 rounded-md text-xs font-bold ${isLong ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>{isLong ? "LONG" : "SHORT"}</span></td>
                      <td className="py-3.5 px-4 text-neutral-300">{pos.size} ≈ ${valueNum.toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-neutral-300">${entryPriceNum.toFixed(entryPriceNum < 1 ? 4 : 2)}</td>
                      <td className="py-3.5 px-4 text-white">${markPriceNum.toFixed(markPriceNum < 1 ? 4 : 2)}</td>
                      <td className={`py-3.5 px-4 font-bold ${pnlNum >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{pnlNum >= 0 ? "+" : ""}${pnlNum.toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-right"><button onClick={() => void handleCloseSingle(pos.symbol)} disabled={isClosing || isPanicClosing} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-rose-600 text-neutral-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 ml-auto disabled:opacity-50">{isClosing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}{isClosing ? "Submitting..." : "Market Close"}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-10 text-center"><Activity className="w-8 h-8 text-blue-400 mx-auto mb-3" /><h3 className="font-bold text-white mb-1">No Confirmed Open Positions</h3><p className="text-xs text-neutral-400">Position state is sourced from Bybit; acknowledged close orders are not removed until state confirms the change.</p></div>
      )}

      <ClosedTradesExitAuditTable closedTrades={analytics?.closedTrades ?? []} isLoading={isLoading || analytics === null} />
      {analytics && <SlDiagnosticsPanel slAudit={analytics.slAudit} closedTrades={analytics.closedTrades} slPercent={settings.slPercent} />}

      {showPanicModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3 text-rose-400"><ShieldAlert className="w-6 h-6" /><div><h3 className="text-lg font-bold text-white">Emergency Panic Close All</h3><p className="text-xs text-neutral-400">Submit reduce-only market exits; fills are confirmed separately.</p></div></div>
            <p className="text-xs text-neutral-300">Submit close orders for all <strong>{activePositions.length}</strong> active position(s)?</p>
            <div className="flex justify-end gap-3"><button onClick={() => setShowPanicModal(false)} className="px-4 py-2 rounded-xl bg-neutral-800 text-neutral-300 text-xs">Cancel</button><button onClick={() => void handlePanicCloseAll()} disabled={isPanicClosing} className="px-5 py-2 rounded-xl bg-rose-600 text-white text-xs font-bold disabled:opacity-50">{isPanicClosing ? "Submitting..." : "Submit Close All"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, detail, icon }: { label: string; value: string | number | undefined; detail: string; icon: React.ReactNode }) {
  return <div className="bg-neutral-900 border border-neutral-800 p-5 rounded-xl"><div className="flex items-center justify-between mb-2"><span className="text-xs text-neutral-400 font-medium">{label}</span>{icon}</div><p className="text-2xl font-bold text-white font-mono">{value ?? "—"}</p><p className="text-[11px] text-neutral-500 mt-2">{detail}</p></div>;
}

function StatBadge({ label, value, className }: { label: string; value: number | undefined; className: string }) {
  return <div className="bg-neutral-950 border border-neutral-800 px-2 py-1 rounded-md flex items-center justify-between"><span className="text-[10px] text-neutral-400 font-semibold">{label}:</span><span className={`text-xs font-bold ${className}`}>{value ?? "—"}</span></div>;
}

function PnlCard({ label, value, suffix }: { label: string; value: number | null; suffix?: string }) {
  return <div className={`p-4 rounded-xl border ${value === null || value === 0 ? "bg-neutral-900 border-neutral-800" : value > 0 ? "bg-emerald-950/20 border-emerald-500/30" : "bg-rose-950/20 border-rose-500/30"}`}><span className="text-xs text-neutral-400 font-medium">{label}</span><div className="flex items-baseline gap-2 mt-1"><span className={`text-xl font-bold font-mono ${value === null || value === 0 ? "text-white" : value > 0 ? "text-emerald-400" : "text-rose-400"}`}>{value === null ? "—" : `${value > 0 ? "+" : ""}$${value.toFixed(2)}`}</span>{suffix && <span className="text-[10px] text-neutral-500 ml-auto">{suffix}</span>}</div></div>;
}
