import { normalizeTimestampMs } from "./utcTradingDay";

export type TradeOutcome = "WIN" | "LOSS" | "ZERO" | "UNKNOWN";

export interface NormalizedExchangeTrade {
  id: string; symbol: string; side: "Buy" | "Sell" | null;
  filledQty: number | null; orderQty: number | null;
  avgEntryPrice: number | null; avgExitPrice: number | null;
  realizedPnlUsdt: number | null; leverage: number | null;
  createdAt: number | null; closedAt: number | null;
  orderId: string | null; orderLinkId: string | null; execType: string | null;
  priceMovePercent: number | null; returnOnNotionalPercent: number | null; roePercent: number | null;
  outcome: TradeOutcome; metadata?: Record<string, any> | null;
}

export interface ClosedPnlFetchResult { ok: boolean; rows: any[]; trades: NormalizedExchangeTrade[]; error?: string; }
export interface ExecutionFetchResult { ok: boolean; rows: any[]; error?: string; }

export function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function percent(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}
export function normalizeClosedPnlRow(row: any): NormalizedExchangeTrade {
  const symbol = typeof row?.symbol === "string" ? row.symbol : "";
  // Bybit Closed PnL side is the closing order side. Expose the original
  // position side consistently with TradingEngine reconciliation.
  const closingSide = row?.side === "Buy" || row?.side === "Sell" ? row.side : null;
  const side = closingSide === "Buy" ? "Sell" : closingSide === "Sell" ? "Buy" : null;
  const filledQty = finiteOrNull(row?.closedSize) ?? finiteOrNull(row?.qty);
  const orderQty = finiteOrNull(row?.qty);
  const avgEntryPrice = finiteOrNull(row?.avgEntryPrice);
  const avgExitPrice = finiteOrNull(row?.avgExitPrice);
  const realizedPnlUsdt = finiteOrNull(row?.closedPnl);
  const leverage = finiteOrNull(row?.leverage);
  const createdAtRaw = normalizeTimestampMs(row?.createdTime);
  const closedAtRaw = normalizeTimestampMs(row?.updatedTime ?? row?.execTime ?? row?.createdTime);
  const createdAt = createdAtRaw > 0 ? createdAtRaw : null;
  const closedAt = closedAtRaw > 0 ? closedAtRaw : null;
  const orderId = typeof row?.orderId === "string" && row.orderId ? row.orderId : null;
  const orderLinkId = typeof row?.orderLinkId === "string" && row.orderLinkId ? row.orderLinkId : null;
  const notional = avgEntryPrice !== null && filledQty !== null ? avgEntryPrice * filledQty : null;
  const priceMovePercent = avgEntryPrice !== null && avgExitPrice !== null && avgEntryPrice !== 0 ? ((avgExitPrice - avgEntryPrice) / avgEntryPrice) * 100 : null;
  const returnOnNotionalPercent = percent(realizedPnlUsdt, notional);
  const margin = notional !== null && leverage !== null && leverage > 0 ? notional / leverage : null;
  const roePercent = percent(realizedPnlUsdt, margin);
  const outcome: TradeOutcome = realizedPnlUsdt === null ? "UNKNOWN" : realizedPnlUsdt > 0 ? "WIN" : realizedPnlUsdt < 0 ? "LOSS" : "ZERO";
  const fallbackId = `${symbol || "unknown"}:${closedAt ?? "unknown"}:${filledQty ?? "unknown"}:${realizedPnlUsdt ?? "unknown"}`;
  return { id: orderId || fallbackId, symbol, side, filledQty, orderQty, avgEntryPrice, avgExitPrice, realizedPnlUsdt, leverage, createdAt, closedAt, orderId, orderLinkId, execType: typeof row?.execType === "string" ? row.execType : null, priceMovePercent, returnOnNotionalPercent, roePercent, outcome, metadata: null };
}
function dedupeRows(rows: any[]): any[] {
  const seen = new Set<string>(); const out: any[] = [];
  for (const row of rows) { const normalized = normalizeClosedPnlRow(row); const key = normalized.orderId || normalized.id; if (seen.has(key)) continue; seen.add(key); out.push(row); }
  return out;
}
async function fetchClosedWindow(bybit: any, params: Record<string, any>): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  const rows: any[] = []; const seenCursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    let res: any; try { res = await bybit.getClosedPnL({ ...params, limit: 100, ...(cursor ? { cursor } : {}) }); } catch (err: any) { return { ok: false, rows: [], error: err?.message || "Bybit Closed PnL request failed" }; }
    if (res?.retCode !== 0 || !res?.result?.list) return { ok: false, rows: [], error: res?.retMsg || "Bybit Closed PnL returned invalid response" };
    rows.push(...res.result.list); const next = String(res.result.nextPageCursor || "");
    if (!next) return { ok: true, rows }; if (seenCursors.has(next)) return { ok: false, rows: [], error: "Bybit Closed PnL pagination repeated cursor" }; seenCursors.add(next); cursor = next;
  }
  return { ok: false, rows: [], error: "Bybit Closed PnL pagination safety limit reached" };
}
export async function fetchClosedPnlRange(bybit: any, options: { startTime: number; endTime: number; symbol?: string }): Promise<ClosedPnlFetchResult> {
  const { startTime, endTime } = options;
  if (!(Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime)) return { ok: false, rows: [], trades: [], error: "Invalid Closed PnL time range" };
  const allRows: any[] = []; const maxWindowMs = 7 * 24 * 60 * 60 * 1000;
  for (let chunkStart = startTime; chunkStart < endTime; chunkStart += maxWindowMs) {
    const chunkEndExclusive = Math.min(endTime, chunkStart + maxWindowMs);
    const fetched = await fetchClosedWindow(bybit, { category: "linear", startTime: chunkStart, endTime: chunkEndExclusive - 1, ...(options.symbol ? { symbol: options.symbol } : {}) });
    if (!fetched.ok) return { ok: false, rows: [], trades: [], error: fetched.error }; allRows.push(...fetched.rows);
  }
  const rows = dedupeRows(allRows).filter((row) => { const time = normalizeTimestampMs(row?.updatedTime ?? row?.execTime ?? row?.createdTime); return time >= startTime && time < endTime; });
  return { ok: true, rows, trades: rows.map(normalizeClosedPnlRow).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)) };
}
export async function fetchExecutionRange(bybit: any, options: { startTime: number; endTime: number; symbol?: string }): Promise<ExecutionFetchResult> {
  const rows: any[] = []; const seenCursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    let res: any; try { res = await bybit.getExecutionList({ category: "linear", startTime: options.startTime, endTime: options.endTime - 1, limit: 100, ...(options.symbol ? { symbol: options.symbol } : {}), ...(cursor ? { cursor } : {}) }); } catch (err: any) { return { ok: false, rows: [], error: err?.message || "Bybit execution request failed" }; }
    if (res?.retCode !== 0 || !res?.result?.list) return { ok: false, rows: [], error: res?.retMsg || "Bybit execution response invalid" };
    rows.push(...res.result.list); const next = String(res.result.nextPageCursor || ""); if (!next) return { ok: true, rows }; if (seenCursors.has(next)) return { ok: false, rows: [], error: "Bybit execution pagination repeated cursor" }; seenCursors.add(next); cursor = next;
  }
  return { ok: false, rows: [], error: "Bybit execution pagination safety limit reached" };
}
export function mergeStableLocalMetadata(trades: NormalizedExchangeTrade[], localRows: any[]): NormalizedExchangeTrade[] {
  const byClosingOrderId = new Map<string, any>(); const byClosingOrderLinkId = new Map<string, any>();
  for (const row of localRows) { if (row?.closingOrderId) byClosingOrderId.set(String(row.closingOrderId), row); if (row?.closingOrderLinkId) byClosingOrderLinkId.set(String(row.closingOrderLinkId), row); }
  return trades.map((trade) => { const local = (trade.orderId && byClosingOrderId.get(trade.orderId)) || (trade.orderLinkId && byClosingOrderLinkId.get(trade.orderLinkId)) || null; return local ? { ...trade, metadata: local } : trade; });
}
export function summarizeNormalizedTrades(trades: NormalizedExchangeTrade[]) {
  const wins = trades.filter((t) => t.outcome === "WIN").length, losses = trades.filter((t) => t.outcome === "LOSS").length, zero = trades.filter((t) => t.outcome === "ZERO").length, unknown = trades.filter((t) => t.outcome === "UNKNOWN").length;
  const knownPnls = trades.map((t) => t.realizedPnlUsdt).filter((v): v is number => v !== null); const allPnlKnown = knownPnls.length === trades.length; const knownDirectional = wins + losses;
  return { totalTrades: trades.length, wins, losses, zero, unknown, zeroOrUnknown: zero + unknown, winRatePercent: knownDirectional > 0 ? (wins / knownDirectional) * 100 : null, realizedPnlUsdt: allPnlKnown ? knownPnls.reduce((s, v) => s + v, 0) : null, knownRealizedPnlUsdt: knownPnls.reduce((s, v) => s + v, 0) };
}
