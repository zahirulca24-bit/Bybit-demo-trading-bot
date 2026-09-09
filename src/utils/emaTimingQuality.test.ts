import assert from "node:assert/strict";
import { calculateEmaTimingQuality, calculateFinalSetupScore, scoreEmaTimingFromSeries } from "./emaTimingQuality";

function score(side: "LONG" | "SHORT", ema9: number[], ema21: number[], closes?: number[]) {
  const c = closes ?? ema9.map((v, i) => side === "LONG" ? Math.max(v, ema21[i]) + 1 : Math.min(v, ema21[i]) - 1);
  return scoreEmaTimingFromSeries({ closes: c, ema9, ema21, side });
}

const longAligned = score("LONG", [99, 100, 101, 102, 103, 104], [100, 100, 100, 100, 100, 100]);
assert.equal(longAligned.available, true);
assert.equal(longAligned.ema9Above21, true);
assert(longAligned.emaTimingScore > 0);
assert(calculateFinalSetupScore(longAligned.emaTimingScore, false) >= 6, "strict pass remains eligible with timing bonus");

const shortAligned = score("SHORT", [101, 100, 99, 98, 97, 96], [100, 100, 100, 100, 100, 100]);
assert.equal(shortAligned.ema9Above21, false);
assert(shortAligned.emaTimingScore > 0);

const neutral = score("LONG", [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]);
assert.equal(neutral.emaTimingScore, 0);
assert.equal(calculateFinalSetupScore(neutral.emaTimingScore, false), 6, "neutral timing does not reject a strict setup");

const bullishCross = score("LONG", [99, 99.5, 100, 101], [100, 100, 100, 100]);
assert.equal(bullishCross.freshCross, "bullish");
assert.equal(bullishCross.crossoverAgeCandles, 0);

const bearishCross = score("SHORT", [101, 100.5, 100, 99], [100, 100, 100, 100]);
assert.equal(bearishCross.freshCross, "bearish");
assert.equal(bearishCross.crossoverAgeCandles, 0);

const ageTwo = score("LONG", [99, 99.5, 101, 102, 103], [100, 100, 100, 100, 100]);
assert.equal(ageTwo.freshCross, "bullish");
assert.equal(ageTwo.crossoverAgeCandles, 2);

const tooOld = score("LONG", [99, 101, 102, 103, 104, 105], [100, 100, 100, 100, 100, 100]);
assert.equal(tooOld.freshCross, "none");
assert.equal(tooOld.crossoverAgeCandles, null);

// Forming candle is intentionally excluded by the caller: confirmed series has no cross.
const confirmedOnly = score("LONG", [99, 99.2, 99.4, 99.6], [100, 100, 100, 100]);
assert.equal(confirmedOnly.freshCross, "none");

const clean = score("LONG", [99, 100, 101, 102, 103, 104, 105], [98, 98.5, 99, 99.5, 100, 100.5, 101]);
const choppy = score("LONG", [99.99, 100.01, 99.99, 100.01, 99.99, 100.01, 100.02], [100, 100, 100, 100, 100, 100, 100], [100,100,100,100,100,100,100]);
assert.equal(choppy.choppy, true);
assert(choppy.emaTimingScore <= clean.emaTimingScore, "chop reduces timing quality without creating a hard rejection");

const insufficient = calculateEmaTimingQuality(Array.from({ length: 20 }, (_, i) => 100 + i), "LONG");
assert.equal(insufficient.available, false);
assert.equal(insufficient.ema9, undefined);
assert.equal(insufficient.ema21, undefined);
assert.equal(insufficient.emaTimingScore, 0);

console.log("EMA9/21 timing quality tests passed");
