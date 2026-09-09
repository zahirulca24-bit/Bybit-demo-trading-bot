import { useState } from "react";
import { Activity, Search, TrendingDown, TrendingUp } from "lucide-react";
import { ScannedMarketItem } from "../types";
import { formatScannerTurnover } from "../utils/canonicalScanner";

interface ScannedPairsTableProps {
  symbols: ScannedMarketItem[];
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onQuickBuy?: (symbol: string) => void;
  isScanning?: boolean;
}

function finite(value: unknown, decimals: number, suffix = "") {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(decimals)}${suffix}` : "—";
}

function formatPrice(price?: number) {
  if (price === undefined || !Number.isFinite(price)) return "—";
  if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(3)}`;
  return `$${price.toFixed(5)}`;
}

export function ScannedPairsTable({ symbols, selectedSymbol, onSelectSymbol, onQuickBuy, isScanning = false }: ScannedPairsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterAction, setFilterAction] = useState<"ALL" | "LONG" | "SHORT" | "PASSED">("ALL");
  const filteredSymbols = symbols.filter((sym) => {
    const queryMatch = !searchQuery.trim() || sym.symbol.includes(searchQuery.trim().toUpperCase());
    if (!queryMatch) return false;
    if (filterAction === "PASSED") return sym.gates.passedAll;
    if (filterAction === "LONG") return sym.gates.passedAll && sym.trend15m === "Bullish HTF";
    if (filterAction === "SHORT") return sym.gates.passedAll && sym.trend15m === "Bearish HTF";
    return true;
  });

  return <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
    <div className="p-4 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3"><Activity className="w-4 h-4 text-blue-400" /><div><h3 className="font-bold text-white text-sm">Canonical 6-Gate Scanner Results</h3><p className="text-xs text-neutral-400">These are the exact evaluated symbol results consumed by auto-trading; execution eligibility is shown separately.</p></div></div>
      <div className="flex flex-wrap gap-2"><div className="relative"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" /><input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search pair..." className="bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white w-36" /></div><select value={filterAction} onChange={e => setFilterAction(e.target.value as typeof filterAction)} className="bg-neutral-950 border border-neutral-800 rounded-lg px-2 py-1.5 text-xs text-white"><option value="ALL">All</option><option value="PASSED">6-Gate Candidates</option><option value="LONG">Long</option><option value="SHORT">Short</option></select></div>
    </div>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs whitespace-nowrap min-w-[1180px]">
      <thead className="bg-neutral-950/70 text-neutral-400 uppercase text-[10px]"><tr><th className="px-4 py-3">Symbol</th><th className="px-3 py-3">Gate 1 Turnover</th><th className="px-3 py-3">Gate 2 Trend</th><th className="px-3 py-3">Gate 3 Spread</th><th className="px-3 py-3">Gate 4 ATR</th><th className="px-3 py-3">Gate 5 OI</th><th className="px-3 py-3">Gate 6 RSI / Candle</th><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Execution</th><th className="px-4 py-3 text-right">Action</th></tr></thead>
      <tbody className="divide-y divide-neutral-800/60">{filteredSymbols.map(item => {
        const selected = selectedSymbol === item.symbol;
        const direction = item.gates.passedAll ? (item.trend15m === "Bullish HTF" ? "LONG" : item.trend15m === "Bearish HTF" ? "SHORT" : "STANDBY") : "STANDBY";
        const eligibility = item.executionEligibility;
        return <tr key={item.symbol} onClick={() => onSelectSymbol?.(item.symbol)} className={`${selected ? "bg-blue-950/25" : "hover:bg-neutral-800/20"} cursor-pointer`}>
          <td className="px-4 py-3"><div className="font-bold text-white">{item.symbol}</div><div className="text-neutral-500">{formatPrice(item.price)}</div></td>
          <td className="px-3 py-3"><span className={item.gates.gate1_volume.passed ? "text-emerald-400" : "text-rose-400"}>{formatScannerTurnover(item.turnover24h)}</span><div className="text-[10px] text-neutral-500">{item.gates.gate1_volume.detail}</div></td>
          <td className="px-3 py-3"><span className={item.gates.gate2_trend.passed ? "text-emerald-400" : "text-neutral-500"}>{item.trend15m}</span><div className="text-[10px] text-neutral-500">{item.gates.gate2_trend.detail}</div></td>
          <td className="px-3 py-3"><span className={item.gates.gate3_spread.passed ? "text-emerald-400" : "text-rose-400"}>{finite(item.spreadPcnt, 3, "%")}</span><div className="text-[10px] text-neutral-500">{item.gates.gate3_spread.detail}</div></td>
          <td className="px-3 py-3"><span className={item.gates.gate4_atr.passed ? "text-emerald-400" : "text-rose-400"}>{finite(item.atrPcnt, 2, "%")}</span><div className="text-[10px] text-neutral-500">{item.gates.gate4_atr.detail}</div></td>
          <td className="px-3 py-3"><span className={!item.oiAvailable ? "text-neutral-500" : item.gates.gate5_oi.passed ? "text-emerald-400" : "text-rose-400"}>{!item.oiAvailable ? "—" : finite(item.oiChangePercent, 2, "%")}</span><div className="text-[10px] text-neutral-500">{item.gates.gate5_oi.detail}</div></td>
          <td className="px-3 py-3"><span className={item.gates.gate6_rsi.passed ? "text-emerald-400" : "text-rose-400"}>RSI {finite(item.rsi, 1)}</span><div className={item.gates.gate6_candle.passed ? "text-[10px] text-emerald-400" : "text-[10px] text-rose-400"}>{item.gates.gate6_candle.detail}</div>{item.gates.gate6FailureReason && <div className="text-[10px] text-amber-300">{item.gates.gate6FailureReason}</div>}</td>
          <td className="px-3 py-3"><span className={eligibility.gateCandidate ? "text-emerald-400" : "text-neutral-400"}>{eligibility.gateCandidate ? "6-Gate Candidate" : item.gates.failedGateName || "Blocked"}</span></td>
          <td className="px-3 py-3"><span className={eligibility.executableNow ? "text-emerald-400" : "text-amber-300"}>{eligibility.executableNow ? "Executable now" : "Not executable"}</span><div className="text-[10px] text-neutral-500 max-w-[240px] truncate" title={eligibility.blockReason || undefined}>{eligibility.blockReason || "All execution checks passed"}</div></td>
          <td className="px-4 py-3 text-right"><div className="flex justify-end items-center gap-2"><span className={direction === "LONG" ? "text-emerald-400" : direction === "SHORT" ? "text-rose-400" : "text-neutral-400"}>{direction === "LONG" ? <TrendingUp className="w-3.5 h-3.5 inline" /> : direction === "SHORT" ? <TrendingDown className="w-3.5 h-3.5 inline" /> : null} {direction}</span>{item.gates.passedAll && onQuickBuy && <button onClick={e => { e.stopPropagation(); onQuickBuy(item.symbol); }} className="px-2 py-1 rounded bg-blue-600 text-white text-[10px]">Quick Buy</button>}</div></td>
        </tr>;
      })}{!filteredSymbols.length && <tr><td colSpan={10} className="px-4 py-10 text-center text-neutral-500">{isScanning ? "Running canonical scanner evaluation..." : "No scanner results match this filter."}</td></tr>}</tbody>
    </table></div>
  </div>;
}
