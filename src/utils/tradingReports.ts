export type ReportWindow = { startMs: number; endMs: number };
export type ReportExitLabel = "TP" | "SL" | "Trailing" | "Manual" | "Other / Unknown";
export type TradeSource = "auto" | "manual" | "external" | "unknown";
export type ReconciliationStatus = "PASS" | "PARTIAL" | "FAIL" | "UNAVAILABLE";

const BDT_OFFSET_MS = 6 * 60 * 60 * 1000;

export function previousFullUtcHour(nowMs: number = Date.now()): ReportWindow {
  const currentHourStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
    new Date(nowMs).getUTCHours(),
    0, 0, 0,
  );
  return { startMs: currentHourStart - 60 * 60 * 1000, endMs: currentHourStart };
}

export function previousUtcDay(nowMs: number = Date.now()): ReportWindow {
  const now = new Date(nowMs);
  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  return { startMs: currentDayStart - 24 * 60 * 60 * 1000, endMs: currentDayStart };
}

/** Asia/Dhaka has a fixed UTC+06:00 offset for the reporting dates used by this application. */
export function currentBangladeshDayStartMs(nowMs: number = Date.now()): number {
  const shifted = new Date(nowMs + BDT_OFFSET_MS);
  const shiftedMidnightUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0);
  return shiftedMidnightUtc - BDT_OFFSET_MS;
}

export function previousBangladeshDay(nowMs: number = Date.now()): ReportWindow {
  const currentStart = currentBangladeshDayStartMs(nowMs);
  return { startMs: currentStart - 24 * 60 * 60 * 1000, endMs: currentStart };
}

export function currentBangladeshDay(nowMs: number = Date.now()): ReportWindow {
  const startMs = currentBangladeshDayStartMs(nowMs);
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

export function bangladeshDateForTimestamp(timestampMs: number): string {
  return new Date(timestampMs + BDT_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatBangladeshDay(window: ReportWindow): string {
  return bangladeshDateForTimestamp(window.startMs);
}

export function bangladeshDailyDeliveryKey(window: ReportWindow): string {
  return `telegram:daily:bdt:${formatBangladeshDay(window)}`;
}

export function bangladeshBoundaryReady(nowMs: number, delayMs: number = 5_000): boolean {
  return nowMs - currentBangladeshDayStartMs(nowMs) >= delayMs;
}

export function hourlyDeliveryKey(window: ReportWindow): string {
  return `telegram:hourly:${new Date(window.startMs).toISOString().slice(0, 13)}`;
}

/** Legacy UTC daily key retained only for compatibility with old report records/tests. */
export function dailyDeliveryKey(window: ReportWindow): string {
  return `telegram:daily:${new Date(window.startMs).toISOString().slice(0, 10)}`;
}

export function formatUtcHourWindow(window: ReportWindow): string {
  const start = new Date(window.startMs);
  const end = new Date(window.endMs);
  const hh = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  return `${hh(start)}–${hh(end)} UTC`;
}

export function formatUtcDay(window: ReportWindow): string {
  return new Date(window.startMs).toISOString().slice(0, 10);
}

export function normalizeExitLabel(value: unknown): ReportExitLabel {
  const text = String(value || "").trim().toLowerCase();
  if (text === "tp" || text.includes("take profit")) return "TP";
  if (text === "sl" || text.includes("stop loss")) return "SL";
  if (text.includes("trail")) return "Trailing";
  if (text.includes("manual")) return "Manual";
  return "Other / Unknown";
}

export interface ClosedTradeLike {
  pnl: number;
  exitLabel?: unknown;
  side?: "LONG" | "SHORT" | string;
  openedAt?: number | null;
  closedAt?: number | null;
  entryDiagnostics?: Record<string, any> | null;
}

export function summarizeClosedTrades(trades: ClosedTradeLike[]) {
  const valid = trades.filter((t) => Number.isFinite(t.pnl));
  const wins = valid.filter((t) => t.pnl > 0).length;
  const losses = valid.filter((t) => t.pnl < 0).length;
  const grossProfit = valid.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = valid.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0);
  const realized = valid.reduce((sum, t) => sum + t.pnl, 0);
  const exits = { TP: 0, SL: 0, Trailing: 0, Manual: 0, Other: 0 };
  for (const trade of valid) {
    const label = normalizeExitLabel(trade.exitLabel);
    if (label === "TP") exits.TP++;
    else if (label === "SL") exits.SL++;
    else if (label === "Trailing") exits.Trailing++;
    else if (label === "Manual") exits.Manual++;
    else exits.Other++;
  }
  return {
    closed: valid.length,
    wins,
    losses,
    winRate: valid.length ? (wins / valid.length) * 100 : 0,
    grossProfit,
    grossLoss,
    realized,
    averagePnl: valid.length ? realized / valid.length : 0,
    exits,
  };
}

export function currentConsecutiveLosses(trades: ClosedTradeLike[]): number {
  let count = 0;
  for (const trade of trades) {
    if (Number(trade.pnl) < 0) count++;
    else break;
  }
  return count;
}

export function maxConsecutiveLosses(tradesChronological: ClosedTradeLike[]): number {
  let current = 0;
  let max = 0;
  for (const trade of tradesChronological) {
    if (Number(trade.pnl) < 0) {
      current++;
      max = Math.max(max, current);
    } else current = 0;
  }
  return max;
}

export function safeAverage(values: unknown[]): number | null {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function qualityBreakdown(trades: ClosedTradeLike[]) {
  const groups: Record<string, ClosedTradeLike[]> = {
    aligned: [],
    nonAligned: [],
    freshCross: [],
    noFreshCross: [],
  };
  for (const trade of trades) {
    const d = trade.entryDiagnostics;
    if (!d) continue;
    const state = String(d.emaTimingState || "").toLowerCase();
    const trend = String(d.trendState || "").toLowerCase();
    const aligned = (trend.includes("bull") && state === "bullish") || (trend.includes("bear") && state === "bearish");
    (aligned ? groups.aligned : groups.nonAligned).push(trade);
    const cross = String(d.freshCross || "none").toLowerCase();
    (cross === "bullish" || cross === "bearish" ? groups.freshCross : groups.noFreshCross).push(trade);
  }

  const summarize = (items: ClosedTradeLike[]) => {
    const s = summarizeClosedTrades(items);
    return {
      count: items.length,
      winRate: items.length ? s.winRate : null,
      slRate: items.length ? (s.exits.SL / items.length) * 100 : null,
      avgPnl: items.length ? s.averagePnl : null,
    };
  };

  return {
    aligned: summarize(groups.aligned),
    nonAligned: summarize(groups.nonAligned),
    freshCross: summarize(groups.freshCross),
    noFreshCross: summarize(groups.noFreshCross),
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string | null;
}

export async function paginateUntilBoundary<T>(
  fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
  startMs: number,
  getTimestampMs: (item: T) => number,
  maxPages: number = 100,
): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();

  let complete = false;
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const page = await fetchPage(cursor);
    collected.push(...page.items);
    if (page.items.some((item) => getTimestampMs(item) < startMs)) {
      complete = true;
      break;
    }
    const next = page.nextCursor || undefined;
    if (!next) {
      complete = true;
      break;
    }
    if (seen.has(next)) throw new Error("Pagination cursor repeated before report boundary was exhausted");
    seen.add(next);
    cursor = next;
  }
  if (!complete) throw new Error(`Pagination safety limit (${maxPages} pages) reached before report boundary was exhausted`);

  return collected.filter((item) => {
    const timestamp = getTimestampMs(item);
    return Number.isFinite(timestamp) && timestamp >= startMs;
  });
}

export async function sendWithRetry(
  attemptSend: () => Promise<void>,
  options: { maxAttempts?: number; delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ success: boolean; attempts: number; error?: unknown }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delays = options.delaysMs ?? [750, 2000];
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await attemptSend();
      return { success: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 1000);
    }
  }

  return { success: false, attempts: maxAttempts, error: lastError };
}

export function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatMoney(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "Unavailable";
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : "-"}$${Math.abs(numeric).toFixed(2)}`;
}

export function formatMetric(value: number | null | undefined, decimals: number = 2): string {
  return Number.isFinite(value) ? Number(value).toFixed(decimals) : "Unavailable";
}

export function splitTelegramMessage(message: string, maxChars: number = 3800): string[] {
  if (message.length <= maxChars) return [message];
  const parts: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (line.length <= maxChars) {
      current = line;
      continue;
    }
    for (let i = 0; i < line.length; i += maxChars) {
      const chunk = line.slice(i, i + maxChars);
      if (chunk.length === maxChars || i + maxChars < line.length) parts.push(chunk);
      else current = chunk;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [message];
}

export function canonicalOpeningIdentity(item: any): string | null {
  const id = item?.orderId || item?.orderLinkId;
  return id ? String(id) : null;
}

export function canonicalClosingIdentity(item: any): string | null {
  const id = item?.orderId || item?.orderLinkId;
  return id ? String(id) : null;
}

export function dedupeOpeningExecutions(executions: any[], window: ReportWindow): any[] {
  const byIdentity = new Map<string, any>();
  for (const item of executions) {
    const t = Number(item.__timestampMs ?? item.execTime ?? item.createdTime ?? 0);
    if (!(t >= window.startMs && t < window.endMs)) continue;
    const closedSize = Number(item.closedSize || 0);
    const execQty = Number(item.execQty || 0);
    if (!(execQty > 0) || closedSize > 0) continue;
    const identity = canonicalOpeningIdentity(item) || String(item.execId || `${item.symbol}:${t}:${item.side}`);
    if (!byIdentity.has(identity)) byIdentity.set(identity, item);
  }
  return [...byIdentity.values()];
}

/**
 * Closed PnL can contain more than one row for one closing order. Rows with the same
 * closing identity are aggregated so partial fills of one close order count once while PnL is preserved.
 * Distinct close-order identities are intentionally not collapsed because doing so without a lifecycle id
 * would fabricate certainty about partial-position closes.
 */
export function aggregateClosedPnlByIdentity(rows: any[], getTimestampMs: (row: any) => number): any[] {
  const grouped = new Map<string, any>();
  rows.forEach((row, index) => {
    const timestamp = getTimestampMs(row);
    const identity = canonicalClosingIdentity(row) || `unidentified:${row.symbol || "?"}:${timestamp}:${row.side || "?"}:${index}`;
    const current = grouped.get(identity);
    if (!current) {
      grouped.set(identity, { ...row, closedPnl: Number(row.closedPnl || 0), __timestampMs: timestamp });
      return;
    }
    current.closedPnl = Number(current.closedPnl || 0) + Number(row.closedPnl || 0);
    if (timestamp > Number(current.__timestampMs || 0)) {
      current.__timestampMs = timestamp;
      current.updatedTime = row.updatedTime || current.updatedTime;
    }
  });
  return [...grouped.values()];
}

export interface PersistedTradeForReport {
  id: string;
  source?: TradeSource | string | null;
  openedAt: number | null;
  closedAt: number | null;
  openingOrderId?: string | null;
  openingOrderLinkId?: string | null;
  closingOrderId?: string | null;
  closingOrderLinkId?: string | null;
}

export function reconcileTradeLifecycles(
  rows: PersistedTradeForReport[],
  window: ReportWindow,
  exchangeOpenedCount: number | null,
  exchangeClosedCount: number | null,
) {
  const usable = rows.filter((row) => row.openedAt !== null && row.openedAt !== undefined && Number.isFinite(Number(row.openedAt)));
  const dayStartOpenRows = usable.filter((row) => Number(row.openedAt) < window.startMs && (!row.closedAt || Number(row.closedAt) >= window.startMs));
  const openedRows = usable.filter((row) => Number(row.openedAt) >= window.startMs && Number(row.openedAt) < window.endMs);
  const closedRows = usable.filter((row) => row.closedAt && Number(row.closedAt) >= window.startMs && Number(row.closedAt) < window.endMs);
  const dayEndOpenRows = usable.filter((row) => Number(row.openedAt) < window.endMs && (!row.closedAt || Number(row.closedAt) >= window.endMs));

  const dayStartOpen = dayStartOpenRows.length;
  const openedDuringWindow = openedRows.length;
  const closedDuringWindow = closedRows.length;
  const dayEndOpen = dayEndOpenRows.length;
  const delta = dayStartOpen + openedDuringWindow - closedDuringWindow - dayEndOpen;

  const openingIdentityCovered = openedRows.filter((row) => Boolean(row.openingOrderId || row.openingOrderLinkId)).length;
  const closingIdentityCovered = closedRows.filter((row) => Boolean(row.closingOrderId || row.closingOrderLinkId)).length;
  const identityComplete = openingIdentityCovered === openedRows.length && closingIdentityCovered === closedRows.length;
  const exchangeComparable = exchangeOpenedCount !== null && exchangeClosedCount !== null;
  const exchangeMatches = !exchangeComparable || (exchangeOpenedCount === openedDuringWindow && exchangeClosedCount === closedDuringWindow);

  let status: ReconciliationStatus;
  let reason: string;
  if (delta !== 0) {
    status = "FAIL";
    reason = `lifecycle conservation delta ${delta}`;
  } else if (!identityComplete || !exchangeComparable || !exchangeMatches) {
    status = "PARTIAL";
    const reasons: string[] = [];
    if (!identityComplete) reasons.push("historical exchange identity coverage incomplete");
    if (!exchangeComparable) reasons.push("exchange history unavailable");
    else if (!exchangeMatches) reasons.push("exchange opening/closing identities do not fully match persisted lifecycle rows");
    reason = reasons.join("; ");
  } else {
    status = "PASS";
    reason = "canonical lifecycle conservation and exchange identity counts agree";
  }

  return {
    status,
    reason,
    dayStartOpen,
    openedDuringWindow,
    closedDuringWindow,
    dayEndOpen,
    delta,
    openingIdentityCovered,
    closingIdentityCovered,
    openedRows,
    closedRows,
  };
}

export function normalizeTradeSource(value: unknown): TradeSource {
  const source = String(value || "unknown").toLowerCase();
  if (source === "auto" || source === "manual" || source === "external") return source;
  return "unknown";
}

export function summarizeTradeSourceCoverage(rows: any[], expectedOpenCount: number | null) {
  const opened = rows;
  const counts = { auto: 0, manual: 0, external: 0, unknown: 0 };
  for (const row of opened) counts[normalizeTradeSource(row.source)]++;
  const expected = expectedOpenCount === null ? opened.length : Math.max(expectedOpenCount, opened.length);
  const known = counts.auto + counts.manual + counts.external;
  const full = expected === 0 ? true : known === expected && counts.unknown === 0 && opened.length === expected;
  const coverage = expected === 0 ? 1 : Math.min(1, known / expected);
  return { ...counts, known, expected, coverage, full };
}

export function hasUsableEmaTimingMetadata(trade: any): boolean {
  const d = trade?.entryDiagnostics;
  if (!d) return false;
  const score = Number(d.emaTimingScore);
  const state = String(d.emaTimingState || "");
  return Number.isFinite(score) && ["Bullish", "Bearish", "Neutral"].includes(state);
}

export function coverageForWindow(coverageStart: unknown, window: ReportWindow): "FULL" | "PARTIAL" | "UNAVAILABLE" {
  const start = Number(coverageStart);
  if (!Number.isFinite(start) || start <= 0) return "UNAVAILABLE";
  return start <= window.startMs ? "FULL" : "PARTIAL";
}

export function snapshotReliability(boundaryMs: number, capturedAtMs: number, maxDriftMs: number = 60_000): boolean {
  return capturedAtMs >= boundaryMs && capturedAtMs - boundaryMs <= maxDriftMs;
}
