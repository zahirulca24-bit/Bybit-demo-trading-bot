export interface AdaptiveStopPlan {
  stopLoss: number;
  stopDistancePercent: number;
  atrPercent: number;
  atrMultiplier: number;
  stopDistanceAtrMultiple: number;
  swingPrice: number;
  structureStop: number;
  atrStop: number;
  reason: string;
  cappedByMaxDistance: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function calculateAdaptiveStopPlan(input: {
  side: "Buy" | "Sell";
  entryPrice: number;
  atr: number;
  swingPrice: number;
  minDistancePercent?: number;
  maxDistancePercent?: number;
}): AdaptiveStopPlan {
  const { side, entryPrice, atr, swingPrice } = input;
  if (!(entryPrice > 0) || !(atr > 0)) throw new Error("Adaptive SL requires positive entry price and ATR");

  const minDistancePercent = input.minDistancePercent ?? 1.0;
  const maxDistancePercent = input.maxDistancePercent ?? 1.8;
  const atrPercent = (atr / entryPrice) * 100;
  const atrBandProgress = clamp((atrPercent - 0.30) / (1.20 - 0.30), 0, 1);
  const atrMultiplier = 1.20 + atrBandProgress * 0.30;
  const atrDistance = atr * atrMultiplier;
  const structureBuffer = atr * 0.15;
  const isLong = side === "Buy";
  const atrStop = isLong ? entryPrice - atrDistance : entryPrice + atrDistance;
  const rawStructureStop = isLong ? swingPrice - structureBuffer : swingPrice + structureBuffer;
  const structureIsProtective = isLong ? rawStructureStop < entryPrice : rawStructureStop > entryPrice;
  const structureStop = structureIsProtective ? rawStructureStop : atrStop;
  const desiredStop = isLong ? Math.min(atrStop, structureStop) : Math.max(atrStop, structureStop);
  const desiredDistancePercent = Math.abs(entryPrice - desiredStop) / entryPrice * 100;
  const stopDistancePercent = clamp(desiredDistancePercent, minDistancePercent, maxDistancePercent);
  const stopLoss = isLong
    ? entryPrice * (1 - stopDistancePercent / 100)
    : entryPrice * (1 + stopDistancePercent / 100);
  const cappedByMaxDistance = desiredDistancePercent > maxDistancePercent;
  const stopDistanceAtrMultiple = Math.abs(entryPrice - stopLoss) / atr;
  const reason = cappedByMaxDistance
    ? `ATR x${atrMultiplier.toFixed(2)} + 6-candle structure, capped at ${maxDistancePercent.toFixed(2)}% max distance`
    : desiredDistancePercent < minDistancePercent
      ? `ATR x${atrMultiplier.toFixed(2)} + 6-candle structure, floored at legacy ${minDistancePercent.toFixed(2)}% noise tolerance`
      : `Farther of ATR x${atrMultiplier.toFixed(2)} or 6-candle structure + 0.15 ATR buffer`;

  return {
    stopLoss,
    stopDistancePercent,
    atrPercent,
    atrMultiplier,
    stopDistanceAtrMultiple,
    swingPrice,
    structureStop,
    atrStop,
    reason,
    cappedByMaxDistance,
  };
}

export function calculateRiskAdjustedNotional(baseNotional: number, stopDistancePercent: number, referenceRiskPercent = 1.0): number {
  if (!(baseNotional > 0) || !(stopDistancePercent > 0) || !(referenceRiskPercent > 0)) return 0;
  return Math.min(baseNotional, baseNotional * (referenceRiskPercent / stopDistancePercent));
}
