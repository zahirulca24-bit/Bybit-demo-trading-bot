import assert from "node:assert/strict";
import { classifyClosedTradeExit } from "./exitClassification";
import { calculateAdaptiveStopPlan, calculateRiskAdjustedNotional } from "./adaptiveStop";
import { selectClosedPnlForIntent } from "./closeReconciliation";
import { evaluateSmcEntryConfirmation, SmcCandle } from "./smcEntryConfirmation";

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

const staleClose = { symbol: "BTCUSDT", orderId: "old-close", orderLinkId: "bot-trail-old", updatedTime: 1_799_000 };
const exactClose = { symbol: "BTCUSDT", orderId: "new-close", orderLinkId: "bot-trail-new", updatedTime: 1_800_100 };
assert.equal(
  selectClosedPnlForIntent([staleClose], { orderId: "new-close", orderLinkId: "bot-trail-new", submittedAt: 1_800_000 }),
  null,
  "stale latest Closed PnL row must not satisfy a pending close intent"
);
assert.equal(
  selectClosedPnlForIntent([staleClose, exactClose], { orderId: "new-close", orderLinkId: "bot-trail-new", submittedAt: 1_800_000 }),
  exactClose,
  "exact pending close identity must be selected even when a stale row appears first"
);
assert.equal(
  selectClosedPnlForIntent([staleClose], null),
  staleClose,
  "non-pending reconciliation may still use the latest Closed PnL row"
);
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

const smcLongCandles: SmcCandle[] = [
  { open: 100.0, high: 101.0, low: 99.2, close: 100.3 },
  { open: 100.3, high: 100.9, low: 99.3, close: 100.1 },
  { open: 100.1, high: 100.8, low: 99.1, close: 100.4 },
  { open: 100.4, high: 101.1, low: 99.4, close: 100.2 },
  { open: 100.2, high: 100.9, low: 99.0, close: 100.0 },
  { open: 99.8, high: 100.2, low: 98.5, close: 99.5 },
  { open: 99.6, high: 102.2, low: 99.5, close: 102.0 },
  { open: 102.0, high: 102.5, low: 100.5, close: 102.2 },
  { open: 102.2, high: 102.6, low: 101.7, close: 102.1 },
  { open: 102.1, high: 102.3, low: 101.5, close: 101.9 },
  { open: 101.9, high: 102.0, low: 101.2, close: 101.6 },
  { open: 100.6, high: 101.8, low: 100.35, close: 101.6 },
];
const smcLong = evaluateSmcEntryConfirmation(smcLongCandles, "LONG");
assert.equal(smcLong.confirmed, true, "long entry must require sweep + displacement MSS + FVG retest + rejection");
assert.equal(smcLong.liquiditySweep, true);
assert.equal(smcLong.mss, true);
assert.equal(smcLong.fvg, true);
assert.equal(smcLong.retest, true);
assert.equal(smcLong.rejection, true);

const noSweep = smcLongCandles.map((candle, index) => index === 5 ? { ...candle, low: 99.05, close: 99.5 } : candle);
assert.equal(
  evaluateSmcEntryConfirmation(noSweep, "LONG").confirmed,
  false,
  "no liquidity sweep must mean no SMC entry"
);

console.log("trade quality helper tests passed");
