import { useState } from "react";
import { 
  History, 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Target, 
  Activity, 
  Clock, 
  Sliders, 
  ChevronDown, 
  Filter, 
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { ClosedTradeAuditItem } from "../types";

interface ClosedTradesExitAuditTableProps {
  closedTrades: ClosedTradeAuditItem[];
  isLoading?: boolean;
}

export function ClosedTradesExitAuditTable({
  closedTrades = [],
  isLoading = false,
}: ClosedTradesExitAuditTableProps) {
  const [filterType, setFilterType] = useState<string>("ALL");

  const filteredTrades = closedTrades.filter((t) => {
    if (filterType === "ALL") return true;
    if (filterType === "TP") return t.exitTrigger?.includes("TP");
    if (filterType === "SL") return /(^|\b)SL(\b|$)|Stop Loss/i.test(t.exitTrigger || "");
    if (filterType === "TRAILING") return t.exitTrigger?.includes("Trailing");
    if (filterType === "MANUAL") return t.exitTrigger?.includes("Manual");
    if (filterType === "OTHER") return /Unknown|Other/i.test(t.exitTrigger || "");
    return true;
  });

  const getExitBadge = (trigger: string) => {
    const tr = trigger.toLowerCase();
    if (tr.includes("tp") || tr.includes("take profit")) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          <Target className="w-3 h-3" />
          {trigger}
        </span>
      );
    }
    if (tr.includes("sl") || tr.includes("stop loss") || tr.includes("hard sl")) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">
          <ShieldAlert className="w-3 h-3" />
          {trigger}
        </span>
      );
    }
    if (tr.includes("trailing")) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-blue-500/10 text-blue-400 border border-blue-500/30">
          <Activity className="w-3 h-3" />
          {trigger}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-neutral-800 text-neutral-300 border border-neutral-700">
        <Clock className="w-3 h-3" />
        {trigger || "Other / Unknown"}
      </span>
    );
  };

  return (
    <div id="closed-trades-exit-audit" className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
      {/* Table Header */}
      <div className="p-4 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-neutral-900/90">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-emerald-400" />
          <h2 className="font-bold text-white text-sm">Today's Closed Trades & Exit Audit</h2>
          <span className="text-xs text-neutral-400 ml-1 font-mono">
            ({closedTrades.length} Total Closed)
          </span>
        </div>

        {/* Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs">
          {[
            { label: "All Closed", value: "ALL" },
            { label: "Take Profit", value: "TP" },
            { label: "Trailing Stop", value: "TRAILING" },
            { label: "Stop Loss", value: "SL" },
            { label: "Manual", value: "MANUAL" },
            { label: "Other / Unknown", value: "OTHER" },
          ].map((f) => (
            <button
              key={f.value}
              onClick={() => setFilterType(f.value)}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors whitespace-nowrap cursor-pointer ${
                filterType === f.value
                  ? "bg-neutral-700 text-white border border-neutral-600"
                  : "bg-neutral-950 text-neutral-400 hover:text-neutral-200 border border-neutral-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-2.5 border-b border-neutral-800 bg-neutral-950/40 text-[11px] text-neutral-500">
        Unknown means Bybit metadata was insufficient to classify the exit reliably. The app does not infer exit reason from PnL sign.
      </div>

      {/* Table Body */}
      {filteredTrades.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-neutral-950 text-neutral-400 border-b border-neutral-800 font-semibold uppercase tracking-wider text-[11px]">
                <th className="py-3.5 px-4">Symbol & Side</th>
                <th className="py-3.5 px-4">Entry Price</th>
                <th className="py-3.5 px-4">Exit Price</th>
                <th className="py-3.5 px-4">Realized PnL ($ & %)</th>
                <th className="py-3.5 px-4">Exit Trigger Type</th>
                <th className="py-3.5 px-4 text-right">Exit Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 font-mono">
              {filteredTrades.map((trade) => {
                const isLong = trade.side?.toLowerCase() === "buy" || trade.side?.toLowerCase() === "long";
                const isPositive = trade.pnl >= 0;
                const formattedTime = new Date(trade.time).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                });
                const formattedDate = new Date(trade.time).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                });

                return (
                  <tr key={trade.id + trade.time} className="hover:bg-neutral-800/40 transition-colors">
                    {/* Symbol & Side */}
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm">{trade.symbol}</span>
                        <span
                          className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                            isLong
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {isLong ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {isLong ? "LONG" : "SHORT"}
                        </span>
                      </div>
                      <div className="text-[11px] text-neutral-500 font-normal mt-0.5">
                        Size: {trade.qty} contracts
                      </div>
                    </td>

                    {/* Entry Price */}
                    <td className="py-3.5 px-4 text-neutral-300 font-semibold">
                      ${trade.entryPrice >= 1000 
                        ? trade.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 }) 
                        : trade.entryPrice.toFixed(trade.entryPrice < 1 ? 4 : 2)}
                    </td>

                    {/* Exit Price */}
                    <td className="py-3.5 px-4 text-white font-semibold">
                      ${trade.exitPrice >= 1000 
                        ? trade.exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 }) 
                        : trade.exitPrice.toFixed(trade.exitPrice < 1 ? 4 : 2)}
                    </td>

                    {/* Realized PnL ($ and %) */}
                    <td className="py-3.5 px-4">
                      <div className={`font-bold text-sm ${isPositive ? "text-emerald-400" : "text-rose-400"}`}>
                        {isPositive ? "+" : ""}${trade.pnl.toFixed(2)} USDT
                      </div>
                      <div className={`text-[11px] ${isPositive ? "text-emerald-500" : "text-rose-500"}`}>
                        {isPositive ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
                      </div>
                    </td>

                    {/* Exit Trigger Type Badge */}
                    <td className="py-3.5 px-4">
                      {getExitBadge(trade.exitTrigger)}
                      {trade.slDiagnosticReason && (
                        <div className="text-[10px] text-neutral-500 mt-1">
                          Cause: {trade.slDiagnosticReason}
                        </div>
                      )}
                    </td>

                    {/* Exit Timestamp */}
                    <td className="py-3.5 px-4 text-right text-neutral-400">
                      <div className="text-neutral-200 font-semibold">{formattedTime} UTC</div>
                      <div className="text-[11px] text-neutral-500">{formattedDate}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-8 text-center text-neutral-500 text-xs">
          No closed trades recorded today matching the selected filter.
        </div>
      )}
    </div>
  );
}
