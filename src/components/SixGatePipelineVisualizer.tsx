import React from "react";
import { 
  CheckCircle2, 
  Filter, 
  ArrowRight, 
  Sparkles, 
  Layers, 
  Activity, 
  ShieldCheck, 
  TrendingUp, 
  TrendingDown, 
  Zap,
  BarChart3,
  Scale
} from "lucide-react";
import { PipelineGateSummary } from "../types";

interface SixGatePipelineVisualizerProps {
  gates: PipelineGateSummary[];
  totalDiscovered: number | null;
  passedAllCount: number | null;
  activeSignalsCount: number | null;
  isScanning: boolean;
  onRefresh: () => void;
}

export function SixGatePipelineVisualizer({
  gates,
  totalDiscovered,
  passedAllCount,
  activeSignalsCount,
  isScanning,
  onRefresh,
}: SixGatePipelineVisualizerProps) {
  // Gate icons and metadata definitions matching the user's updated 6-Gate sequence
  const gateMeta: Record<number, { icon: React.ReactNode; ruleTag: string; accentColor: string; bgGlow: string }> = {
    1: {
      icon: <BarChart3 className="w-4 h-4 text-blue-400" />,
      ruleTag: "24h Turnover >= $25M",
      accentColor: "border-blue-500/40 text-blue-400",
      bgGlow: "bg-blue-500/10",
    },
    2: {
      icon: <TrendingUp className="w-4 h-4 text-cyan-400" />,
      ruleTag: "EMA50/EMA200 + confirmed price side",
      accentColor: "border-cyan-500/40 text-cyan-400",
      bgGlow: "bg-cyan-500/10",
    },
    3: {
      icon: <Scale className="w-4 h-4 text-emerald-400" />,
      ruleTag: "Bid-Ask Spread <= 0.08%",
      accentColor: "border-emerald-500/40 text-emerald-400",
      bgGlow: "bg-emerald-500/10",
    },
    4: {
      icon: <Activity className="w-4 h-4 text-amber-400" />,
      ruleTag: "5m ATR 0.30%–1.20%",
      accentColor: "border-amber-500/40 text-amber-400",
      bgGlow: "bg-amber-500/10",
    },
    5: {
      icon: <Zap className="w-4 h-4 text-purple-400" />,
      ruleTag: "Real Bybit 1h OI expansion >= +0.50%",
      accentColor: "border-purple-500/40 text-purple-400",
      bgGlow: "bg-purple-500/10",
    },
    6: {
      icon: <ShieldCheck className="w-4 h-4 text-rose-400" />,
      ruleTag: "RSI Long 50–64 / Short 36–50 · confirmed candle",
      accentColor: "border-rose-500/40 text-rose-400",
      bgGlow: "bg-rose-500/10",
    },
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-sm space-y-4">
      {/* Header & Metric Highlights */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-neutral-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600/20 to-purple-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-sm">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white tracking-tight">
                Symbol Selection & Validation Pipeline
              </h2>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> 6-Gate Funnel
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              Systematic quantitative elimination pipeline filtering out illiquid, counter-trend, high-spread, and low-volatility pairs.
            </p>
          </div>
        </div>

        {/* Funnel Pass-Through Trail summary readout */}
        <div className="flex flex-wrap items-center gap-2 self-start lg:self-center bg-neutral-950 px-3.5 py-2 rounded-xl border border-neutral-800">
          <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center gap-1">
            Pass-through Flow:
          </span>
          <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-neutral-200">
            <span className="text-neutral-400">{totalDiscovered ?? "—"}</span>
            {gates.length > 0 && <span className="text-neutral-600">→</span>}
            {gates.map((gate, i) => (
              <React.Fragment key={gate.gateNumber}>
                <span className={i === gates.length - 1 ? "text-emerald-400 font-extrabold" : "text-neutral-300"}>
                  {gate.passCount}
                </span>
                {i < gates.length - 1 && <span className="text-neutral-600">→</span>}
              </React.Fragment>
            ))}
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-sans">
              {activeSignalsCount ?? "—"} Active Signals
            </span>
          </div>
        </div>
      </div>

      {/* 6 Interconnected Horizontal Gate Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-3 relative">
        {gates.length === 0 && (
          <div className="md:col-span-2 lg:col-span-6 rounded-xl border border-neutral-800 bg-neutral-950 p-5 text-center">
            <p className="text-sm font-semibold text-neutral-300">Pipeline metrics unavailable</p>
            <p className="text-xs text-neutral-500 mt-1">No counts are fabricated while the backend scan is loading or unavailable.</p>
          </div>
        )}
        {gates.map((gate, index) => {
          const meta = gateMeta[gate.gateNumber] || {
            icon: <Activity className="w-4 h-4 text-neutral-400" />,
            ruleTag: gate.ruleDescription,
            accentColor: "border-neutral-700 text-neutral-300",
            bgGlow: "bg-neutral-800",
          };

          const isLast = index === gates.length - 1;

          return (
            <div
              key={gate.gateNumber}
              className={`relative bg-neutral-950 border rounded-xl p-3.5 flex flex-col justify-between transition-all hover:border-neutral-700 ${
                gate.passCount > 0
                  ? "border-neutral-800"
                  : "border-neutral-800/60 opacity-80"
              }`}
            >
              {/* Gate Step Header */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-400">
                    GATE {gate.gateNumber}
                  </span>
                  <div className={`p-1.5 rounded-lg ${meta.bgGlow} border ${meta.accentColor}`}>
                    {meta.icon}
                  </div>
                </div>

                <h3 className="font-bold text-white text-xs leading-snug mb-1 line-clamp-2">
                  {gate.name}
                </h3>
                <p className="text-[11px] text-neutral-400 leading-tight mb-3">
                  {gate.ruleDescription}
                </p>
              </div>

              {/* Gate Metrics & Status Badge */}
              <div className="pt-2 border-t border-neutral-900 mt-auto">
                <div className="flex items-center justify-between text-xs mb-1.5 font-mono">
                  <span className="text-neutral-500 text-[10px]">Pass Rate:</span>
                  <span className="font-bold text-neutral-200">
                    {gate.passCount} <span className="text-neutral-500 text-[10px]">({gate.passRatePercent}%)</span>
                  </span>
                </div>

                {/* Status Badge */}
                <div className="flex items-center justify-between">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                      gate.status === "Passed"
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                        : gate.status === "Active"
                        ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                        : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                    }`}
                  >
                    {gate.status === "Passed" ? (
                      <CheckCircle2 className="w-2.5 h-2.5" />
                    ) : (
                      <Filter className="w-2.5 h-2.5" />
                    )}
                    {gate.status}
                  </span>

                  <span className="text-[10px] text-neutral-500 font-mono">
                    {gate.passCount} pairs
                  </span>
                </div>
              </div>

              {/* Connecting arrow for desktop view */}
              {!isLast && (
                <div className="hidden lg:flex absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-6 h-6 rounded-full bg-neutral-900 border border-neutral-700 items-center justify-center text-neutral-400 shadow-sm pointer-events-none">
                  <ArrowRight className="w-3 h-3" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
