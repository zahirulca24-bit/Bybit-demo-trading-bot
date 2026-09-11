import assert from "node:assert/strict";
import { classifyClosedTradeExit } from "./exitClassification";
import { calculateAdaptiveStopPlan, calculateRiskAdjustedNotional } from "./adaptiveStop";

const closedLoss = { symbol: "BTCUSDT", orderId: "c1", qty: "1", closedPnl: "-4", updatedTime: 1_800_000 };
const closedWin = { symbol: "BTCUSDT", orderId: "c2", qty: "1", closedPnl: "8", updatedTime: 1_800_000 };

assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedLoss,
    orders: [{ symbol: "BTCUSDT", orderId: "c1", orderLinkId: "app-manual-abc", reduceOnly: true, updatedTime: 1_800_000 }],
  }).category,
  "MANUAL",
  "losing manual close must stay Manual"
);
assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedWin,
    orders: [{ symbol: "BTCUSDT", orderId: "c2", orderLinkId: "bot-manual-abc", reduceOnly: true, updatedTime: 1_800_000 }],
  }).category,
  "MANUAL",
  "winning manual close must stay Manual"
);
assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedLoss,
    executions: [{ symbol: "BTCUSDT", orderId: "c1", stopOrderType: "StopLoss", execTime: 1_800_000, closedSize: "1" }],
  }).category,
  "SL"
);
assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedWin,
    orders: [{ symbol: "BTCUSDT", orderId: "c2", createType: "CreateByTakeProfit", updatedTime: 1_800_000, qty: "1" }],
  }).category,
  "TP"
);
assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedWin,
    orders: [{ symbol: "BTCUSDT", orderId: "c2", stopOrderType: "TrailingStop", updatedTime: 1_800_000, qty: "1" }],
  }).category,
  "TRAILING"
);
assert.equal(classifyClosedTradeExit({ closedTrade: closedLoss }).category, "OTHER", "unknown metadata must remain Unknown/Other");
assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedLoss,
    orders: [{ symbol: "BTCUSDT", orderId: "c1", stopOrderType: "StopLoss", orderLinkId: "bot-manual-x", updatedTime: 1_800_000 }],
  }).category,
  "MANUAL",
  "explicit bot manual close identity must outrank stale stop metadata"
);
assert.equal(
  classifyClosedTradeExit({
    closedTrade: closedWin,
    orders: [
      { symbol: "BTCUSDT", orderId: "c2", orderLinkId: "bot-trail-exact", reduceOnly: true, updatedTime: 1_800_000 },
      { symbol: "BTCUSDT", orderId: "other-sl", stopOrderType: "StopLoss", reduceOnly: true, updatedTime: 1_800_001, qty: "1" },
    ],
  }).category,
  "TRAILING",
  "exact bot trailing close must outrank a nearby SL record"
);

const longPlan = calculateAdaptiveStopPlan({ side: "Buy", entryPrice: 100, atr: 1.2, swingPrice: 98.0 });
assert.equal(longPlan.stopDistancePercent, 1.8, "adaptive SL must respect the 1.80% max cap");
assert.ok(longPlan.stopLoss < 100);
const quietPlan = calculateAdaptiveStopPlan({ side: "Buy", entryPrice: 100, atr: 0.3, swingPrice: 99.8 });
assert.equal(quietPlan.stopDistancePercent, 1.0, "adaptive SL must not become tighter than the legacy 1% stop");
assert.ok(calculateRiskAdjustedNotional(500, 1.8) < 500, "wider stops must reduce notional");
assert.equal(calculateRiskAdjustedNotional(500, 1.0), 500);

console.log("trade quality helper tests passed");
