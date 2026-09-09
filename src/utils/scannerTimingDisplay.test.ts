import assert from "node:assert/strict";
import fs from "node:fs";
import {
  STRICT_MAX_CONCURRENT_POSITIONS,
  formatFinite,
  getFreshCrossLabel,
  getScannerTimingDisplay,
} from "./scannerTimingDisplay";
import type { ScannedMarketItem } from "../types";

const baseItem = (overrides: Partial<ScannedMarketItem> = {}): ScannedMarketItem => ({
  symbol: "BTCUSDT",
  lastPrice: 100,
  price: 100,
  turnover24h: 30_000_000,
  volume24h: 1,
  price24hPcnt: 0,
  highPrice24h: 101,
  lowPrice24h: 99,
  bidPrice: 99.9,
  askPrice: 100.1,
  rsi: 55,
  rsiZone5m: "Long (50-64)",
  ema50: 100,
  ema200: 99,
  trend15m: "Bullish HTF",
  spreadPcnt: 0.01,
  atrPcnt: 0.5,
  oiAvailable: true,
  oiPositive: true,
  gatePassed: 6,
  gates: {
    gate1_volume: { passed: true, valueDisplay: "$30M", detail: "ok" },
    gate2_trend: { passed: true, valueDisplay: "Bullish HTF", detail: "ok" },
    gate3_spread: { passed: true, valueDisplay: "0.01%", detail: "ok" },
    gate4_atr: { passed: true, valueDisplay: "0.50%", detail: "ok" },
    gate5_oi: { passed: true, valueDisplay: "+1%", detail: "ok" },
    gate6_rsi: { passed: true, valueDisplay: "55", detail: "ok" },
    gate6_candle: { passed: true, valueDisplay: "Bullish", detail: "ok" },
    gate6FailureReason: null,
    passedAll: true,
    failedGateNumber: null,
    failedGateName: null,
  },
  executionEligibility: { gateCandidate: true, riskEligible: true, executableNow: true, blockReason: null },
  trend: "Bullish",
  signal: "BUY_SIGNAL",
  signalReason: "test",
  lastScannedAt: Date.now(),
  ...overrides,
});

{
  const display = getScannerTimingDisplay(baseItem({
    trend: "Bullish",
    emaTimingState: "Bearish",
    ema9: 99,
    ema21: 100,
    ema9Above21: false,
  }));
  assert.equal(display.state, "Bearish");
  assert.equal(display.relation, "EMA9 < EMA21");
}

{
  const display = getScannerTimingDisplay(baseItem({
    trend: "Bearish",
    trend15m: "Bearish HTF",
    emaTimingState: "Bullish",
    ema9: 101,
    ema21: 100,
    ema9Above21: true,
  }));
  assert.equal(display.state, "Bullish");
  assert.equal(display.relation, "EMA9 > EMA21");
}

assert.equal(formatFinite(null, 2), "—");
assert.equal(formatFinite(undefined, 2), "—");
assert.equal(formatFinite(Number.NaN, 2), "—");
assert.equal(formatFinite(0, 2), "0.00");

{
  const display = getScannerTimingDisplay(baseItem({
    emaTimingState: "Unavailable",
    ema9: undefined,
    ema21: undefined,
    freshCross: "none",
    crossoverAgeCandles: null,
  }));
  assert.equal(display.state, "Unavailable");
  assert.equal(display.relation, "—");
  assert.equal(display.cross, "—");
  assert.equal(display.score, "—");
}

assert.equal(getFreshCrossLabel("bullish", 0), "Bullish Cross");
assert.equal(getFreshCrossLabel("bullish", 2), "Bullish Cross · 2 candles ago");
assert.equal(getFreshCrossLabel("bearish", 1), "Bearish Cross · 1 candle ago");
assert.equal(getFreshCrossLabel("none", null), "—");
assert.equal(getFreshCrossLabel(undefined, undefined), "—");

assert.equal(STRICT_MAX_CONCURRENT_POSITIONS, 3);
const scannerSource = fs.readFileSync("src/components/MarketScannerTable.tsx", "utf8");
assert.ok(!scannerSource.includes('option value="5"'));
assert.ok(scannerSource.includes("Locked by strict risk profile"));
assert.ok(!scannerSource.includes('item.trend === "Bullish" ? "EMA9 > EMA21"'));

console.log("scanner timing display regression tests passed");
