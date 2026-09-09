import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchClosedPnlRange, mergeStableLocalMetadata, normalizeClosedPnlRow, summarizeNormalizedTrades } from "./exchangeTradeHistory";
const BASE_TS = 1_780_000_000_000;
{
  const trade = normalizeClosedPnlRow({ symbol: "BTCUSDT", side: "Sell", qty: "0.001", closedSize: "0.001", avgEntryPrice: "86.89", avgExitPrice: "87.10", closedPnl: "0.00021", leverage: "10", orderId: "close-1", updatedTime: String(BASE_TS) });
  assert.equal(trade.filledQty, 0.001); assert.equal(trade.avgEntryPrice, 86.89);
}
{
  const pages = [Array.from({ length: 100 }, (_, i) => ({ symbol: "BTCUSDT", side: "Sell", closedSize: "0.001", avgEntryPrice: "100", avgExitPrice: "101", closedPnl: "0.001", orderId: `o-${i}`, updatedTime: String(BASE_TS + i * 1000) })), Array.from({ length: 25 }, (_, i) => ({ symbol: "BTCUSDT", side: "Sell", closedSize: "0.001", avgEntryPrice: "100", avgExitPrice: "101", closedPnl: "0.001", orderId: `o-${100 + i}`, updatedTime: String(BASE_TS + (100 + i) * 1000) }))];
  let calls = 0; const bybit = { async getClosedPnL() { const page = calls++; return { retCode: 0, result: { list: pages[page] || [], nextPageCursor: page === 0 ? "page-2" : "" } }; } };
  const result = await fetchClosedPnlRange(bybit, { startTime: BASE_TS - 1000, endTime: BASE_TS + 200_000 }); assert.equal(result.ok, true); assert.equal(result.trades.length, 125); assert.equal(calls, 2);
}
{
  const zero = normalizeClosedPnlRow({ symbol: "ETHUSDT", side: "Buy", closedSize: "1", avgEntryPrice: "10", avgExitPrice: "10", closedPnl: "0", orderId: "zero", updatedTime: String(BASE_TS) });
  const unknown = normalizeClosedPnlRow({ symbol: "ETHUSDT", side: "Buy", closedSize: "1", avgEntryPrice: "10", avgExitPrice: "10", closedPnl: "", orderId: "unknown", updatedTime: String(BASE_TS + 1) });
  assert.equal(zero.outcome, "ZERO"); assert.equal(unknown.outcome, "UNKNOWN"); const summary = summarizeNormalizedTrades([zero, unknown]); assert.equal(summary.zeroOrUnknown, 2); assert.equal(summary.realizedPnlUsdt, null);
}
{
  const exchange = [normalizeClosedPnlRow({ symbol: "BTCUSDT", side: "Sell", closedSize: "0.001", avgEntryPrice: "100", avgExitPrice: "101", closedPnl: "1", orderId: "close-abc", updatedTime: String(BASE_TS) })];
  const merged = mergeStableLocalMetadata(exchange, [{ id: "1", symbol: "BTCUSDT", closingOrderId: "close-abc", exitReason: "Take Profit" }, { id: "2", symbol: "BTCUSDT", closingOrderId: "other", exitReason: "Manual" }]); assert.equal(merged.length, 1); assert.equal(merged[0].metadata?.exitReason, "Take Profit");
  assert.equal(mergeStableLocalMetadata(exchange, [{ id: "legacy", symbol: "BTCUSDT", exitReason: "Stop Loss" }])[0].metadata, null);
}
const db = fs.readFileSync("src/db.ts", "utf8");
assert.equal(db.includes("sizeNotional ?? 1000"), false, "no $1000 persistence fallback");
assert.equal(db.includes("DEFAULT 1000.00"), false, "no schema $1000 default");
assert.equal(db.includes("parseFloat(row.size_notional) / parseFloat(row.entry_price)"), false, "no synthetic qty reconstruction");
assert.equal(db.includes("WHERE symbol = $9 AND status = 'OPEN'"), false, "no symbol-only close update");
assert.equal(db.includes("trades_opening_order_id_unique"), true, "stable opening identity uniqueness");
assert.equal(db.includes("Persistent DB configured; refusing ephemeral trade-write fallback"), true, "no split-brain trade fallback");
const engine = fs.readFileSync("src/engine/TradingEngine.ts", "utf8");
assert.equal(engine.includes("submittedQty: qty"), true, "manual submitted quantity persisted");
assert.equal(engine.includes("reconcileOpenFill(orderId)"), true, "actual fill reconciliation enabled");
assert.equal(engine.includes("closingOrderId: item.orderId || null"), true, "closing identity persisted");
const history = fs.readFileSync("src/components/HistoryPage.tsx", "utf8");
for (const label of ["Realized PnL USDT", "Price Move %", "Return on Notional %", "ROE %", "Zero-or-Unknown"]) assert.equal(history.includes(label), true, `HistoryPage label: ${label}`);
console.log("trade history integrity regression tests passed");
