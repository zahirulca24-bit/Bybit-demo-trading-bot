import { useEffect, useMemo, useState } from "react";
import { History, RefreshCw, RotateCcw } from "lucide-react";
import { Position, TradeHistory } from "../types";
import { apiRequest, buildFreshAccountSnapshot } from "../utils/frontendContract";

interface HistoryPageProps { history: TradeHistory[]; startingBalance?: number | null; source?: string | null; metadataCoverage?: string | null; }
interface PerformanceBaseline { resetNumber: number; resetAt: number; walletBalance: number; estimatedEquity: number; cumulativeRealizedPnl: number; cumulativeTradeCount: number; }
const BASELINE_STORAGE_KEY = "bybit-demo-performance-baselines-v1";
const loadBaselines = (): PerformanceBaseline[] => { try { const value = JSON.parse(window.localStorage.getItem(BASELINE_STORAGE_KEY) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } };
const finite = (value: unknown): number | null => { if (value === null || value === undefined || value === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; };
const money = (value: unknown) => { const n = finite(value); return n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)} USDT`; };
const pct = (value: unknown) => { const n = finite(value); return n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`; };
const price = (value: unknown) => { const n = finite(value); return n === null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 4 })}`; };

export function HistoryPage({ history, startingBalance = null, source = null, metadataCoverage = null }: HistoryPageProps) {
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [baselines, setBaselines] = useState<PerformanceBaseline[]>(() => loadBaselines());
  const [resetting, setResetting] = useState(false);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const refreshAccount = async () => {
    const [balanceRes, positionsRes] = await Promise.all([apiRequest<any>("/api/balance"), apiRequest<any>("/api/positions/active")]);
    const snapshot = buildFreshAccountSnapshot(balanceRes, positionsRes);
    if (!snapshot) throw new Error("Fresh account snapshot is incomplete");
    setWalletBalance(snapshot.walletBalance); setPositions(snapshot.positions as Position[]); return snapshot;
  };
  useEffect(() => { void refreshAccount().catch(() => undefined); const timer = setInterval(() => void refreshAccount().catch(() => undefined), 5000); return () => clearInterval(timer); }, []);

  const knownPnlTrades = useMemo(() => history.filter(t => finite(t.realizedPnlUsdt ?? t.pnl) !== null), [history]);
  const totalClosedPnl = useMemo(() => knownPnlTrades.reduce((sum, t) => sum + (finite(t.realizedPnlUsdt ?? t.pnl) as number), 0), [knownPnlTrades]);
  const unrealizedValues = positions.map(p => finite(p.unrealisedPnl ?? p.unrealizedPnl));
  const unrealizedPnl = unrealizedValues.every(v => v !== null) ? unrealizedValues.reduce((sum, v) => sum + (v as number), 0) : null;
  const estimatedEquity = walletBalance !== null && unrealizedPnl !== null ? walletBalance + unrealizedPnl : null;
  const activeBaseline = baselines.length ? baselines[baselines.length - 1] : null;
  const postResetTrades = activeBaseline ? history.filter(t => (finite(t.time) ?? 0) >= activeBaseline.resetAt) : history;
  const postResetKnown = postResetTrades.filter(t => finite(t.realizedPnlUsdt ?? t.pnl) !== null);
  const realizedSinceReset = activeBaseline ? totalClosedPnl - activeBaseline.cumulativeRealizedPnl : totalClosedPnl;
  const netSinceReset = estimatedEquity === null ? null : activeBaseline ? estimatedEquity - activeBaseline.estimatedEquity : startingBalance === null ? null : estimatedEquity - startingBalance;
  const wins = postResetTrades.filter(t => t.outcome === "WIN" || finite(t.realizedPnlUsdt ?? t.pnl)! > 0).length;
  const losses = postResetTrades.filter(t => t.outcome === "LOSS" || (finite(t.realizedPnlUsdt ?? t.pnl) !== null && (finite(t.realizedPnlUsdt ?? t.pnl) as number) < 0)).length;
  const zeroOrUnknown = postResetTrades.length - wins - losses;
  const winRate = wins + losses > 0 ? wins / (wins + losses) * 100 : null;
  const averagePnl = postResetKnown.length ? realizedSinceReset / postResetKnown.length : null;
  const tpCount = postResetTrades.filter(t => /TP|Take Profit/i.test(t.reason || "")).length;
  const slCount = postResetTrades.filter(t => /SL|Stop Loss/i.test(t.reason || "")).length;
  const trailingCount = postResetTrades.filter(t => /Trailing/i.test(t.reason || "")).length;
  const persistBaselines = (next: PerformanceBaseline[]) => { setBaselines(next); window.localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(next)); };
  const resetPerformanceBaseline = async () => { setResetting(true); setBaselineError(null); try { const fresh = await refreshAccount(); persistBaselines([...baselines, { resetNumber: baselines.length + 1, resetAt: Date.now(), walletBalance: fresh.walletBalance, estimatedEquity: fresh.estimatedEquity, cumulativeRealizedPnl: totalClosedPnl, cumulativeTradeCount: history.length }]); } catch (err: any) { setBaselineError(err?.message || "Unable to create a fresh account baseline"); } finally { setResetting(false); } };
  const allWins = history.filter(t => t.outcome === "WIN" || (finite(t.realizedPnlUsdt ?? t.pnl) !== null && (finite(t.realizedPnlUsdt ?? t.pnl) as number) > 0)).length;
  const allLosses = history.filter(t => t.outcome === "LOSS" || (finite(t.realizedPnlUsdt ?? t.pnl) !== null && (finite(t.realizedPnlUsdt ?? t.pnl) as number) < 0)).length;
  const allZeroUnknown = history.length - allWins - allLosses;

  return <div className="space-y-6">
    <header className="pb-4 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div><h1 className="text-3xl font-bold text-white mb-2">Trade History & Performance Baseline</h1><p className="text-neutral-400">Canonical exchange facts: {source || "Bybit Closed PnL"}. Local strategy metadata is merged only by stable identifiers · metadata {metadataCoverage || "unknown"}.</p></div>
      <button onClick={resetPerformanceBaseline} disabled={resetting} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white">{resetting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {activeBaseline ? `Create Reset #${activeBaseline.resetNumber + 1}` : "Create Reset #1"}</button>
    </header>
    {baselineError && <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-sm text-rose-300">{baselineError}</div>}
    {activeBaseline ? <>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Metric label="Realized PnL USDT since reset" value={money(realizedSinceReset)} />
      <Metric label="Unrealized PnL USDT" value={money(unrealizedPnl)} />
      <Metric label="Net account change" value={money(netSinceReset)} />
      <Metric label="Trades / W / L / Zero-or-Unknown" value={`${postResetTrades.length} / ${wins} / ${losses} / ${zeroOrUnknown}`} detail={winRate === null ? "Win rate —" : `${winRate.toFixed(1)}% directional win rate`} />
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Metric label="Exit counts since reset" value={`TP ${tpCount} · SL ${slCount} · Trail ${trailingCount}`} />
      <Metric label="Average Realized PnL USDT" value={money(averagePnl)} />
      <Metric label="Wallet / estimated equity" value={walletBalance === null || estimatedEquity === null ? "—" : `$${walletBalance.toFixed(2)} / $${estimatedEquity.toFixed(2)}`} />
    </div>
    </> : <div className="bg-blue-950/20 border border-blue-500/30 rounded-xl p-5"><p className="font-semibold text-white">No performance baseline yet</p><p className="text-sm text-neutral-400 mt-1">Create Reset #1 to start measuring realized PnL and net account change from a fresh account snapshot. No “since reset” metric is shown until a baseline exists.</p></div>}
    {activeBaseline && <div className="bg-blue-950/20 border border-blue-500/30 rounded-xl p-4 text-sm text-neutral-300">Active baseline: Reset #{activeBaseline.resetNumber} · {new Date(activeBaseline.resetAt).toLocaleString()} · wallet ${activeBaseline.walletBalance.toFixed(2)} · equity ${activeBaseline.estimatedEquity.toFixed(2)}</div>}
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
      <div className="p-4 border-b border-neutral-800 flex items-center gap-2"><History className="w-5 h-5 text-neutral-400" /><h2 className="font-medium text-white">Bybit Closed PnL Log</h2><span className="ml-auto text-xs text-neutral-500">{history.length} Trades / {allWins} W / {allLosses} L / {allZeroUnknown} Zero-or-Unknown</span></div>
      {history.length === 0 ? <div className="p-8 text-center text-neutral-500">No closed Bybit records in the loaded window.</div> : <div className="overflow-x-auto"><table className="w-full text-left text-xs whitespace-nowrap min-w-[1250px]">
        <thead className="bg-neutral-950/50 text-neutral-400"><tr><th className="px-4 py-3">Time</th><th className="px-4 py-3">Symbol</th><th className="px-4 py-3">Bybit Close Side</th><th className="px-4 py-3">Filled Qty</th><th className="px-4 py-3">Avg Entry</th><th className="px-4 py-3">Avg Exit</th><th className="px-4 py-3">Realized PnL USDT</th><th className="px-4 py-3">Price Move %</th><th className="px-4 py-3">Return on Notional %</th><th className="px-4 py-3">ROE %</th></tr></thead>
        <tbody className="divide-y divide-neutral-800">{history.map(trade => <tr key={`${trade.id}:${trade.time ?? "unknown"}`} className="hover:bg-neutral-800/20"><td className="px-4 py-3 text-neutral-400">{finite(trade.time) === null ? "—" : new Date(trade.time as number).toLocaleString()}</td><td className="px-4 py-3 font-medium text-white">{trade.symbol || "—"}</td><td className="px-4 py-3 text-neutral-300">{trade.side ?? "—"}</td><td className="px-4 py-3 text-neutral-300">{finite(trade.filledQty ?? trade.qty) === null ? "—" : String(trade.filledQty ?? trade.qty)}</td><td className="px-4 py-3 text-neutral-300">{price(trade.entryPrice)}</td><td className="px-4 py-3 text-neutral-300">{price(trade.exitPrice)}</td><td className="px-4 py-3 font-semibold">{money(trade.realizedPnlUsdt ?? trade.pnl)}</td><td className="px-4 py-3">{pct(trade.priceMovePercent)}</td><td className="px-4 py-3">{pct(trade.returnOnNotionalPercent)}</td><td className="px-4 py-3">{pct(trade.roePercent)}</td></tr>)}</tbody>
      </table></div>}
    </div>
  </div>;
}
function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) { return <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"><p className="text-xs text-neutral-400 mb-1">{label}</p><p className="text-lg font-bold text-white">{value}</p>{detail && <p className="text-[11px] text-neutral-500 mt-1">{detail}</p>}</div>; }
