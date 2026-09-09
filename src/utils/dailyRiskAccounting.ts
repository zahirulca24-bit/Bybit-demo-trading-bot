import { normalizeTimestampMs } from "./utcTradingDay";
import { paginateUntilBoundary } from "./tradingReports";

export const RISK_DATA_UNAVAILABLE = "RISK_DATA_UNAVAILABLE";

export type ClosedPnlLoadResult =
  | { ok: true; items: any[] }
  | { ok: false; items: []; error: string };

export async function fetchClosedPnlRange(
  bybit: any,
  startMs: number,
  endMs: number,
  maxPages: number = 100,
): Promise<ClosedPnlLoadResult> {
  try {
    const items = await paginateUntilBoundary(
      async (cursor?: string) => {
        const response = await bybit.getClosedPnL({
          category: "linear",
          startTime: startMs,
          endTime: Math.max(startMs, endMs - 1),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (response?.retCode !== 0) {
          throw new Error(response?.retMsg || "Closed PnL returned non-zero retCode");
        }
        return {
          items: response?.result?.list || [],
          nextCursor: response?.result?.nextPageCursor || null,
        };
      },
      startMs,
      (item: any) => normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime),
      maxPages,
    );
    return { ok: true, items: items.filter((item: any) => {
      const t = normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime);
      return t >= startMs && t < endMs;
    }) };
  } catch (error: any) {
    return {
      ok: false,
      items: [],
      error: error?.message || "Closed PnL history unavailable",
    };
  }
}

export function buildRiskAccounting(
  closedResult: ClosedPnlLoadResult,
  positions: any[],
  dayStartMs: number,
) {
  const unrealized = positions.reduce((sum: number, pos: any) => sum + Number(pos.unrealisedPnl || 0), 0);
  if (closedResult.ok === false) {
    return {
      available: false as const,
      reason: RISK_DATA_UNAVAILABLE,
      error: closedResult.error,
      closed: [] as any[],
      realized: null as number | null,
      unrealized,
      net: null as number | null,
      dayStartMs,
    };
  }
  const realized = closedResult.items.reduce((sum: number, item: any) => {
    const t = normalizeTimestampMs(item.updatedTime || item.execTime || item.createdTime);
    return t >= dayStartMs ? sum + Number(item.closedPnl || 0) : sum;
  }, 0);
  return {
    available: true as const,
    reason: null,
    error: null,
    closed: closedResult.items,
    realized,
    unrealized,
    net: realized + unrealized,
    dayStartMs,
  };
}

export function evaluateEntryRiskAccounting(
  accounting: { available: boolean; net: number | null; error?: string | null },
  dailyLimit: number,
): { allowed: boolean; reason?: string; breakerTriggered: boolean } {
  if (!accounting.available || !Number.isFinite(accounting.net)) {
    return {
      allowed: false,
      breakerTriggered: false,
      reason: `${RISK_DATA_UNAVAILABLE}${accounting.error ? `: ${accounting.error}` : ""}`,
    };
  }
  if (Number(accounting.net) <= dailyLimit) {
    return {
      allowed: false,
      breakerTriggered: true,
      reason: `Daily circuit breaker active: net PnL $${Number(accounting.net).toFixed(2)} <= $${dailyLimit.toFixed(2)}`,
    };
  }
  return { allowed: true, breakerTriggered: false };
}
