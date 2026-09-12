import { useState } from "react";
import { Activity, Search, TrendingDown, TrendingUp } from "lucide-react";
import { PipelineScannedSymbol } from "../types";

interface ScannedPairsTableProps {
  symbols: PipelineScannedSymbol[];
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onQuickBuy?: (symbol: string) => void;
  isScanning?: boolean;
}

export function ScannedPairsTable({ symbols, selectedSymbol, onSelectSymbol, onQuickBuy, isScanning = false }: ScannedPairsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterAction, setFilterAction] = useState<"ALL" | "LONG" | "SHORT" | "PASSED">("ALL");

  const filteredSymbols = symbols.filter(sym => {
    const queryMatch = !searchQuery.trim() || sym.symbol.includes(searchQuery.trim().toUpperCase());
    if (!queryMatch) return false;
    if (filterAction === "PASSED") return sym.gates.passedAll;
    if (filterAction === "LONG") return sym.actionType === "LONG";
    if (filterAction === "SHORT") return sym.actionType === "SHORT";
    return true;
  });

  const formatPrice = (price?: number) => {
    if (price === undefined || !Number.isFinite(price)) return "—";
    if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (price >= 1) return `$${price.toFixed(3)}`;
    return `$${price.toFixed(5)}`;
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
      <div className="p-4 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3"><Activity className="w-4 h-4 text-blue-400" /><div><h3 className="font-bold text-white text-sm">Strict 6-Gate Scanner Results</h3><p className="text-xs text-neutral-400">$25M turnover · EMA50/200 + confirmed price · 0.08% spread · ATR 0.30–1.20% · real 15m OI +0.20% · RSI 50–64 / 36–50</p></div></div>
        <div className="flex flex-wrap gap-2">
          <div className="relative"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" /><input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search pair..." className="bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white w-36" /></div>
          <select value={filterAction} onChange={e => setFilterAction(e.target.value as typeof filterAction)} className="bg-neutral-950 border border-neutral-800 rounded-lg px-2 py-1.5 text-xs text-white"><option value="ALL">All</option><option value="PASSED">Passed all 6</option><option value="LONG">Long</option><option value="SHORT">Short</option></select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="bg-neutral-950/70 text-neutral-400 uppercase text-[10px]"><tr><th className="px-4 py-3">Symbol</th><th className="px-3 py-3">24h Turnover</th><th className="px-3 py-3">Trend / EMA</th><th className="px-3 py-3">Spread</th><th className="px-3 py-3">ATR</th><th className="px-3 py-3">OI 15m</th><th className="px-3 py-3">RSI</th><th className="px-3 py-3">Status</th><th className="px-4 py-3 text-right">Action</th></tr></thead>
          <tbody className="divide-y divide-neutral-800/60">
            {filteredSymbols.map(item => {
              const selected = selectedSymbol === item.symbol;
              return <tr key={item.symbol} onClick={() => onSelectSymbol?.(item.symbol)} className={`${selected ? "bg-blue-950/25" : "hover:bg-neutral-800/20"} cursor-pointer`}>
                <td className="px-4 py-3"><div className="font-bold text-white">{item.symbol}</div><div className="text-neutral-500">{formatPrice(item.price)}</div></td>
                <td className="px-3 py-3"><span className={item.turnover24h >= 25_000_000 ? "text-emerald-400" : "text-rose-400"}>{item.turnoverFormatted}</span><div className="text-[10px] text-neutral-500">Min $25M</div></td>
                <td className="px-3 py-3"><span className={item.isTrend15mValid ? "text-emerald-400" : "text-neutral-500"}>{item.trend15m}</span><div className="text-[10px] text-neutral-500">Price must confirm EMA50 side</div></td>
                <td className="px-3 py-3"><span className={item.isSpreadValid ? "text-emerald-400" : "text-rose-400"}>{item.spreadPercent.toFixed(3)}%</span><div className="text-[10px] text-neutral-500">≤ 0.08%</div></td>
                <td className="px-3 py-3"><span className={item.isAtrValid ? "text-emerald-400" : "text-rose-400"}>{item.atr5mPercent.toFixed(2)}%</span><div className="text-[10px] text-neutral-500">0.30–1.20%</div></td>
                <td className="px-3 py-3"><span className={item.oiAvailable === false ? "text-neutral-500" : item.isOiValid ? "text-emerald-400" : "text-rose-400"}>{item.oiAvailable === false ? "—" : `${item.oiChangePercent1h >= 0 ? "+" : ""}${item.oiChangePercent1h.toFixed(2)}%`}</span><div className="text-[10px] text-neutral-500">15m real OI ≥ +0.20%; unavailable fails</div></td>
                <td className="px-3 py-3"><span className={item.isRsi5mValid ? "text-emerald-400" : "text-neutral-400"}>{item.rsi14_5m.toFixed(1)}</span><div className="text-[10px] text-neutral-500">{item.rsiZone5m}</div></td>
                <td className="px-3 py-3"><span className={item.gates.passedAll ? "text-emerald-400" : "text-neutral-400"}>{item.pipelineStatus}</span></td>
                <td className="px-4 py-3 text-right"><div className="flex justify-end items-center gap-2"><span className={item.actionType === "LONG" ? "text-emerald-400" : item.actionType === "SHORT" ? "text-rose-400" : "text-neutral-400"}>{item.actionType === "LONG" ? <TrendingUp className="w-3.5 h-3.5 inline" /> : item.actionType === "SHORT" ? <TrendingDown className="w-3.5 h-3.5 inline" /> : null} {item.signalAction}</span>{item.gates.passedAll && onQuickBuy && <button onClick={e => { e.stopPropagation(); onQuickBuy(item.symbol); }} className="px-2 py-1 rounded bg-blue-600 text-white text-[10px]">Quick Buy</button>}</div></td>
              </tr>;
            })}
            {!filteredSymbols.length && <tr><td colSpan={9} className="px-4 py-10 text-center text-neutral-500">{isScanning ? "Scanning confirmed candles..." : "No scanner results match this filter."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}