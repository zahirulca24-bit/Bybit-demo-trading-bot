export function normalizeTimestampMs(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;

  // Bybit V5 timestamps are normally milliseconds, but normalize seconds safely
  // so all daily accounting compares the same unit.
  return numeric < 1_000_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}

export function getUtcDayStartMs(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
}

export function isInCurrentUtcTradingDay(value: unknown, nowMs: number = Date.now()): boolean {
  const timestamp = normalizeTimestampMs(value);
  const start = getUtcDayStartMs(nowMs);
  return timestamp >= start && timestamp <= nowMs;
}

export function getUtcTradingDayWindow(nowMs: number = Date.now()) {
  return {
    startMs: getUtcDayStartMs(nowMs),
    endMs: nowMs,
  };
}
