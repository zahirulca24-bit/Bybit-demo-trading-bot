export type ReportWindow = { startMs: number; endMs: number };
export type ReportExitLabel = "TP" | "SL" | "Trailing" | "Manual" | "Other / Unknown";

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

export function hourlyDeliveryKey(window: ReportWindow): string {
  return `telegram:hourly:${new Date(window.startMs).toISOString().slice(0, 13)}`;
}

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
