import { useEffect, useMemo, useState } from "react";
import { History, RefreshCw, RotateCcw } from "lucide-react";
import { Position, TradeHistory } from "../types";

interface HistoryPageProps {
  history: TradeHistory[];
  startingBalance?: number;
}

interface PerformanceBaseline {
  resetNumber: number;
  resetAt: number;
  walletBalance: number;
  estimatedEquity: number;
  cumulativeRealizedPnl: number;
  cumulativeTradeCount: number;
}

const BASELINE_STORAGE_KEY = "bybit-demo-performance-baselines-v1";

function loadBaselines(): PerformanceBaseline[] {
  try {
    const raw = window.localStorage.getItem(BASELINE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function HistoryPage({ history, startingBalance = 1000 }: HistoryPageProps) {
  const [walletBalance, setWalletBalance] = useState(0);
  const [positions, setPositions] = useState<Position[]>([]);
  const [baselines, setBaselines] = useState<PerformanceBaseline[]>(() => loadBaselines());
  const [resetting, setResetting] = useState(false);

  const refreshAccount = async () => {
    try {
      const [balanceRes, positionsRes] = await Promise.all([
        fetch("/api/balance").then(r => r.json()).catch(() => ({ success: false })),
        fetch("/api/positions/active").then(r => r.json()).catch(() => ({ success: false })),
      ]);
      if (balanceRes.success) setWalletBalance(Number(balanceRes.balance || 0));
      if (positionsRes.success && Array.isArray(positionsRes.positions)) setPositions(positionsRes.positions);
    } catch {
      // Preserve the last good account snapshot if Bybit is temporarily unavailable.
    }
  };

  useEffect(() => {
    refreshAccount();
    const timer = setInterval(refreshAccount, 5000);
    return () => clearInterval(timer);
  }, []);

  const closedTrades = useMemo(() => history.filter(t => typeof t.pnl === "number"), [history]);
  const totalClosedPnl = useMemo(() => closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0), [closedTrades]);
  const unrealizedPnl = positions.reduce((sum, p) => sum + Number(p.unrealisedPnl ?? p.unrealizedPnl ?? 0), 0);
  const estimatedEquity = walletBalance + unrealizedPnl;
  const activeBaseline = baselines.length ? baselines[baselines.length - 1] : null;

  const postResetTrades = activeBaseline ? closedTrades.filter(t => Number(t.time || 0) >= activeBaseline.resetAt) : closedTrades;
  const realizedSinceReset = activeBaseline ? totalClosedPnl - activeBaseline.cumulativeRealizedPnl : totalClosedPnl;
  const netSinceReset = activeBaseline ? estimatedEquity - activeBaseline.estimatedEquity : estimatedEquity - startingBalance;
  const wins = postResetTrades.filter(t => (t.pnl || 0) > 0).length;
  const losses = postResetTrades.filter(t => (t.pnl || 0) < 0).length;
  const winRate = postResetTrades.length ? (wins / postResetTrades.length) * 100 : 0;
  const averagePnl = postResetTrades.length ? realizedSinceReset / postResetTrades.length : 0;
  const tpCount = postResetTrades.filter(t => /TP|Take Profit/i.test(t.reason || "")).length;
  const slCount = postResetTrades.filter(t => /SL|Stop Loss/i.test(t.reason || "")).length;
  const trailingCount = postResetTrades.filter(t => /Trailing/i.test(t.reason || "")).length;

  const persistBaselines = (next: PerformanceBaseline[]) => {
    setBaselines(next);
    window.localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(next));
  };

  const resetPerformanceBaseline = async () => {
    setResetting(true);
    await refreshAccount();
    const nextReset: PerformanceBaseline = {
      resetNumber: baselines.length + 1,
      resetAt: Date.now(),
      walletBalance,
      estimatedEquity,
      cumulativeRealizedPnl: totalClosedPnl,
      cumulativeTradeCount: closedTrades.length,
    };
    persistBaselines([...baselines, nextReset]);
    setResetting(false);
  };

  const totalTrades = closedTrades.length;
  const allWins = closedTrades.filter(t => (t.pnl || 0) > 0).length;
  const allWinRate = totalTrades ? (allWins / totalTrades) * 100 : 0;

  return (
    <div className="space-y-6">
      <header className="pb-4 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Trade History & Performance Baseline</h1>
          <p className="text-neutral-400">Reset analytics to zero from a snapshot without changing Bybit balance, bot/scanner state, settings, or trade history.</p>
          <p className="text-xs text-blue-300 mt-2">Performance Baseline is independent from UTC daily trading stats.</p>
        </div>
        <button onClick={resetPerformanceBaseline} disabled={resetting || walletBalance <= 0} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white">
          {resetting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          Reset Performance Baseline
        </button>
      </header>

      <div className="bg-blue-950/20 border border-blue-500/30 rounded-xl p-4">
        {activeBaseline ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div><p className="text-neutral-500 text-xs">Active baseline</p><p className="font-bold text-blue-300">Reset #{activeBaseline.resetNumber}</p></div>
            <div><p className="text-neutral-500 text-xs">Reset date/time</p><p className="text-white">{new Date(activeBaseline.resetAt).toLocaleString()}</p></div>
            <div><p className="text-neutral-500 text-xs">Baseline wallet / equity</p><p className="text-white">${activeBaseline.walletBalance.toFixed(2)} / ${activeBaseline.estimatedEquity.toFixed(2)}</p></div>
          </div>
        ) : (
          <p className="text-sm text-neutral-300"><strong>Before Reset</strong> is active. Create Reset #1 to measure the strict strategy from a clean analytics zero point.</p>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard label="Realized since reset" value={`${realizedSinceReset >= 0 ? "+" : ""}${realizedSinceReset.toFixed(2)}`} positive={realizedSinceReset >= 0} />
        <MetricCard label="Unrealized PnL" value={`${unrealizedPnl >= 0 ? "+" : ""}${unrealizedPnl.toFixed(2)}`} positive={unrealizedPnl >= 0} />
        <MetricCard label="Net PnL since reset" value={`${netSinceReset >= 0 ? "+" : ""}${netSinceReset.toFixed(2)}`} positive={netSinceReset >= 0} />
        <MetricCard label="Trades / W-L" value={`${postResetTrades.length} / ${wins}-${losses}`} detail={`${winRate.toFixed(1)}% win rate`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"><p className="text-xs text-neutral-500">Exit counts since reset</p><p className="text-sm text-white mt-1">TP {tpCount} · SL {slCount} · Trailing {trailingCount}</p></div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"><p className="text-xs text-neutral-500">Average PnL / trade</p><p className={`text-lg font-bold ${averagePnl >= 0 ? "text-green-500" : "text-red-500"}`}>{averagePnl >= 0 ? "+" : ""}{averagePnl.toFixed(2)} USDT</p></div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"><p className="text-xs text-neutral-500">Wallet / estimated equity</p><p className="text-lg font-bold text-white">${walletBalance.toFixed(2)} / ${estimatedEquity.toFixed(2)}</p></div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
        <h2 className="font-semibold text-white mb-3">Before vs After Reset</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs whitespace-nowrap">
            <thead className="text-neutral-500"><tr><th className="text-left py-2">Baseline</th><th className="text-left py-2">Date/time</th><th className="text-right py-2">Wallet</th><th className="text-right py-2">Equity</th><th className="text-right py-2">Realized ref.</th><th className="text-right py-2">Trade ref.</th></tr></thead>
            <tbody className="divide-y divide-neutral-800">
              <tr><td className="py-2 text-white">Before Reset</td><td className="py-2 text-neutral-500">Original account view</td><td className="text-right">${startingBalance.toFixed(2)}</td><td className="text-right">${startingBalance.toFixed(2)}</td><td className="text-right">0.00</td><td className="text-right">0</td></tr>
              {baselines.map(b => <tr key={b.resetNumber}><td className="py-2 text-blue-300">Reset #{b.resetNumber}</td><td className="py-2 text-neutral-400">{new Date(b.resetAt).toLocaleString()}</td><td className="text-right">${b.walletBalance.toFixed(2)}</td><td className="text-right">${b.estimatedEquity.toFixed(2)}</td><td className="text-right">{b.cumulativeRealizedPnl.toFixed(2)}</td><td className="text-right">{b.cumulativeTradeCount}</td></tr>)}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-neutral-500 mt-3">Baseline history is stored durably in this browser and survives page reloads/restarts. It never writes to or zeros Bybit account data.</p>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 bg-neutral-900/50 flex items-center gap-2">
          <History className="w-5 h-5 text-neutral-400" />
          <h2 className="font-medium text-white">Bybit Closed PnL Log</h2>
          <span className="ml-auto text-xs text-neutral-500">All history preserved · {totalTrades} trades · {allWinRate.toFixed(1)}% all-time win rate</span>
        </div>
        {history.length === 0 ? <div className="p-8 text-center text-neutral-500">No closed trades yet.</div> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-neutral-950/50 text-neutral-400"><tr><th className="px-6 py-3 font-medium">Time</th><th className="px-6 py-3 font-medium">Symbol</th><th className="px-6 py-3 font-medium">Side</th><th className="px-6 py-3 font-medium">Size</th><th className="px-6 py-3 font-medium">Entry</th><th className="px-6 py-3 font-medium">Exit</th><th className="px-6 py-3 font-medium">Realized PnL</th></tr></thead>
            <tbody className="divide-y divide-neutral-800">{history.map(trade => {
              const isProfit = (trade.pnl ?? 0) >= 0;
              const entryPrice = Number(trade.entryPrice ?? 0);
              const exitPrice = Number(trade.exitPrice ?? 0);
              const qty = Number(trade.qty ?? trade.size ?? 0);
              const entryNotional = entryPrice > 0 && qty > 0 ? entryPrice * qty : 0;
              const realizedPnlPercent = entryNotional > 0 ? ((trade.pnl || 0) / entryNotional) * 100 : (trade.pnlPercent || 0);
              const isBuy = trade.side === "Buy" || trade.type === "buy";
              return <tr key={trade.id + trade.time} className="hover:bg-neutral-800/20"><td className="px-6 py-4 text-neutral-400">{new Date(trade.time).toLocaleString()}</td><td className="px-6 py-4 font-medium text-white">{trade.symbol}</td><td className="px-6 py-4"><span className={`px-2 py-1 rounded text-xs font-medium ${isBuy ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"}`}>{isBuy ? "LONG" : "SHORT"}</span></td><td className="px-6 py-4 text-neutral-300">{trade.qty}</td><td className="px-6 py-4 text-neutral-300">${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td><td className="px-6 py-4 text-neutral-300">${exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td><td className={`px-6 py-4 font-medium ${isProfit ? "text-green-500" : "text-red-500"}`}>{isProfit ? "+" : ""}{trade.pnl.toFixed(2)} USDT ({realizedPnlPercent >= 0 ? "+" : ""}{realizedPnlPercent.toFixed(2)}%)</td></tr>;
            })}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail, positive }: { label: string; value: string; detail?: string; positive?: boolean }) {
  const valueClass = positive === undefined ? "text-white" : positive ? "text-green-500" : "text-red-500";
  return <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"><p className="text-xs sm:text-sm text-neutral-400 mb-1">{label}</p><p className={`text-xl sm:text-2xl font-bold ${valueClass}`}>{value}</p>{detail && <p className="text-[11px] text-neutral-500 mt-1">{detail}</p>}</div>;
}
