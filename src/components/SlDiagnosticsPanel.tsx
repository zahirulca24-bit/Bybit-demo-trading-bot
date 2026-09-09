import { useState } from "react";
import { 
  ShieldAlert, 
  AlertTriangle, 
  Clock, 
  Flame, 
  HelpCircle, 
  Lightbulb, 
  ChevronRight, 
  TrendingDown, 
  Activity, 
  Sliders, 
  Zap 
} from "lucide-react";
import { SlAuditSummary, ClosedTradeAuditItem } from "../types";

interface SlDiagnosticsPanelProps {
  slAudit: SlAuditSummary;
  closedTrades: ClosedTradeAuditItem[];
  slPercent?: number;
}

export function SlDiagnosticsPanel({ 
  slAudit, 
  closedTrades = [], 
  slPercent = 1.0 
}: SlDiagnosticsPanelProps) {
  const [selectedSlTrade, setSelectedSlTrade] = useState<ClosedTradeAuditItem | null>(null);

  const slTrades = closedTrades.filter(
    (t) => t.exitTrigger?.toLowerCase().includes("sl") || 
           t.exitTrigger?.toLowerCase().includes("stop loss") || 
           false
  );

  const formatDuration = (seconds: number) => {
    if (!seconds || seconds <= 0) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  return (
    <div id="sl-failure-analysis-panel" className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-neutral-800 bg-neutral-900/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-bold text-white text-sm flex items-center gap-2">
              SL Failure Analysis & Auto-Audit
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono">
                {slTrades.length} SL Triggered Today
              </span>
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Automated post-trade diagnostic engine evaluating stop-out patterns, duration velocity, and volatility spikes.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span className="font-mono bg-neutral-950 px-2.5 py-1 rounded-md border border-neutral-800">
            SL Parameter: -{slPercent.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Main Diagnostic Metrics 3-Column Grid */}
      <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-4 border-b border-neutral-800/80 bg-neutral-950/30">
        {/* Metric 1: Primary SL Cause */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-neutral-400 text-xs mb-2">
              <span className="font-medium">Primary SL Cause</span>
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-base font-bold text-amber-300 font-mono flex items-center gap-1.5">
              <span>{slAudit.primarySlCause || "Unavailable"}</span>
            </div>
          </div>
          <p className="text-[11px] text-neutral-500 mt-2">
            Identified across {slTrades.length > 0 ? slTrades.length : 0} liquidated/stopped sessions
          </p>
        </div>

        {/* Metric 2: Worst Performing Symbol */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-neutral-400 text-xs mb-2">
              <span className="font-medium">Worst Performing Symbol</span>
              <Flame className="w-4 h-4 text-rose-400" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-white font-mono">
                {slAudit.worstPerformingSymbol || "Unavailable"}
              </span>
              <span className="text-xs text-rose-400 font-mono">
                ({slAudit.slCountForWorst ?? "—"} SL Hits)
              </span>
            </div>
          </div>
          <p className="text-[11px] text-neutral-500 mt-2">
            Highest rate of stop-outs during high-frequency scalp cycles
          </p>
        </div>

        {/* Metric 3: Avg Time-to-SL */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-neutral-400 text-xs mb-2">
              <span className="font-medium">Avg Time-to-SL</span>
              <Clock className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-xl font-bold text-white font-mono">
              {formatDuration(slAudit.averageTimeToSlSeconds)}
            </div>
          </div>
          <p className="text-[11px] text-neutral-500 mt-2">
            Fast stop-outs indicate entry slippage or orderbook spread compression
          </p>
        </div>
      </div>

      {/* Dynamic Strategy Feedback Note Banner */}
      <div className="p-4 bg-blue-950/20 border-b border-neutral-800/80 flex items-start gap-3">
        <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 shrink-0 mt-0.5">
          <Lightbulb className="w-4 h-4" />
        </div>
        <div className="space-y-1">
          <h4 className="text-xs font-bold text-blue-300 uppercase tracking-wider">
            Automated Strategy Feedback & Adaptation Recommendation
          </h4>
          <p className="text-xs text-neutral-300 leading-relaxed">
            {slAudit.strategyFeedbackNote || "Unavailable — insufficient classified SL metadata."}
          </p>
        </div>
      </div>

      {/* Breakdown List of Recent Stop Losses */}
      {slTrades.length > 0 && (
        <div className="p-4 space-y-2">
          <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
            Recent SL Event Audit Log ({slTrades.length})
          </span>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {slTrades.slice(0, 4).map((trade) => (
              <div 
                key={trade.id + trade.time}
                className="bg-neutral-950 p-3 rounded-lg border border-neutral-800/80 flex items-center justify-between text-xs font-mono hover:border-neutral-700 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white">{trade.symbol}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                    {trade.side}
                  </span>
                  <span className="text-neutral-500 text-[11px]">
                    {trade.entryPrice === null ? "—" : `$${trade.entryPrice.toFixed(2)}`} → {trade.exitPrice === null ? "—" : `$${trade.exitPrice.toFixed(2)}`}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-rose-400 font-bold">
                    {trade.pnl === null ? "—" : `$${Math.abs(trade.pnl).toFixed(2)}`} ({trade.returnOnNotionalPercent == null ? "—" : `${trade.returnOnNotionalPercent.toFixed(2)}%`})
                  </span>
                  <div className="text-[10px] text-neutral-500">
                    {trade.slDiagnosticReason || "Wick Reversal"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
