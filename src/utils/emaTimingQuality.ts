import { EMA } from "technicalindicators";

export type EmaTimingSide = "LONG" | "SHORT";
export type FreshCross = "bullish" | "bearish" | "none";
export type EmaTimingState = "Bullish" | "Bearish" | "Neutral" | "Unavailable";

export interface EmaTimingQualityResult {
  available: boolean;
  ema9?: number;
  ema21?: number;
  ema9Above21?: boolean;
  ema9Slope?: number;
  ema21Slope?: number;
  freshCross: FreshCross;
  crossoverAgeCandles: number | null;
  emaTimingScore: number;
  timingState: EmaTimingState;
  choppy: boolean;
  chopPenalty: number;
  gapPercent?: number;
}

const RECENT_CROSS_WINDOW = 3;
const CHOP_LOOKBACK_TRANSITIONS = 6;
const TINY_GAP_PERCENT = 0.03;
const FLAT_SLOPE_PERCENT = 0.01;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function scoreEmaTimingFromSeries(input: {
  closes: number[];
  ema9: number[];
  ema21: number[];
  side: EmaTimingSide;
}): EmaTimingQualityResult {
  const { closes, ema9, ema21, side } = input;
  const length = Math.min(closes.length, ema9.length, ema21.length);
  if (length < 4) {
    return { available: false, freshCross: "none", crossoverAgeCandles: null, emaTimingScore: 0, timingState: "Unavailable", choppy: false, chopPenalty: 0 };
  }

  const c = closes.slice(-length);
  const e9 = ema9.slice(-length);
  const e21 = ema21.slice(-length);
  const i = length - 1;
  const currentClose = c[i];
  const current9 = e9[i];
  const current21 = e21[i];
  const prev9 = e9[i - 1];
  const prev21 = e21[i - 1];
  if (![currentClose, current9, current21, prev9, prev21].every(Number.isFinite) || currentClose <= 0) {
    return { available: false, freshCross: "none", crossoverAgeCandles: null, emaTimingScore: 0, timingState: "Unavailable", choppy: false, chopPenalty: 0 };
  }

  let freshCross: FreshCross = "none";
  let crossoverAgeCandles: number | null = null;
  for (let age = 0; age < RECENT_CROSS_WINDOW; age++) {
    const curr = i - age;
    const prev = curr - 1;
    if (prev < 0) break;
    const bullish = e9[prev] <= e21[prev] && e9[curr] > e21[curr];
    const bearish = e9[prev] >= e21[prev] && e9[curr] < e21[curr];
    if (bullish || bearish) {
      freshCross = bullish ? "bullish" : "bearish";
      crossoverAgeCandles = age;
      break;
    }
  }

  let crossCount = 0;
  for (let step = 0; step < CHOP_LOOKBACK_TRANSITIONS; step++) {
    const curr = i - step;
    const prev = curr - 1;
    if (prev < 0) break;
    if ((e9[prev] <= e21[prev] && e9[curr] > e21[curr]) || (e9[prev] >= e21[prev] && e9[curr] < e21[curr])) crossCount++;
  }

  const ema9Slope = current9 - prev9;
  const ema21Slope = current21 - prev21;
  const gapPercent = Math.abs(current9 - current21) / currentClose * 100;
  const slopePercent = Math.abs(ema9Slope) / currentClose * 100;
  const ema9Above21 = current9 > current21;
  const timingState: EmaTimingState = current9 > current21 ? "Bullish" : current9 < current21 ? "Bearish" : "Neutral";
  const aligned = side === "LONG" ? current9 > current21 : current9 < current21;
  const slopeAligned = side === "LONG" ? ema9Slope > 0 : ema9Slope < 0;
  const priceAligned = side === "LONG"
    ? currentClose > current9 && currentClose > current21
    : currentClose < current9 && currentClose < current21;
  const matchingFreshCross = side === "LONG" ? freshCross === "bullish" : freshCross === "bearish";

  let rawScore = 0;
  if (aligned) rawScore += 1.0;
  if (matchingFreshCross) rawScore += 1.0;
  if (slopeAligned) rawScore += 0.5;
  if (priceAligned) rawScore += 0.5;

  let chopPenalty = 0;
  if (crossCount >= 2) chopPenalty += 0.5;
  if (gapPercent < TINY_GAP_PERCENT) chopPenalty += 0.25;
  if (slopePercent < FLAT_SLOPE_PERCENT) chopPenalty += 0.25;
  const choppy = chopPenalty > 0;
  const emaTimingScore = clamp(Math.min(2.0, rawScore) - chopPenalty, 0, 2.0);

  return {
    available: true,
    ema9: current9,
    ema21: current21,
    ema9Above21,
    ema9Slope,
    ema21Slope,
    freshCross,
    crossoverAgeCandles,
    emaTimingScore,
    timingState,
    choppy,
    chopPenalty,
    gapPercent,
  };
}

export function calculateEmaTimingQuality(confirmedCloses: number[], side: EmaTimingSide): EmaTimingQualityResult {
  if (confirmedCloses.length < 30 || confirmedCloses.some((v) => !Number.isFinite(v) || v <= 0)) {
    return { available: false, freshCross: "none", crossoverAgeCandles: null, emaTimingScore: 0, timingState: "Unavailable", choppy: false, chopPenalty: 0 };
  }
  const ema9Raw = EMA.calculate({ period: 9, values: confirmedCloses });
  const ema21Raw = EMA.calculate({ period: 21, values: confirmedCloses });
  const alignedCloses: number[] = [];
  const aligned9: number[] = [];
  const aligned21: number[] = [];
  for (let closeIndex = 20; closeIndex < confirmedCloses.length; closeIndex++) {
    alignedCloses.push(confirmedCloses[closeIndex]);
    aligned9.push(ema9Raw[closeIndex - 8]);
    aligned21.push(ema21Raw[closeIndex - 20]);
  }
  return scoreEmaTimingFromSeries({ closes: alignedCloses, ema9: aligned9, ema21: aligned21, side });
}

export function calculateFinalSetupScore(emaTimingScore: number, breakoutBonus: boolean): number {
  return 6 + clamp(emaTimingScore, 0, 2) + (breakoutBonus ? 0.5 : 0);
}
