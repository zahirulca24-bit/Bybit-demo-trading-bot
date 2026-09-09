import { normalizeTimestampMs } from "./utcTradingDay";

export type ExitCategory = "TP" | "SL" | "TRAILING" | "MANUAL" | "OTHER";

export interface ExitClassificationResult {
  category: ExitCategory;
  label: string;
  classifiedBy: string;
  matchedOrderId?: string;
  matchedOrderLinkId?: string;
  rawStopOrderType?: string;
  rawCreateType?: string;
}

type AnyRecord = Record<string, any>;

const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
const recordTime = (record: AnyRecord) => normalizeTimestampMs(record.execTime || record.updatedTime || record.createdTime || record.time);
const recordQty = (record: AnyRecord) => Number(record.closedSize || record.execQty || record.cumExecQty || record.qty || 0);

function categoryFromRecord(record: AnyRecord | undefined): { category: ExitCategory; classifiedBy: string } | null {
  if (!record) return null;
  const stopOrderType = normalize(record.stopOrderType);
  const createType = normalize(record.createType);
  const orderLinkId = normalize(record.orderLinkId);
  const combined = `${stopOrderType}|${createType}`;

  if (combined.includes("stoploss") || combined.includes("createbystoploss")) {
    return { category: "SL", classifiedBy: stopOrderType ? "stopOrderType" : "createType" };
  }
  if (combined.includes("takeprofit") || combined.includes("createbytakeprofit")) {
    return { category: "TP", classifiedBy: stopOrderType ? "stopOrderType" : "createType" };
  }
  if (combined.includes("trailingstop") || combined.includes("createbytrailing")) {
    return { category: "TRAILING", classifiedBy: stopOrderType ? "stopOrderType" : "createType" };
  }
  if (orderLinkId.startsWith("bottrail") || orderLinkId.startsWith("apptrail")) {
    return { category: "TRAILING", classifiedBy: "orderLinkId" };
  }
  if (orderLinkId.startsWith("botmanual") || orderLinkId.startsWith("appmanual")) {
    return { category: "MANUAL", classifiedBy: "orderLinkId" };
  }
  return null;
}

function categoryFromText(value: unknown): { category: ExitCategory; classifiedBy: string } | null {
  const reason = String(value ?? "").trim();
  const text = reason.toLowerCase();
  if (!text) return null;
  if (text.includes("stop loss") || /(^|\b)sl(\b|\d)/i.test(reason)) return { category: "SL", classifiedBy: "localReason" };
  if (text.includes("take profit") || /(^|\b)tp(\b|\d)/i.test(reason)) return { category: "TP", classifiedBy: "localReason" };
  if (text.includes("trailing")) return { category: "TRAILING", classifiedBy: "localReason" };
  if (text.includes("manual") || text.includes("panic")) return { category: "MANUAL", classifiedBy: "localReason" };
  return null;
}

function correlationScore(closedTrade: AnyRecord, candidate: AnyRecord, closeTime: number): number {
  if (!candidate || String(candidate.symbol || "") !== String(closedTrade.symbol || "")) return -1;
  let score = 20;
  if (closedTrade.orderId && candidate.orderId && String(closedTrade.orderId) === String(candidate.orderId)) score += 140;
  if (closedTrade.orderLinkId && candidate.orderLinkId && String(closedTrade.orderLinkId) === String(candidate.orderLinkId)) score += 120;

  const candidateTime = recordTime(candidate);
  if (candidateTime > 0 && closeTime > 0) {
    const delta = Math.abs(candidateTime - closeTime);
    if (delta <= 10_000) score += 45;
    else if (delta <= 30_000) score += 35;
    else if (delta <= 90_000) score += 20;
    else if (delta <= 180_000) score += 5;
    else if (score < 100) return -1;
  }

  const closedQty = Number(closedTrade.qty || closedTrade.closedSize || 0);
  const candidateQty = recordQty(candidate);
  if (closedQty > 0 && candidateQty > 0) {
    const ratioError = Math.abs(candidateQty - closedQty) / closedQty;
    if (ratioError <= 0.01) score += 20;
    else if (ratioError <= 0.10) score += 10;
  }
  if (candidate.reduceOnly === true || String(candidate.reduceOnly).toLowerCase() === "true") score += 10;
  if (Number(candidate.closedSize || 0) > 0) score += 10;
  if (categoryFromRecord(candidate)) score += 25;
  return score;
}

function labelFor(category: ExitCategory): string {
  return category === "SL"
    ? "Stop Loss"
    : category === "TP"
      ? "Take Profit"
      : category === "TRAILING"
        ? "Trailing Stop"
        : category === "MANUAL"
          ? "Manual Close"
          : "Unknown / Other";
}

export function classifyClosedTradeExit(params: {
  closedTrade: AnyRecord;
  executions?: AnyRecord[];
  orders?: AnyRecord[];
  localHistory?: AnyRecord[];
}): ExitClassificationResult {
  const { closedTrade, executions = [], orders = [], localHistory = [] } = params;
  const closeTime = normalizeTimestampMs(closedTrade.updatedTime || closedTrade.execTime || closedTrade.createdTime || closedTrade.time);
  const closedTradeEvidence = categoryFromRecord(closedTrade);
  if (closedTradeEvidence) {
    return {
      category: closedTradeEvidence.category,
      label: labelFor(closedTradeEvidence.category),
      classifiedBy: `exchange.closedPnl.${closedTradeEvidence.classifiedBy}`,
      matchedOrderId: closedTrade.orderId ? String(closedTrade.orderId) : undefined,
      matchedOrderLinkId: closedTrade.orderLinkId ? String(closedTrade.orderLinkId) : undefined,
      rawStopOrderType: closedTrade.stopOrderType ? String(closedTrade.stopOrderType) : undefined,
      rawCreateType: closedTrade.createType ? String(closedTrade.createType) : undefined,
    };
  }

  const candidates = [...orders, ...executions]
    .map((record) => ({ record, score: correlationScore(closedTrade, record, closeTime), hit: categoryFromRecord(record) }))
    .filter((item) => item.score >= 30 && item.hit !== null)
    .sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    const strongestScore = candidates[0].score;
    // Exact-ID/link correlations (>=160) must not be overruled by weaker time-nearby records.
    // Otherwise only near-equal high-confidence records may compete in the category precedence step.
    const confidenceFloor = strongestScore >= 160 ? 160 : Math.max(60, strongestScore - 15);
    const strongestGroup = candidates.filter((item) => item.score >= confidenceFloor);
    for (const category of ["SL", "TP", "TRAILING", "MANUAL"] as const) {
      const match = strongestGroup.find((item) => item.hit?.category === category);
      if (match?.hit) {
        return {
          category,
          label: labelFor(category),
          classifiedBy: `exchange.correlated.${match.hit.classifiedBy}`,
          matchedOrderId: match.record.orderId ? String(match.record.orderId) : undefined,
          matchedOrderLinkId: match.record.orderLinkId ? String(match.record.orderLinkId) : undefined,
          rawStopOrderType: match.record.stopOrderType ? String(match.record.stopOrderType) : undefined,
          rawCreateType: match.record.createType ? String(match.record.createType) : undefined,
        };
      }
    }
  }

  const local = localHistory
    .filter((item) => String(item.symbol || "") === String(closedTrade.symbol || ""))
    .map((item) => ({ item, delta: Math.abs(normalizeTimestampMs(item.time || item.closedAt) - closeTime) }))
    .filter((item) => item.delta <= 45_000)
    .sort((a, b) => a.delta - b.delta)[0]?.item;
  const localHit = categoryFromText(local?.reason || local?.exitReason);
  if (localHit) {
    return {
      category: localHit.category,
      label: labelFor(localHit.category),
      classifiedBy: localHit.classifiedBy,
      matchedOrderId: closedTrade.orderId ? String(closedTrade.orderId) : undefined,
      rawStopOrderType: closedTrade.stopOrderType ? String(closedTrade.stopOrderType) : undefined,
      rawCreateType: closedTrade.createType ? String(closedTrade.createType) : undefined,
    };
  }

  return {
    category: "OTHER",
    label: "Unknown / Other",
    classifiedBy: "fallback.unknown",
    matchedOrderId: closedTrade.orderId ? String(closedTrade.orderId) : undefined,
    matchedOrderLinkId: closedTrade.orderLinkId ? String(closedTrade.orderLinkId) : undefined,
    rawStopOrderType: closedTrade.stopOrderType ? String(closedTrade.stopOrderType) : undefined,
    rawCreateType: closedTrade.createType ? String(closedTrade.createType) : undefined,
  };
}
