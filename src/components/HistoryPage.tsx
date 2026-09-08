import { History } from "lucide-react";
import { TradeHistory } from "../types";

interface HistoryPageProps {
  history: TradeHistory[];
}

export function HistoryPage({ history }: HistoryPageProps) {
  const closedTrades = history.filter(t => typeof t.pnl === 'number');
  const totalTrades = history.length;
  const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0).length;
  const winRate = closedTrades.length > 0 ? ((winningTrades / closedTrades.length) * 100).toFixed(1) : "0.0";
  const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  return (
    <div className="space-y-6">
      <header className="pb-4 border-b border-neutral-800">
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Trade History & PnL</h1>
        <p className="text-neutral-400">Past executions and performance metrics.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
          <p className="text-sm text-neutral-400 mb-1">Total Trades</p>
          <p className="text-3xl font-bold text-white">{totalTrades}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
          <p className="text-sm text-neutral-400 mb-1">Win Rate</p>
          <p className="text-3xl font-bold text-white">{winRate}%</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
          <p className="text-sm text-neutral-400 mb-1">Total PnL (USDT)</p>
          <p className={`text-3xl font-bold ${totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 bg-neutral-900/50 flex items-center gap-2">
          <History className="w-5 h-5 text-neutral-400" />
          <h2 className="font-medium text-white">Execution Log</h2>
        </div>
        
        {history.length === 0 ? (
          <div className="p-8 text-center text-neutral-500">
            No closed trades yet.
          </div>
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
                  <th className="px-6 py-3 font-medium">Reason</th>
                  <th className="px-6 py-3 font-medium">Realized PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {history.map((trade) => {
                  const isProfit = (trade.pnl ?? 0) >= 0;
                  const entryPrice = trade.entryPrice ?? (trade as any).price;
                  const exitPrice = trade.exitPrice;
                  const isBuy = trade.side === 'Buy' || (trade as any).type === 'buy';

                  return (
                    <tr key={trade.id + trade.time} className="hover:bg-neutral-800/20 transition-colors">
                      <td className="px-6 py-4 text-neutral-400">{new Date(trade.time).toLocaleTimeString()}</td>
                      <td className="px-6 py-4 font-medium text-white">{trade.symbol}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${isBuy ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                          {isBuy ? 'LONG' : 'SHORT'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-neutral-300">{trade.qty}</td>
                      <td className="px-6 py-4 text-neutral-300">
                        {entryPrice !== undefined && entryPrice !== null
                          ? `$${Number(entryPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '-'}
                      </td>
                      <td className="px-6 py-4 text-neutral-300">
                        {exitPrice !== undefined && exitPrice !== null
                          ? `$${Number(exitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '-'}
                      </td>
                      <td className="px-6 py-4 text-neutral-400 text-xs">{trade.reason || '-'}</td>
                      <td className={`px-6 py-4 font-medium ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                        {typeof trade.pnl === 'number'
                          ? `${isProfit ? '+' : ''}${trade.pnl.toFixed(2)} USDT (${(trade.pnlPercent ?? 0).toFixed(2)}%)`
                          : '-'}
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
