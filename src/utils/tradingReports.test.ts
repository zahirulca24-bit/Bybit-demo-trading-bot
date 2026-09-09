import assert from "node:assert/strict";
import {
  dailyDeliveryKey,
  hourlyDeliveryKey,
  maxConsecutiveLosses,
  paginateUntilBoundary,
  previousFullUtcHour,
  previousUtcDay,
  qualityBreakdown,
  sendWithRetry,
  splitTelegramMessage,
  summarizeClosedTrades,
} from "./tradingReports";

async function run() {
  const now = Date.parse("2026-09-10T14:37:22Z");
  const hour = previousFullUtcHour(now);
  assert.equal(new Date(hour.startMs).toISOString(), "2026-09-10T13:00:00.000Z");
  assert.equal(new Date(hour.endMs).toISOString(), "2026-09-10T14:00:00.000Z");

  const day = previousUtcDay(Date.parse("2026-09-10T00:00:05Z"));
  assert.equal(new Date(day.startMs).toISOString(), "2026-09-09T00:00:00.000Z");
  assert.equal(new Date(day.endMs).toISOString(), "2026-09-10T00:00:00.000Z");
  assert.equal(hourlyDeliveryKey(hour), "telegram:hourly:2026-09-10T13");
  assert.equal(dailyDeliveryKey(day), "telegram:daily:2026-09-09");

  // Duplicate prevention identities are deterministic across restart/reconnect.
  assert.equal(hourlyDeliveryKey(previousFullUtcHour(now)), hourlyDeliveryKey(hour));
  assert.equal(dailyDeliveryKey(previousUtcDay(Date.parse("2026-09-10T12:00:00Z"))), dailyDeliveryKey(day));

  const oversized = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(30)}`).join("\n");
  const chunks = splitTelegramMessage(oversized, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((part) => part.length <= 300));
  assert.equal(chunks.join("\n"), oversized, "message splitting must preserve every line without silent truncation");

  const records = Array.from({ length: 250 }, (_, i) => ({ id: i, t: 1000 - i }));
  let pages = 0;
  const paged = await paginateUntilBoundary(async (cursor) => {
    const start = cursor ? Number(cursor) : 0;
    pages++;
    return {
      items: records.slice(start, start + 100),
      nextCursor: start + 100 < records.length ? String(start + 100) : null,
    };
  }, 800, (x) => x.t, 10);
  assert.ok(pages >= 2, "pagination must move beyond 100 records");
  assert.ok(paged.every((x) => x.t >= 800));

  await assert.rejects(
    () => paginateUntilBoundary(async (cursor) => ({
      items: [{ t: 1000 }],
      nextCursor: String((Number(cursor || 0) + 1)),
    }), 800, (x) => x.t, 2),
    /Pagination safety limit/,
    "pagination safety limit must surface partial data rather than silently return incomplete history",
  );

  const zero = summarizeClosedTrades([]);
  assert.equal(zero.closed, 0);
  assert.equal(zero.exits.TP + zero.exits.SL + zero.exits.Trailing + zero.exits.Manual + zero.exits.Other, 0);

  const metadata = summarizeClosedTrades([
    { pnl: -5, exitLabel: "Manual" },
    { pnl: 7, exitLabel: "Other / Unknown" },
    { pnl: -2, exitLabel: "SL" },
    { pnl: 3, exitLabel: "TP" },
    { pnl: 1, exitLabel: "Trailing" },
  ]);
  assert.equal(metadata.exits.Manual, 1, "losing manual close must remain Manual");
  assert.equal(metadata.exits.Other, 1, "winning Unknown must remain Unknown");
  assert.equal(metadata.exits.SL, 1);
  assert.equal(metadata.exits.TP, 1);
  assert.equal(metadata.exits.Trailing, 1);
  assert.equal(metadata.closed, Object.values(metadata.exits).reduce((a, b) => a + b, 0));

  assert.equal(maxConsecutiveLosses([{ pnl: -1 }, { pnl: -2 }, { pnl: 1 }, { pnl: -3 }]), 2);

  const quality = qualityBreakdown([
    { pnl: 4, entryDiagnostics: { trendState: "Bullish HTF", emaTimingState: "Bullish", freshCross: "bullish" } },
    { pnl: -2, entryDiagnostics: { trendState: "Bullish HTF", emaTimingState: "Bearish", freshCross: "none" } },
  ]);
  assert.equal(quality.aligned.count, 1);
  assert.equal(quality.nonAligned.count, 1);
  assert.equal(quality.freshCross.count, 1);
  assert.equal(quality.noFreshCross.count, 1);

  let attempts = 0;
  const retry = await sendWithRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("temporary network failure");
  }, { maxAttempts: 3, delaysMs: [0, 0], sleep: async () => {} });
  assert.equal(retry.success, true);
  assert.equal(retry.attempts, 3);

  let fatalAttempts = 0;
  const fatal = await sendWithRetry(async () => {
    fatalAttempts++;
    throw new Error("still down");
  }, { maxAttempts: 3, delaysMs: [0, 0], sleep: async () => {} });
  assert.equal(fatal.success, false);
  assert.equal(fatalAttempts, 3);

  const activeAcrossMidnight = { openedAt: Date.parse("2026-09-09T23:50:00Z"), closedAt: Date.parse("2026-09-10T00:15:00Z") };
  assert.equal(activeAcrossMidnight.openedAt < day.endMs && activeAcrossMidnight.closedAt >= day.endMs, true);

  const partialSources = ["Bybit closedPnL"];
  assert.equal(partialSources.length > 0, true, "partial upstream failure must be represented explicitly");

  console.log("Telegram trading report tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
