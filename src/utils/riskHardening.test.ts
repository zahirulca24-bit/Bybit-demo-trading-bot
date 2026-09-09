import assert from "node:assert/strict";
import {
  INSTRUMENT_STATE_UNAVAILABLE,
  INVALID_QTY_STEP,
  LEVERAGE_STATE_UNAVAILABLE,
  MIN_NOTIONAL_NOT_MET,
  POSITION_MODE_UNAVAILABLE,
  POSITION_STATE_UNAVAILABLE,
  QTY_ABOVE_MAX_MARKET,
  QTY_BELOW_MIN,
  REQUESTED_QTY_EXCEEDS_APPROVED,
  WALLET_STATE_UNAVAILABLE,
  calculateApprovedQuantity,
  ensureConfiguredLeverage,
  ensureOneWayPositionMode,
  fetchInstrumentConstraints,
  fetchOpenPositions,
  fetchOrderFillSnapshot,
  fetchUnifiedAvailableBalance,
  mergePositionUpdates,
  parseInstrumentConstraints,
  quantizeProtectivePrices,
  validateFinalRequestedQuantity,
} from "./riskHardening";

async function run() {
  const thrownPositions = await fetchOpenPositions({
    async getPositionInfo() { throw new Error("private api down"); },
  });
  assert.equal(thrownPositions.ok, false);
  if (!thrownPositions.ok) {
    assert.equal(thrownPositions.reason, POSITION_STATE_UNAVAILABLE);
    assert.equal(thrownPositions.positions, null, "unknown position state must not become []");
  }

  const rejectedPositions = await fetchOpenPositions({
    async getPositionInfo() { return { retCode: 10001, retMsg: "bad request" }; },
  });
  assert.equal(rejectedPositions.ok, false);

  const knownNoPositions = await fetchOpenPositions({
    async getPositionInfo() { return { retCode: 0, result: { list: [] } }; },
  });
  assert.deepEqual(knownNoPositions, { ok: true, positions: [] }, "known empty must remain distinguishable from unavailable");

  const missingWalletField = await fetchUnifiedAvailableBalance({
    async getWalletBalance() { return { retCode: 0, result: { list: [{ coin: [{ coin: "USDT", walletBalance: "100" }] }] } }; },
  });
  assert.equal(missingWalletField.ok, false);
  if (!missingWalletField.ok) assert.equal(missingWalletField.reason, WALLET_STATE_UNAVAILABLE);

  const knownZeroWallet = await fetchUnifiedAvailableBalance({
    async getWalletBalance() { return { retCode: 0, result: { list: [{ totalAvailableBalance: "0" }] } }; },
  });
  assert.deepEqual(knownZeroWallet, { ok: true, value: 0 }, "known zero availability must remain zero, not unknown");

  const validInstrument = {
    lotSizeFilter: {
      qtyStep: "0.001",
      minOrderQty: "0.001",
      maxMktOrderQty: "2",
      minNotionalValue: "5",
    },
    priceFilter: { tickSize: "0.10" },
  };
  const parsed = parseInstrumentConstraints(validInstrument);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.error);
  const constraints = parsed.value;

  const invalidFilters = parseInstrumentConstraints({
    lotSizeFilter: { minOrderQty: "0.001", maxMktOrderQty: "2", minNotionalValue: "5" },
    priceFilter: { tickSize: "0.1" },
  });
  assert.equal(invalidFilters.ok, false);
  if (!invalidFilters.ok) assert.equal(invalidFilters.reason, INSTRUMENT_STATE_UNAVAILABLE);

  const instrumentApiFailure = await fetchInstrumentConstraints({
    async getInstrumentsInfo() { throw new Error("instrument endpoint down"); },
  }, "BTCUSDT");
  assert.equal(instrumentApiFailure.ok, false);
  if (!instrumentApiFailure.ok) assert.equal(instrumentApiFailure.reason, INSTRUMENT_STATE_UNAVAILABLE);

  const minQtyConstraints = { ...constraints, minQty: 0.01, qtyStep: 0.01, qtyStepText: "0.01" };
  const belowMinQty = calculateApprovedQuantity(5, 1000, minQtyConstraints);
  assert.equal(belowMinQty.ok, false);
  if (!belowMinQty.ok) assert.equal(belowMinQty.reason, QTY_BELOW_MIN, "must reject instead of rounding 0.005 upward to 0.01");

  const belowMinNotional = calculateApprovedQuantity(4.9, 1000, constraints);
  assert.equal(belowMinNotional.ok, false);
  if (!belowMinNotional.ok) assert.equal(belowMinNotional.reason, MIN_NOTIONAL_NOT_MET, "must reject instead of increasing qty to reach minNotional");

  const tinyMax = { ...constraints, maxMarketQty: 0.003 };
  const aboveMarketMax = calculateApprovedQuantity(10, 1000, tinyMax);
  assert.equal(aboveMarketMax.ok, false);
  if (!aboveMarketMax.ok) assert.equal(aboveMarketMax.reason, QTY_ABOVE_MAX_MARKET);

  const approved = calculateApprovedQuantity(10, 1000, constraints);
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error(approved.error);
  assert.equal(approved.qty, 0.01);
  assert.ok(approved.actualNotional <= 10, "flooring must never increase risk-approved exposure");

  const offStep = validateFinalRequestedQuantity("0.0015", approved, 1000, 10, constraints);
  assert.equal(offStep.ok, false);
  if (!offStep.ok) assert.equal(offStep.reason, INVALID_QTY_STEP);

  const tooLargeManual = validateFinalRequestedQuantity("0.011", approved, 1000, 10, constraints);
  assert.equal(tooLargeManual.ok, false);
  if (!tooLargeManual.ok) assert.equal(tooLargeManual.reason, REQUESTED_QTY_EXCEEDS_APPROVED, "manual qty must not bypass approved qty");

  const smallerManual = validateFinalRequestedQuantity("0.009", approved, 1000, 10, constraints);
  assert.equal(smallerManual.ok, true, "risk-reducing manual qty that passes exchange filters should remain valid");

  const belowManualMin = validateFinalRequestedQuantity("0.000", approved, 1000, 10, constraints);
  assert.equal(belowManualMin.ok, false);

  const buyBrackets = quantizeProtectivePrices("Buy", 101.06, 98.94, constraints);
  assert.deepEqual(buyBrackets, { takeProfit: "101.00", stopLoss: "99.00" }, "buy TP/SL must be tick-aligned without widening SL risk");
  const sellBrackets = quantizeProtectivePrices("Sell", 98.94, 101.06, constraints);
  assert.deepEqual(sellBrackets, { takeProfit: "99.00", stopLoss: "101.00" });

  const merged = mergePositionUpdates(
    [
      { symbol: "BTCUSDT", positionIdx: 0, size: "0.01", avgPrice: "100", stopLoss: "95" },
      { symbol: "ETHUSDT", positionIdx: 0, size: "1", avgPrice: "10" },
    ],
    [{ symbol: "BTCUSDT", positionIdx: 0, markPrice: "102" }],
  );
  assert.equal(merged.length, 2, "partial update must not replace untouched positions");
  assert.equal(merged.find((item) => item.symbol === "BTCUSDT")?.avgPrice, "100");
  assert.equal(merged.find((item) => item.symbol === "BTCUSDT")?.markPrice, "102");
  const afterCloseUpdate = mergePositionUpdates(merged, [{ symbol: "BTCUSDT", positionIdx: 0, size: "0" }]);
  assert.deepEqual(afterCloseUpdate.map((item) => item.symbol), ["ETHUSDT"]);

  const modeFailure = await ensureOneWayPositionMode({
    async switchPositionMode() { throw new Error("mode endpoint unavailable"); },
  }, "BTCUSDT");
  assert.equal(modeFailure.ok, false);
  if (!modeFailure.ok) assert.equal(modeFailure.reason, POSITION_MODE_UNAVAILABLE);

  const modeAlreadySet = await ensureOneWayPositionMode({
    async switchPositionMode() { return { retCode: 110025, retMsg: "Position mode has not been modified" }; },
  }, "BTCUSDT");
  assert.equal(modeAlreadySet.ok, true);

  const leverageFailure = await ensureConfiguredLeverage({
    async setLeverage() { return { retCode: 999, retMsg: "private endpoint down" }; },
  }, "BTCUSDT", 10);
  assert.equal(leverageFailure.ok, false);
  if (!leverageFailure.ok) assert.equal(leverageFailure.reason, LEVERAGE_STATE_UNAVAILABLE);

  const ackWithoutFill = await fetchOrderFillSnapshot({
    async getExecutionList() { return { retCode: 0, result: { list: [] } }; },
  }, "BTCUSDT", "order-1");
  assert.equal(ackWithoutFill.confirmed, false, "order acknowledgement alone must not become a fill");
  assert.equal(ackWithoutFill.avgFillPrice, null);

  const actualFills = await fetchOrderFillSnapshot({
    async getExecutionList() {
      return {
        retCode: 0,
        result: {
          list: [
            { orderId: "order-2", execType: "Trade", execQty: "0.004", execPrice: "100" },
            { orderId: "order-2", execType: "Trade", execQty: "0.006", execPrice: "101" },
          ],
        },
      };
    },
  }, "BTCUSDT", "order-2");
  assert.equal(actualFills.confirmed, true);
  assert.equal(actualFills.filledQty, 0.01);
  assert.equal(actualFills.avgFillPrice, 100.6);

  console.log("Risk hardening tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
