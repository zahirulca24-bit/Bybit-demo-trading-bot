import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Position, TradeHistory } from "../types";

interface HistoryPageProps {
  history: TradeHistory[];
  startingBalance?: number;
}

export function HistoryPage({ history, startingBalance = 1000 }: HistoryPageProps) {
  const [walletBalance, setWalletBalance] = useState(0);
  const [positions, setPositions] = useState<Position[]>([]);

  useEffect(() => {
    const refreshAccount = async () => {
      try {
        const [balanceRes, positionsRes] = await Promise.all([
          fetch("/api/balance").then(r => r.json()).catch(() => ({ success: false })),
          fetch("/api/positions/active").then(r => r.json()).catch(() => ({ success: false })),
        ]);
        if (balanceRes.success) setWalletBalance(Number(balanceRes.balance || 0));
        if (positionsRes.success && Array.isArray(positionsRes.positions)) setPositions(positionsRes.positions);
      } catch {
        // Keep the last good snapshot if a refresh temporarily fails.
      }
    };

    refreshAccount();
    const timer = setInterval(refreshAccount, 5000);
    return () => clearInterval(timer);
  }, []);

  const closedTrades = history.filter(t => typeof t.pnl === 'number');
  const totalTrades = closedTrades.length;
  const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0).length;
  const winRate = closedTrades.length > 0 ? ((winningTrades / closedTrades.length) * 100).toFixed(1) : "0.0";
  const totalClosedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + Number(p.unrealisedPnl ?? p.unrealizedPnl ?? 0), 0);
  const estimatedEquity = walletBalance + unrealizedPnl;
  const accountPnlVsStart = estimatedEquity - startingBalance;

  return (
    <div className="space-y-6">
      <header className="pb-4 border-b border-neutral-800">
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Trade History & Account Reconciliation</h1>
        <p className="text-neutral-400">Bybit closed-PnL history plus live wallet/equity reconciliation.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-sm text-neutral-400 mb-1">Bybit Closed Trades</p>
          <p className="text-3xl font-bold text-white">{totalTrades}</p>
          <p className="text-xs text-neutral-500 mt-2">Win rate: {winRate}%</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-sm text-neutral-400 mb-1">Closed PnL</p>
          <p className={`text-3xl font-bold ${totalClosedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {totalClosedPnl >= 0 ? '+' : ''}{totalClosedPnl.toFixed(2)}
          </p>
          <p className="text-xs text-neutral-500 mt-2">Sum of Bybit realized closed PnL</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-sm text-neutral-400 mb-1">Wallet / Est. Equity</p>
          <p className="text-2xl font-bold text-white">${walletBalance.toFixed(2)}</p>
          <p className="text-xs text-neutral-400 mt-2">Equity ≈ ${estimatedEquity.toFixed(2)} ({unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} floating)</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-sm text-neutral-400 mb-1">Account PnL vs ${startingBalance.toFixed(0)} Start</p>
          <p className={`text-3xl font-bold ${accountPnlVsStart >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {accountPnlVsStart >= 0 ? '+' : ''}{accountPnlVsStart.toFixed(2)}
          </p>
          <p className="text-xs text-neutral-500 mt-2">Wallet + unrealized minus starting balance</p>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 bg-neutral-900/50 flex items-center gap-2">
          <History className="w-5 h-5 text-neutral-400" />
          <h2 className="font-medium text-white">Bybit Closed PnL Log</h2>
        </div>

        {history.length === 0 ? (
          <div className="p-8 text-center text-neutral-500">No closed trades yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-neutral-950/50 text-neutral-400">
                <tr>
                  <th className="px-6 py-3 font-medium">Time</th>
                  <th className="px-6 py-3 font-medium">Symbol</th>
                  <th className="px-6 py-3 font-medium">Side</th>
                  <th className="px-6 py-3 font-medium">Size</th>
                  <th className="px-6 py-3 font-medium">Entry</th>
                  <th className="px-6 py-3 font-medium">Exit</th>
                  <th className="px-6 py-3 font-medium">Realized PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {history.map((trade) => {
                  const isProfit = (trade.pnl ?? 0) >= 0;
                  const entryPrice = Number(trade.entryPrice ?? 0);
                  const exitPrice = Number(trade.exitPrice ?? 0);
                  const qty = Number(trade.qty ?? trade.size ?? 0);
                  const entryNotional = entryPrice > 0 && qty > 0 ? entryPrice * qty : 0;
                  const realizedPnlPercent = entryNotional > 0 ? ((trade.pnl || 0) / entryNotional) * 100 : (trade.pnlPercent || 0);
                  const isBuy = trade.side === 'Buy' || (trade as any).type === 'buy';

                  return (
                    <tr key={trade.id + trade.time} className="hover:bg-neutral-800/20 transition-colors">
                      <td className="px-6 py-4 text-neutral-400">{new Date(trade.time).toLocaleString()}</td>
                      <td className="px-6 py-4 font-medium text-white">{trade.symbol}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${isBuy ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                          {isBuy ? 'LONG' : 'SHORT'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-neutral-300">{trade.qty}</td>
                      <td className="px-6 py-4 text-neutral-300">${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4 text-neutral-300">${exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className={`px-6 py-4 font-medium ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                        {isProfit ? '+' : ''}{trade.pnl.toFixed(2)} USDT ({realizedPnlPercent >= 0 ? '+' : ''}{realizedPnlPercent.toFixed(2)}%)
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
  );
}
