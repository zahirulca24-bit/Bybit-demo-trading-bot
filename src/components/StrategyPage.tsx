import React, { useState, useEffect } from "react";
import { Plus, X, Activity, ShieldCheck, Zap, Layers, RefreshCw } from "lucide-react";
import { Technicals, TradeHistory, KlineUpdatePayload, ScannerState, Position, PipelineState, RuntimeRiskStatus } from "../types";
import { SixGatePipelineVisualizer } from "./SixGatePipelineVisualizer";
import { ScannedPairsTable } from "./ScannedPairsTable";
import { HighDensityScannerGrid } from "./HighDensityScannerGrid";
import { MarketScannerTable } from "./MarketScannerTable";

interface StrategyPageProps {
  watchlist: string[];
  technicals: Record<string, Technicals>;
  toggleWatchlist: (symbol: string, remove: boolean) => void;
  trades?: TradeHistory[];
  latestKlineUpdate?: KlineUpdatePayload | null;
  prices?: Record<string, number>;
  scannerState: ScannerState;
  runtimeStatus: RuntimeRiskStatus;
  activePositions: Position[];
  onToggleAutoTrade: (autoTrade: boolean) => void;
  onScanNow: () => void;
  onRefreshMarkets: () => void;
  onSetMaxConcurrent: (max: number) => void;
  onQuickBuy: (symbol: string) => void;
}

export function StrategyPage({
  watchlist,
  technicals,
  toggleWatchlist,
  trades = [],
  latestKlineUpdate,
  prices = {},
  scannerState,
  runtimeStatus,
  activePositions = [],
  onToggleAutoTrade,
  onScanNow,
  onRefreshMarkets,
  onSetMaxConcurrent,
  onQuickBuy,
}: StrategyPageProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string>("BTCUSDT");
  const [activeTab, setActiveTab] = useState<"pipeline" | "5m_grid" | "turnover">("pipeline");
  const [pipelineData, setPipelineData] = useState<PipelineState | null>(null);
  const [isPipelineScanning, setIsPipelineScanning] = useState<boolean>(true);

  const activeSymbol = selectedSymbol || watchlist[0] || "BTCUSDT";

  const fetchPipeline = async (forceRefresh = false) => {
    setIsPipelineScanning(true);
    try {
      const url = forceRefresh ? "/api/scanner/pipeline/scan-now" : "/api/scanner/pipeline";
      const res = await (forceRefresh ? fetch(url, { method: "POST" }) : fetch(url));
      const data = await res.json();
      if (data.success && data.pipeline) setPipelineData(data.pipeline);
    } catch (err) {
      console.error("Failed to fetch pipeline data:", err);
    } finally {
      setIsPipelineScanning(false);
    }
  };

  useEffect(() => {
    void fetchPipeline(false);
    const interval = setInterval(() => void fetchPipeline(false), 15000);
    return () => clearInterval(interval);
  }, []);

  const cooldownMinutes = Math.round(runtimeStatus.cooldown.symbolMs / 60_000);
  const lossPauseMinutes = Math.round(runtimeStatus.consecutiveLossBreaker.pauseMs / 60_000);
  const executionControls = [
    "EMA50/200 = hard trend filter",
    "EMA9/21 = soft entry timing / quality confirmation",
    "Breakout = soft bonus only",
    `Max positions ${runtimeStatus.maxPositions}`,
    `$${runtimeStatus.marginCapUsdt} margin at ${runtimeStatus.leverage}x (~$${runtimeStatus.approximateMaxNotionalUsdt} notional)`,
    runtimeStatus.duplicateSymbolPolicy === "DENY_SAME_SYMBOL" ? "No duplicate same-symbol position" : runtimeStatus.duplicateSymbolPolicy,
    `${cooldownMinutes}m same-symbol post-close cooldown`,
    `Daily $${runtimeStatus.dailyLossBreaker.limitUsdt} net entry breaker`,
    `${runtimeStatus.consecutiveLossBreaker.losses} losses => ${lossPauseMinutes}m pause`,
    `Breaker scope: ${runtimeStatus.dailyLossBreaker.scope.replaceAll("_", " ")}`,
    `Adaptive SL mode: ${runtimeStatus.stopLossDiscipline.mode.replaceAll("_", " ")}`,
    `Initial SL distance: ${runtimeStatus.stopLossDiscipline.minInitialDistancePercent.toFixed(2)}%–${runtimeStatus.stopLossDiscipline.maxInitialDistancePercent.toFixed(2)}%`,
    `Break-even ATR quality multiple: ${runtimeStatus.stopLossDiscipline.breakEvenAtrMultiple.toFixed(2)}×`,
    runtimeStatus.stopLossDiscipline.neverWiden ? "SL never widened" : "Stop-loss policy supplied by backend",
  ];

  return (
    <div className="space-y-6">
      <header className="pb-4 border-b border-neutral-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Market Scanner & Strategy</h1>
            <p className="text-neutral-400 text-sm">
              Strict 6-gate confirmed-candle pipeline for Bybit linear USDT contracts. Breakout is scoring confirmation only.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center border border-neutral-800 rounded-xl p-1 bg-neutral-900">
              <button onClick={() => setActiveTab("pipeline")} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${activeTab === "pipeline" ? "bg-blue-600 text-white shadow-sm" : "text-neutral-400 hover:text-white"}`}>
                <Layers className="w-3.5 h-3.5" /> 6-Gate Pipeline
              </button>
              <button onClick={() => setActiveTab("5m_grid")} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${activeTab === "5m_grid" ? "bg-blue-600 text-white shadow-sm" : "text-neutral-400 hover:text-white"}`}>
                <Zap className="w-3.5 h-3.5" /> Legacy Info
              </button>
              <button onClick={() => setActiveTab("turnover")} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${activeTab === "turnover" ? "bg-blue-600 text-white shadow-sm" : "text-neutral-400 hover:text-white"}`}>
                <Activity className="w-3.5 h-3.5" /> Turnover Rankings
              </button>
            </div>
            {activeTab === "pipeline" && (
              <button onClick={() => void fetchPipeline(true)} disabled={isPipelineScanning} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-neutral-700 text-neutral-300 hover:text-white text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer" title="Force refresh 6-Gate scan">
                <RefreshCw className={`w-3.5 h-3.5 ${isPipelineScanning ? "animate-spin text-blue-400" : ""}`} />
                <span>{isPipelineScanning ? "Scanning..." : "Scan"}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {activeTab === "pipeline" && (
        <div className="space-y-6">
          <SixGatePipelineVisualizer
            gates={pipelineData?.gates ?? []}
            totalDiscovered={pipelineData?.totalDiscovered ?? null}
            passedAllCount={pipelineData?.passedAllCount ?? null}
            activeSignalsCount={pipelineData?.activeSignalsCount ?? null}
            isScanning={isPipelineScanning}
            onRefresh={() => void fetchPipeline(true)}
          />
          <ScannedPairsTable symbols={pipelineData?.symbols || []} selectedSymbol={activeSymbol} onSelectSymbol={setSelectedSymbol} onQuickBuy={onQuickBuy} isScanning={isPipelineScanning} />
        </div>
      )}

      {activeTab === "5m_grid" && (
        <HighDensityScannerGrid scannerState={scannerState} activePositions={activePositions} selectedSymbol={activeSymbol} onSelectSymbol={setSelectedSymbol} onQuickBuy={onQuickBuy} />
      )}

      {activeTab === "turnover" && (
        <MarketScannerTable scannerState={scannerState} activePositions={activePositions} selectedSymbol={activeSymbol} onSelectSymbol={setSelectedSymbol} onToggleAutoTrade={onToggleAutoTrade} onScanNow={onScanNow} onRefreshMarkets={onRefreshMarkets} onSetMaxConcurrent={onSetMaxConcurrent} onQuickBuy={onQuickBuy} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 sm:p-6 lg:col-span-2 space-y-4">
          <h2 className="font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            6-Gate Quantitative Strategy Blueprint
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="bg-neutral-950 p-3 sm:p-4 rounded-lg border border-neutral-800/80">
              <ul className="space-y-2 text-neutral-300">
                <li><strong className="text-emerald-400">Gate 1:</strong> Min $25M 24h turnover</li>
                <li><strong className="text-emerald-400">Gate 2:</strong> EMA50/EMA200 direction + confirmed price correct side of EMA50</li>
                <li><strong className="text-emerald-400">Gate 3:</strong> Spread &lt;= 0.08%</li>
              </ul>
            </div>
            <div className="bg-neutral-950 p-3 sm:p-4 rounded-lg border border-neutral-800/80">
              <ul className="space-y-2 text-neutral-300">
                <li><strong className="text-blue-400">Gate 4:</strong> ATR 0.30%–1.20%</li>
                <li><strong className="text-blue-400">Gate 5:</strong> Bybit real 1h OI expansion &gt;= +0.50%; unavailable = fail</li>
                <li><strong className="text-blue-400">Gate 6:</strong> RSI Long 50–64 / Short 36–50 on confirmed candle</li>
              </ul>
            </div>
          </div>

          <div className="bg-neutral-950 p-3 sm:p-4 rounded-lg border border-neutral-800/80">
            <div className="font-bold text-amber-400 uppercase tracking-wider text-[11px] mb-2">Execution & Risk Controls</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1.5 text-[11px] text-neutral-300">
              {executionControls.map((control) => (
                <div key={control} className="flex items-start gap-1.5">
                  <span className="text-amber-400">•</span><span>{control}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t border-neutral-800 text-[11px] text-neutral-500 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <span>Confirmed closed candles only · EMA9/21 never blocks an otherwise valid six-gate setup</span>
            <span>{runtimeStatus.breakerActive ? `Entry breaker: ${runtimeStatus.breakerReason}` : "Entry breaker clear"}</span>
          </div>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 sm:p-6 lg:col-span-1 flex flex-col h-full">
          <h2 className="font-bold text-white mb-2">Custom Symbols Watchlist</h2>
          <p className="text-xs text-neutral-400 mb-4">Add specific perpetual pairs to monitor on WebSocket stream.</p>
          <div className="flex gap-2 mb-4">
            <input type="text" id="new-symbol" placeholder="e.g. SUIUSDT" className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-white w-full uppercase focus:outline-none focus:border-blue-500 transition-colors" onKeyDown={(e) => {
              if (e.key === "Enter") {
                const val = e.currentTarget.value.trim().toUpperCase();
                if (val) { toggleWatchlist(val, false); e.currentTarget.value = ""; }
              }
            }} />
            <button onClick={() => {
              const input = document.getElementById("new-symbol") as HTMLInputElement;
              if (input && input.value) { toggleWatchlist(input.value.trim().toUpperCase(), false); input.value = ""; }
            }} className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors cursor-pointer">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[160px] space-y-1.5 pr-1">
            {watchlist.map((sym) => {
              const price = prices[sym];
              return (
                <div key={sym} onClick={() => setSelectedSymbol(sym)} className={`flex items-center justify-between p-2 rounded-lg text-xs cursor-pointer border transition-colors ${activeSymbol === sym ? "bg-blue-950/40 border-blue-500/40 text-white" : "bg-neutral-950 border-neutral-800/80 text-neutral-300 hover:border-neutral-700"}`}>
                  <span className="font-mono font-bold">{sym}</span>
                  <div className="flex items-center gap-2">
                    {price !== undefined && Number.isFinite(price) && <span className="font-mono text-neutral-400">${price >= 1000 ? price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : price.toFixed(2)}</span>}
                    <button onClick={(e) => { e.stopPropagation(); toggleWatchlist(sym, true); }} className="text-neutral-500 hover:text-rose-400 p-0.5 cursor-pointer">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
