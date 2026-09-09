import type { ScannedMarketItem } from "../types";

export const STRICT_MAX_CONCURRENT_POSITIONS = 3;

export type ScannerTimingState = "Bullish" | "Bearish" | "Neutral" | "Unavailable";

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatFinite(value: unknown, decimals: number): string {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : numeric.toFixed(decimals);
}

export function getEmaTimingState(item: Pick<ScannedMarketItem, "emaTimingState" | "ema9Above21" | "ema9" | "ema21">): ScannerTimingState {
  if (item.emaTimingState === "Bullish" || item.emaTimingState === "Bearish" || item.emaTimingState === "Neutral") {
    return item.emaTimingState;
  }
  if (item.emaTimingState === "Unavailable") return "Unavailable";

  const ema9 = finiteNumber(item.ema9);
  const ema21 = finiteNumber(item.ema21);
  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) return "Bullish";
    if (ema9 < ema21) return "Bearish";
    return "Neutral";
  }

  if (item.ema9Above21 === true) return "Bullish";
  return "Unavailable";
}

export function getEmaRelationLabel(state: ScannerTimingState): string {
  if (state === "Bullish") return "EMA9 > EMA21";
  if (state === "Bearish") return "EMA9 < EMA21";
  if (state === "Neutral") return "Neutral";
  return "—";
}

export function getFreshCrossLabel(freshCross: ScannedMarketItem["freshCross"], crossoverAgeCandles: ScannedMarketItem["crossoverAgeCandles"]): string {
  if (freshCross !== "bullish" && freshCross !== "bearish") return "—";
  const prefix = freshCross === "bullish" ? "Bullish Cross" : "Bearish Cross";
  const age = finiteNumber(crossoverAgeCandles);
  if (age === null || age < 0) return prefix;
  if (age === 0) return prefix;
  if (age === 1) return `${prefix} · 1 candle ago`;
  return `${prefix} · ${Math.trunc(age)} candles ago`;
}

export function getEmaTimingScoreLabel(item: Pick<ScannedMarketItem, "emaTimingState" | "emaTimingScore" | "ema9" | "ema21" | "ema9Above21">): string {
  const state = getEmaTimingState(item);
  if (state === "Unavailable") return "—";
  const score = finiteNumber(item.emaTimingScore);
  return score === null ? "—" : `${score.toFixed(1)} / 2.0`;
}

export function getScannerTimingDisplay(item: ScannedMarketItem) {
  const state = getEmaTimingState(item);
  return {
    state,
    relation: getEmaRelationLabel(state),
    cross: getFreshCrossLabel(item.freshCross, item.crossoverAgeCandles),
    score: getEmaTimingScoreLabel(item),
  };
}
