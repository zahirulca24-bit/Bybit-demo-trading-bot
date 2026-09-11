import { normalizeTimestampMs } from "./utcTradingDay";

export interface PendingCloseIdentity {
  orderId?: string;
  orderLinkId?: string;
  submittedAt: number;
}

/**
 * Pick the Closed PnL row that belongs to a locally submitted close.
 *
 * When a stable closing identity exists, never fall back to "latest row" or
 * timestamp proximity. Bybit can briefly return the previous close while the
 * new close is still propagating, and accepting that stale row corrupts the
 * lifecycle/audit record.
 */
export function selectClosedPnlForIntent(rows: any[], intent?: PendingCloseIdentity | null): any | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (!intent) return rows[0] ?? null;

  if (intent.orderId) {
    const exactOrder = rows.find((row) => row?.orderId && String(row.orderId) === String(intent.orderId));
    if (exactOrder) return exactOrder;
  }

  if (intent.orderLinkId) {
    const exactLink = rows.find((row) => row?.orderLinkId && String(row.orderLinkId) === String(intent.orderLinkId));
    if (exactLink) return exactLink;
  }

  // If we have a stable identity, absence of an exact match means the new
  // close is not visible yet. Keep the intent pending and retry on next sync.
  if (intent.orderId || intent.orderLinkId) return null;

  // Defensive fallback only for callers without stable IDs.
  const earliestAcceptable = intent.submittedAt - 5_000;
  return rows.find((row) => {
    const t = normalizeTimestampMs(row?.updatedTime || row?.execTime || row?.createdTime);
    return t >= earliestAcceptable;
  }) ?? null;
}
