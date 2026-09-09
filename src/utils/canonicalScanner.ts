import type { PipelineGateSummary, PipelineState, ScannedMarketItem } from "../types";

export type Gate6FailureReason = "RSI_OUT_OF_RANGE" | "DIRECTIONAL_CANDLE_FAILED" | "RSI_AND_CANDLE_FAILED" | "NO_DIRECTIONAL_TREND" | null;

export interface Gate6Evaluation {
  rsiPassed: boolean;
  candlePassed: boolean;
  passed: boolean;
  failureReason: Gate6FailureReason;
  rsiDetail: string;
  candleDetail: string;
}

export function evaluateGate6(input: {
  trend15m: "Bullish HTF" | "Bearish HTF" | "Neutral HTF";
  rsi: number;
  longCandleConfirmed: boolean;
  shortCandleConfirmed: boolean;
}): Gate6Evaluation {
  const { trend15m, rsi, longCandleConfirmed, shortCandleConfirmed } = input;
  if (trend15m === "Neutral HTF") {
    return {
      rsiPassed: false,
      candlePassed: false,
      passed: false,
      failureReason: "NO_DIRECTIONAL_TREND",
      rsiDetail: "No directional EMA50/200 trend for RSI window",
      candleDetail: "No directional trend for candle confirmation",
    };
  }

  const isLong = trend15m === "Bullish HTF";
  const rsiPassed = isLong ? rsi >= 50 && rsi <= 64 : rsi >= 36 && rsi <= 50;
  const candlePassed = isLong ? longCandleConfirmed : shortCandleConfirmed;
  let failureReason: Gate6FailureReason = null;
  if (!rsiPassed && !candlePassed) failureReason = "RSI_AND_CANDLE_FAILED";
  else if (!rsiPassed) failureReason = "RSI_OUT_OF_RANGE";
  else if (!candlePassed) failureReason = "DIRECTIONAL_CANDLE_FAILED";

  return {
    rsiPassed,
    candlePassed,
    passed: rsiPassed && candlePassed,
    failureReason,
    rsiDetail: rsiPassed
      ? (isLong ? "RSI inside Long 50–64" : "RSI inside Short 36–50")
      : (isLong ? "RSI outside Long 50–64" : "RSI outside Short 36–50"),
    candleDetail: candlePassed
      ? (isLong ? "Bullish confirmed 5m candle" : "Bearish confirmed 5m candle")
      : (isLong ? "Bullish directional candle confirmation failed" : "Bearish directional candle confirmation failed"),
  };
}

export function buildExecutionEligibility(input: {
  gateCandidate: boolean;
  botRunning: boolean;
  activePositionsCount: number;
  maxConcurrent: number;
  riskAllowed?: boolean;
  preOrderAllowed?: boolean;
  blockReason?: string | null;
}) {
  if (!input.gateCandidate) {
    return { gateCandidate: false, riskEligible: false, executableNow: false, blockReason: input.blockReason || "Hard six-gate setup not passed" };
  }
  if (!input.botRunning) {
    return { gateCandidate: true, riskEligible: false, executableNow: false, blockReason: "Bot engine is halted" };
  }
  if (input.activePositionsCount >= input.maxConcurrent) {
    return { gateCandidate: true, riskEligible: false, executableNow: false, blockReason: `Max ${input.maxConcurrent} concurrent positions reached` };
  }
  if (input.riskAllowed !== true) {
    return { gateCandidate: true, riskEligible: false, executableNow: false, blockReason: input.blockReason || "Risk eligibility unavailable or blocked" };
  }
  if (input.preOrderAllowed !== true) {
    return { gateCandidate: true, riskEligible: true, executableNow: false, blockReason: input.blockReason || "Latest pre-order validation failed" };
  }
  return { gateCandidate: true, riskEligible: true, executableNow: true, blockReason: null };
}

function gateSummary(gateNumber: number, name: string, ruleDescription: string, inputCount: number, passCount: number): PipelineGateSummary {
  return {
    gateNumber,
    name,
    ruleDescription,
    status: inputCount > 0 && inputCount === passCount ? "Passed" : gateNumber === 6 && passCount > 0 ? "Active" : "Filtering",
    inputCount,
    passCount,
    passRatePercent: inputCount > 0 ? Math.round((passCount / inputCount) * 100) : 0,
  };
}

export function buildPipelineStateFromMarkets(markets: ScannedMarketItem[], isScanning: boolean, lastScanTimestamp: number): PipelineState {
  const g1 = markets.filter((s) => s.gates.gate1_volume.passed);
  const g2 = g1.filter((s) => s.gates.gate2_trend.passed);
  const g3 = g2.filter((s) => s.gates.gate3_spread.passed);
  const g4 = g3.filter((s) => s.gates.gate4_atr.passed);
  const g5 = g4.filter((s) => s.gates.gate5_oi.passed);
  const g6 = g5.filter((s) => s.gates.gate6_rsi.passed && s.gates.gate6_candle.passed);

  return {
    totalDiscovered: markets.length,
    passedAllCount: g6.length,
    candidateCount: g6.length,
    gates: [
      gateSummary(1, "24h Volume / Turnover", "Min $25M 24h turnover", markets.length, g1.length),
      gateSummary(2, "15m HTF Trend Structure (EMA 50/200)", "EMA direction + confirmed price side of EMA50", g1.length, g2.length),
      gateSummary(3, "Orderbook Spread", "Fresh spread <= 0.08%", g2.length, g3.length),
      gateSummary(4, "5m Volatility (ATR)", "Confirmed ATR 0.30%-1.20%", g3.length, g4.length),
      gateSummary(5, "Open Interest (OI)", "Real 1h OI expansion >= +0.50%", g4.length, g5.length),
      gateSummary(6, "5m RSI + Candle Confirmation", "RSI window AND directional confirmed candle; breakout bonus only", g5.length, g6.length),
    ],
    // Deliberately preserve the exact evaluated result objects. There is no visualization-only symbol model.
    symbols: markets,
    lastScanTimestamp,
    isScanning,
  };
}

export function formatScannerTurnover(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}
