import React, { useState, useEffect } from "react";
import { Plus, X, Activity, ShieldCheck, Zap, Layers, RefreshCw, Radar } from "lucide-react";
import { Technicals, TradeHistory, KlineUpdatePayload, ScannerState, Position, PipelineState } from "../types";
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
  const [isPipelineScanning, setIsPipelineScanning] = useState<boolean>(false);

  const activeSymbol = selectedSymbol || watchlist[0] || "BTCUSDT";

  // Fetch 6-Gate Pipeline Data from backend
  const fetchPipeline = async (forceRefresh = false) => {
    setIsPipelineScanning(true);
    try {
      const url = forceRefresh ? "/api/scanner/pipeline/scan-now" : "/api/scanner/pipeline";
      const res = await (forceRefresh ? fetch(url, { method: "POST" }) : fetch(url));
      const data = await res.json();
      if (data.success && data.pipeline) {
        setPipelineData(data.pipeline);
      }
    } catch (err) {
      console.error("Failed to fetch pipeline data:", err);
    } finally {
      setIsPipelineScanning(false);
    }
  };

  useEffect(() => {
    fetchPipeline(false);
    const interval = setInterval(() => {
      fetchPipeline(false);
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      {/* Top Header & View Mode Switcher */}
      <header className="pb-4 border-b border-neutral-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-1">
              Market Scanner & Strategy
            </h1>
            <p className="text-neutral-400 text-sm">
              6-Gate Quantitative Filtering Pipeline (15m HTF Trend + 5m RSI Execution) for Bybit linear USDT contracts.
            </p>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-neutral-800 rounded-xl p-1 bg-neutral-900">
              <button
                onClick={() => setActiveTab("pipeline")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === "pipeline"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                6-Gate Pipeline
              </button>
              <button
                onClick={() => setActiveTab("5m_grid")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === "5m_grid"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                5m Momentum Grid
              </button>
              <button
                onClick={() => setActiveTab("turnover")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === "turnover"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                Turnover Rankings
              </button>
            </div>

            {activeTab === "pipeline" && (
              <button
                onClick={() => fetchPipeline(true)}
                disabled={isPipelineScanning}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-neutral-700 text-neutral-300 hover:text-white text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer"
                title="Force refresh 6-Gate scan"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isPipelineScanning ? "animate-spin text-blue-400" : ""}`} />
                <span>{isPipelineScanning ? "Scanning..." : "Scan"}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 1. View Tab 1: 6-Gate Validation Pipeline (Default) */}
      {activeTab === "pipeline" && (
        <div className="space-y-6">
          {/* Component 1: Visual Step-by-Step Horizontal Pipeline with 6 Interconnected Gate Cards */}
          <SixGatePipelineVisualizer
            gates={pipelineData?.gates || [
              {
                gateNumber: 1,
                name: "24h Volume / Turnover",
                ruleDescription: "Filters top traded USDT perps on Bybit (Min $5M 24h turnover)",
                status: "Passed",
                inputCount: 40,
                passCount: 35,
                passRatePercent: 88,
              },
              {
                gateNumber: 2,
                name: "15m HTF Trend Structure (EMA 50/200)",
                ruleDescription: "Requires 15m EMA 50 > 200 (Bullish HTF) or 15m EMA 50 < 200 (Bearish HTF)",
                status: "Filtering",
                inputCount: 35,
                passCount: 26,
                passRatePercent: 74,
              },
              {
                gateNumber: 3,
                name: "Orderbook Spread",
                ruleDescription: "Enforces Bid-Ask Spread <= 0.15% to eliminate slippage",
                status: "Filtering",
                inputCount: 26,
                passCount: 20,
                passRatePercent: 77,
              },
              {
                gateNumber: 4,
                name: "5m Volatility (ATR)",
                ruleDescription: "Requires 5m ATR >= 0.3% to avoid flat/stagnant pairs",
                status: "Filtering",
                inputCount: 20,
                passCount: 14,
                passRatePercent: 70,
              },
              {
                gateNumber: 5,
                name: "Open Interest (OI)",
                ruleDescription: "Filters for 1h/4h positive OI surge & smart money inflow",
                status: "Filtering",
                inputCount: 14,
                passCount: 9,
                passRatePercent: 64,
              },
              {
                gateNumber: 6,
                name: "5m RSI (14) Entry Trigger",
                ruleDescription: "Momentum confirmation: 5m RSI 50-65 for Long, 35-50 for Short",
                status: "Active",
                inputCount: 9,
                passCount: 3,
                passRatePercent: 33,
              },
            ]}
            totalDiscovered={pipelineData?.totalDiscovered || 40}
            passedAllCount={pipelineData?.passedAllCount || 3}
            activeSignalsCount={pipelineData?.activeSignalsCount || 3}
            isScanning={isPipelineScanning}
            onRefresh={() => fetchPipeline(true)}
          />

          {/* Component 2: Scanned Pairs Table below the Pipeline */}
          <ScannedPairsTable
            symbols={pipelineData?.symbols || []}
            selectedSymbol={activeSymbol}
            onSelectSymbol={setSelectedSymbol}
            onQuickBuy={onQuickBuy}
            isScanning={isPipelineScanning}
          />
        </div>
      )}

      {/* 2. View Tab 2: 5m Momentum Scanner Grid */}
      {activeTab === "5m_grid" && (
        <HighDensityScannerGrid
          scannerState={scannerState}
          activePositions={activePositions}
          selectedSymbol={activeSymbol}
          onSelectSymbol={setSelectedSymbol}
          onQuickBuy={onQuickBuy}
        />
      )}

      {/* 3. View Tab 3: 24h Turnover Rankings */}
      {activeTab === "turnover" && (
        <MarketScannerTable
          scannerState={scannerState}
          activePositions={activePositions}
          selectedSymbol={activeSymbol}
          onSelectSymbol={setSelectedSymbol}
          onToggleAutoTrade={onToggleAutoTrade}
          onScanNow={onScanNow}
          onRefreshMarkets={onRefreshMarkets}
          onSetMaxConcurrent={onSetMaxConcurrent}
          onQuickBuy={onQuickBuy}
        />
      )}

      {/* Strategy Blueprint & Monitored Watchlist Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Strategy Blueprint Rules */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 lg:col-span-2 flex flex-col justify-between">
          <div>
            <h2 className="font-bold text-white mb-4 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              6-Gate Quantitative Strategy Blueprint
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800/80 space-y-2">
                <div className="font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" /> Macro Liquidity & Higher-Timeframe Gates
                </div>
                <ul className="space-y-1.5 text-neutral-300">
                  <li className="flex items-start gap-1.5">
                    <span className="text-emerald-400 font-bold">•</span>
                    <span><strong>Gate 1 (Turnover):</strong> Filters top liquid USDT perps (Min $5M 24h turnover) to guarantee instantaneous fills.</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-emerald-400 font-bold">•</span>
                    <span><strong>Gate 2 (15m HTF Trend):</strong> Enforces 15m EMA 50 &gt; 200 for Longs / EMA 50 &lt; 200 for Shorts, eliminating counter-trend noise.</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-emerald-400 font-bold">•</span>
                    <span><strong>Gate 3 (Spread):</strong> Enforces Bid-Ask Spread &le; 0.15% to eliminate toxic orderbook slippage.</span>
                  </li>
                </ul>
              </div>

              <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800/80 space-y-2">
                <div className="font-bold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5" /> Execution & Trigger Gates
                </div>
                <ul className="space-y-1.5 text-neutral-300">
                  <li className="flex items-start gap-1.5">
                    <span className="text-blue-400 font-bold">•</span>
                    <span><strong>Gate 4 (5m ATR):</strong> Requires 5m ATR &ge; 0.30% to prevent entering stagnant, choppy flat ranges.</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-blue-400 font-bold">•</span>
                    <span><strong>Gate 5 (Open Interest):</strong> Confirms 1h/4h positive OI expansion signaling institutional capital accumulation.</span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-blue-400 font-bold">•</span>
                    <span><strong>Gate 6 (5m RSI Trigger):</strong> Momentum execution trigger: 50-65 for Long entries, 35-50 for Short entries.</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-neutral-800 text-[11px] text-neutral-500 flex items-center justify-between">
            <span>Bybit Linear USDT Perpetual Market Stream</span>
            <span>IOC Execution with Auto-Brackets</span>
          </div>
        </div>

        {/* Custom Watchlist Quick Manager */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 lg:col-span-1 flex flex-col h-full">
          <h2 className="font-bold text-white mb-2">Custom Symbols Watchlist</h2>
          <p className="text-xs text-neutral-400 mb-4">Add specific perpetual pairs to monitor on WebSocket stream.</p>
          
          <div className="flex gap-2 mb-4">
             <input 
               type="text" 
               id="new-symbol"
               placeholder="e.g. SUIUSDT" 
               className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-white w-full uppercase focus:outline-none focus:border-blue-500 transition-colors"
               onKeyDown={(e) => {
                 if (e.key === 'Enter') {
                   const val = e.currentTarget.value.trim().toUpperCase();
                   if (val) {
                     toggleWatchlist(val, false);
                     e.currentTarget.value = '';
                   }
                 }
               }}
             />
             <button 
               onClick={() => {
                 const input = document.getElementById('new-symbol') as HTMLInputElement;
                 if (input && input.value) {
                   toggleWatchlist(input.value.trim().toUpperCase(), false);
                   input.value = '';
                 }
               }}
               className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors cursor-pointer"
             >
               <Plus className="w-4 h-4" />
             </button>
          </div>

          <div className="flex-1 overflow-y-auto max-h-[160px] space-y-1.5 pr-1">
             {watchlist.map((sym) => {
               const price = prices[sym];
               return (
                 <div 
                   key={sym}
                   onClick={() => setSelectedSymbol(sym)}
                   className={`flex items-center justify-between p-2 rounded-lg text-xs cursor-pointer border transition-colors ${
                     activeSymbol === sym 
                       ? "bg-blue-950/40 border-blue-500/40 text-white" 
                       : "bg-neutral-950 border-neutral-800/80 text-neutral-300 hover:border-neutral-700"
                   }`}
                 >
                   <span className="font-mono font-bold">{sym}</span>
                   <div className="flex items-center gap-2">
                     {price && (
                       <span className="font-mono text-neutral-400">
                         ${price >= 1000 ? price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : price.toFixed(2)}
                       </span>
                     )}
                     <button 
                       onClick={(e) => {
                         e.stopPropagation();
                         toggleWatchlist(sym, true);
                       }}
                       className="text-neutral-500 hover:text-rose-400 p-0.5 cursor-pointer"
                     >
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
