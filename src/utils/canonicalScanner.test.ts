import assert from "node:assert/strict";
import { buildExecutionEligibility, buildPipelineStateFromMarkets, evaluateGate6 } from "./canonicalScanner";
import type { ScannedMarketItem } from "../types";

const gates = {
  gate1_volume: { passed: true, valueDisplay: "$30M", detail: "ok" },
  gate2_trend: { passed: true, valueDisplay: "Bullish HTF", detail: "ok" },
  gate3_spread: { passed: true, valueDisplay: "0.02%", detail: "ok" },
  gate4_atr: { passed: true, valueDisplay: "0.50%", detail: "ok" },
  gate5_oi: { passed: true, valueDisplay: "+1%", detail: "ok" },
  gate6_rsi: { passed: true, valueDisplay: "55", detail: "ok" },
  gate6_candle: { passed: true, valueDisplay: "Bullish", detail: "ok" },
  gate6FailureReason: null,
  passedAll: true,
  failedGateNumber: null,
  failedGateName: null,
} as const;

const market = {
  symbol: "TESTUSDT", price: 1, lastPrice: 1, turnover24h: 30_000_000, volume24h: 1,
  price24hPcnt: 0, highPrice24h: 1, lowPrice24h: 1, bidPrice: 0.99, askPrice: 1.01,
  rsi: 55, rsiZone5m: "Long (50-64)", ema50: 1, ema200: 0.9, trend15m: "Bullish HTF", trend: "Bullish",
  spreadPcnt: 0.02, atrPcnt: 0.5, oiAvailable: true, oiPositive: true, oiChangePercent: 1,
  gatePassed: 6, gates, executionEligibility: { gateCandidate: true, riskEligible: true, executableNow: true, blockReason: null },
  signal: "BUY_SIGNAL", signalReason: "candidate", lastScannedAt: 1,
} as ScannedMarketItem;

// UI pipeline and trading scanner must share the exact canonical evaluated object.
const pipeline = buildPipelineStateFromMarkets([market], false, 1);
assert.strictEqual(pipeline.symbols[0], market);
assert.equal(pipeline.candidateCount, 1);

// RSI can pass while the directional candle fails, with an explicit Gate 6 sub-reason.
const candleFail = evaluateGate6({ trend15m: "Bullish HTF", rsi: 55, longCandleConfirmed: false, shortCandleConfirmed: false });
assert.equal(candleFail.rsiPassed, true);
assert.equal(candleFail.candlePassed, false);
assert.equal(candleFail.passed, false);
assert.equal(candleFail.failureReason, "DIRECTIONAL_CANDLE_FAILED");

// Risk blocked candidate is never executable.
const riskBlocked = buildExecutionEligibility({ gateCandidate: true, botRunning: true, activePositionsCount: 0, maxConcurrent: 3, riskAllowed: false, preOrderAllowed: false, blockReason: "Daily breaker active" });
assert.equal(riskBlocked.gateCandidate, true);
assert.equal(riskBlocked.riskEligible, false);
assert.equal(riskBlocked.executableNow, false);
assert.match(String(riskBlocked.blockReason), /breaker/i);

// Retained maxConcurrent is actually enforced by eligibility.
const concurrencyBlocked = buildExecutionEligibility({ gateCandidate: true, botRunning: true, activePositionsCount: 2, maxConcurrent: 2, riskAllowed: true, preOrderAllowed: true });
assert.equal(concurrencyBlocked.executableNow, false);
assert.match(String(concurrencyBlocked.blockReason), /Max 2 concurrent/);

console.log("Canonical scanner architecture tests passed");
