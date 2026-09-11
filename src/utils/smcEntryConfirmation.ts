export type SmcSide = "LONG" | "SHORT";

export interface SmcCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  time?: number;
}

export interface SmcEntryConfirmationResult {
  confirmed: boolean;
  side: SmcSide;
  reason: string;
  liquiditySweep: boolean;
  sweepIndex: number | null;
  sweepLevel: number | null;
  mss: boolean;
  mssIndex: number | null;
  mssLevel: number | null;
  displacement: boolean;
  displacementIndex: number | null;
  displacementBodyRatio: number | null;
  displacementVsMedianBody: number | null;
  fvg: boolean;
  fvgLow: number | null;
  fvgHigh: number | null;
  retest: boolean;
  rejection: boolean;
  rejectionType: "ENGULFING" | "WICK_REJECTION" | "STRONG_CLOSE" | null;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const validCandle = (c: SmcCandle) =>
  [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
  c.high >= Math.max(c.open, c.close) &&
  c.low <= Math.min(c.open, c.close) &&
  c.high > c.low;

function result(side: SmcSide, reason: string, patch: Partial<SmcEntryConfirmationResult> = {}): SmcEntryConfirmationResult {
  return {
    confirmed: false,
    side,
    reason,
    liquiditySweep: false,
    sweepIndex: null,
    sweepLevel: null,
    mss: false,
    mssIndex: null,
    mssLevel: null,
    displacement: false,
    displacementIndex: null,
    displacementBodyRatio: null,
    displacementVsMedianBody: null,
    fvg: false,
    fvgLow: null,
    fvgHigh: null,
    retest: false,
    rejection: false,
    rejectionType: null,
    ...patch,
  };
}

/**
 * Mechanical SMC/ICT Phase-A entry confirmation.
 *
 * Sequence (all on confirmed 5m candles):
 * 1) recent liquidity sweep of the prior 5-candle swing,
 * 2) displacement candle that closes through pre-sweep structure (MSS),
 * 3) a three-candle FVG around that displacement,
 * 4) the latest confirmed candle retests the FVG,
 * 5) the same latest candle rejects the zone.
 *
 * Requiring the latest candle to be the retest/rejection candle prevents the
 * scanner from chasing a setup several candles after the actual confirmation.
 */
export function evaluateSmcEntryConfirmation(candles: SmcCandle[], side: SmcSide): SmcEntryConfirmationResult {
  if (!Array.isArray(candles) || candles.length < 12 || candles.some((c) => !validCandle(c))) {
    return result(side, "SMC requires at least 12 valid confirmed 5m candles");
  }

  const n = candles.length;
  const sweepLookback = 5;
  const earliestSweep = Math.max(sweepLookback, n - 12);
  // Leave at least: MSS/displacement, FVG confirmation candle, latest retest candle.
  const latestSweep = n - 4;

  let sweepIndex: number | null = null;
  let sweepLevel: number | null = null;
  let structureLevel: number | null = null;

  for (let i = latestSweep; i >= earliestSweep; i--) {
    const prior = candles.slice(i - sweepLookback, i);
    const priorLow = Math.min(...prior.map((c) => c.low));
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const c = candles[i];
    const swept = side === "LONG"
      ? c.low < priorLow && c.close > priorLow
      : c.high > priorHigh && c.close < priorHigh;
    if (swept) {
      sweepIndex = i;
      sweepLevel = side === "LONG" ? priorLow : priorHigh;
      structureLevel = side === "LONG" ? priorHigh : priorLow;
      break;
    }
  }

  if (sweepIndex === null || sweepLevel === null || structureLevel === null) {
    return result(side, side === "LONG" ? "No recent sell-side liquidity sweep" : "No recent buy-side liquidity sweep");
  }

  const base = {
    liquiditySweep: true,
    sweepIndex,
    sweepLevel,
    mssLevel: structureLevel,
  };

  let displacementIndex: number | null = null;
  let displacementBodyRatio: number | null = null;
  let displacementVsMedianBody: number | null = null;
  let fvgLow: number | null = null;
  let fvgHigh: number | null = null;

  // j+1 confirms the FVG; n-1 is reserved for the retest/rejection.
  for (let j = sweepIndex + 1; j <= n - 3; j++) {
    const c = candles[j];
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = range > 0 ? body / range : 0;
    const bodyHistory = candles.slice(Math.max(0, j - 10), j).map((x) => Math.abs(x.close - x.open)).filter((x) => x > 0);
    const medianBody = median(bodyHistory);
    const vsMedian = medianBody > 0 ? body / medianBody : 0;
    const directional = side === "LONG" ? c.close > c.open : c.close < c.open;
    const mss = side === "LONG" ? c.close > structureLevel : c.close < structureLevel;
    const displaced = directional && bodyRatio >= 0.60 && vsMedian >= 1.35;

    if (!mss || !displaced || j < 1 || j + 1 >= n) continue;

    const before = candles[j - 1];
    const after = candles[j + 1];
    const hasFvg = side === "LONG"
      ? after.low > before.high
      : after.high < before.low;
    if (!hasFvg) continue;

    displacementIndex = j;
    displacementBodyRatio = bodyRatio;
    displacementVsMedianBody = vsMedian;
    if (side === "LONG") {
      fvgLow = before.high;
      fvgHigh = after.low;
    } else {
      fvgLow = after.high;
      fvgHigh = before.low;
    }
    break;
  }

  if (displacementIndex === null || fvgLow === null || fvgHigh === null) {
    return result(side, "Liquidity swept, but no displacement MSS with a valid 5m FVG", base);
  }

  const latest = candles[n - 1];
  const previous = candles[n - 2];
  const touchesFvg = latest.low <= fvgHigh && latest.high >= fvgLow;
  const respectsFvg = side === "LONG" ? latest.close > fvgHigh : latest.close < fvgLow;
  const directionalClose = side === "LONG" ? latest.close > latest.open : latest.close < latest.open;
  const range = latest.high - latest.low;
  const body = Math.abs(latest.close - latest.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const lowerWick = Math.min(latest.open, latest.close) - latest.low;
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const wickRejection = side === "LONG" ? lowerWick / range >= 0.25 : upperWick / range >= 0.25;
  const engulfing = side === "LONG"
    ? latest.close > latest.open && latest.open <= previous.close && latest.close >= previous.open
    : latest.close < latest.open && latest.open >= previous.close && latest.close <= previous.open;
  const strongClose = directionalClose && bodyRatio >= 0.55;

  let rejectionType: SmcEntryConfirmationResult["rejectionType"] = null;
  if (engulfing) rejectionType = "ENGULFING";
  else if (wickRejection && directionalClose) rejectionType = "WICK_REJECTION";
  else if (strongClose) rejectionType = "STRONG_CLOSE";

  const patch = {
    ...base,
    mss: true,
    mssIndex: displacementIndex,
    displacement: true,
    displacementIndex,
    displacementBodyRatio,
    displacementVsMedianBody,
    fvg: true,
    fvgLow,
    fvgHigh,
    retest: touchesFvg,
    rejection: Boolean(touchesFvg && respectsFvg && rejectionType),
    rejectionType: touchesFvg && respectsFvg ? rejectionType : null,
  };

  if (!touchesFvg) return result(side, "MSS/FVG confirmed; waiting for latest 5m candle to retest the FVG", patch);
  if (!respectsFvg) return result(side, "FVG retested but the latest 5m candle did not close back outside the imbalance", patch);
  if (!rejectionType) return result(side, "FVG retested but no engulfing, rejection wick, or strong directional close", patch);

  return result(side, "SMC Phase-A confirmation complete", {
    ...patch,
    confirmed: true,
  });
}
