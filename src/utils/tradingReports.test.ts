import assert from "node:assert/strict";
import {
  aggregateClosedPnlByIdentity,
  bangladeshBoundaryReady,
  bangladeshDailyDeliveryKey,
  coverageForWindow,
  dedupeOpeningExecutions,
  formatBangladeshDay,
  hasUsableEmaTimingMetadata,
  hourlyDeliveryKey,
  maxConsecutiveLosses,
  paginateUntilBoundary,
  previousBangladeshDay,
  previousFullUtcHour,
  qualityBreakdown,
  reconcileTradeLifecycles,
  sendWithRetry,
  snapshotReliability,
  splitTelegramMessage,
  summarizeClosedTrades,
  summarizeTradeSourceCoverage,
} from "./tradingReports";

async function run() {
  const now = Date.parse("2026-09-10T14:37:22Z");
  const hour = previousFullUtcHour(now);
  assert.equal(new Date(hour.startMs).toISOString(), "2026-09-10T13:00:00.000Z");
  assert.equal(new Date(hour.endMs).toISOString(), "2026-09-10T14:00:00.000Z");
  assert.equal(hourlyDeliveryKey(hour), "telegram:hourly:2026-09-10T13");

  // Bangladesh calendar day 2026-09-10 is 2026-09-09 18:00Z -> 2026-09-10 18:00Z.
  const bdtDay = previousBangladeshDay(Date.parse("2026-09-10T18:00:05.000Z"));
  assert.equal(new Date(bdtDay.startMs).toISOString(), "2026-09-09T18:00:00.000Z");
  assert.equal(new Date(bdtDay.endMs).toISOString(), "2026-09-10T18:00:00.000Z");
  assert.equal(formatBangladeshDay(bdtDay), "2026-09-10");
  assert.equal(bangladeshDailyDeliveryKey(bdtDay), "telegram:daily:bdt:2026-09-10");
  assert.equal(bangladeshDailyDeliveryKey(previousBangladeshDay(Date.parse("2026-09-10T23:00:00Z"))), bangladeshDailyDeliveryKey(bdtDay), "restart/catch-up identity must be stable for the completed BDT day");
  assert.equal(bangladeshBoundaryReady(Date.parse("2026-09-10T18:00:04.999Z"), 5000), false);
  assert.equal(bangladeshBoundaryReady(Date.parse("2026-09-10T18:00:05.000Z"), 5000), true);
  assert.ok(Date.parse("2026-09-10T17:59:59.999Z") < bdtDay.endMs);
  assert.equal(Date.parse("2026-09-10T18:00:00.000Z"), bdtDay.endMs, "exact boundary belongs to the new BDT day, not the completed one");

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
  );

  const zero = summarizeClosedTrades([]);
  assert.equal(zero.closed, 0);

  const metadata = summarizeClosedTrades([
    { pnl: -5, exitLabel: "Manual" },
    { pnl: 7, exitLabel: "Other / Unknown" },
    { pnl: -2, exitLabel: "SL" },
    { pnl: 3, exitLabel: "TP" },
    { pnl: 1, exitLabel: "Trailing" },
  ]);
  assert.equal(metadata.exits.Manual, 1);
  assert.equal(metadata.exits.Other, 1);
  assert.equal(metadata.closed, Object.values(metadata.exits).reduce((a, b) => a + b, 0));
  assert.equal(maxConsecutiveLosses([{ pnl: -1 }, { pnl: -2 }, { pnl: 1 }, { pnl: -3 }]), 2);

  const quality = qualityBreakdown([
    { pnl: 4, entryDiagnostics: { trendState: "Bullish HTF", emaTimingState: "Bullish", emaTimingScore: 1.5, freshCross: "bullish" } },
    { pnl: -2, entryDiagnostics: { trendState: "Bullish HTF", emaTimingState: "Bearish", emaTimingScore: 0.5, freshCross: "none" } },
  ]);
  assert.equal(quality.aligned.count, 1);
  assert.equal(quality.nonAligned.count, 1);
  assert.equal(quality.freshCross.count, 1);
  assert.equal(quality.noFreshCross.count, 1);
  assert.equal(hasUsableEmaTimingMetadata({ entryDiagnostics: null }), false);
  assert.equal(hasUsableEmaTimingMetadata({ entryDiagnostics: { emaTimingState: "Unavailable", emaTimingScore: 0 } }), false);
  assert.equal(hasUsableEmaTimingMetadata({ entryDiagnostics: { emaTimingState: "Neutral", emaTimingScore: 0 } }), true, "observed neutral zero is a real zero, not unavailable");

  // One opening order with multiple fills counts as one opening identity.
  const win = { startMs: 1000, endMs: 2000 };
  const openingFills = dedupeOpeningExecutions([
    { orderId: "open-1", execId: "f1", execQty: "0.5", closedSize: "0", __timestampMs: 1200, side: "Buy" },
    { orderId: "open-1", execId: "f2", execQty: "0.5", closedSize: "0", __timestampMs: 1210, side: "Buy" },
  ], win);
  assert.equal(openingFills.length, 1);

  // Multiple Closed PnL rows for the same closing order are aggregated, preserving PnL.
  const closes = aggregateClosedPnlByIdentity([
    { orderId: "close-1", symbol: "BTCUSDT", closedPnl: "2", updatedTime: 1500 },
    { orderId: "close-1", symbol: "BTCUSDT", closedPnl: "3", updatedTime: 1510 },
  ], (x) => Number(x.updatedTime));
  assert.equal(closes.length, 1);
  assert.equal(Number(closes[0].closedPnl), 5);

  const lifecycleRows = [
    // Open before day start and close during day.
    { id: "a", source: "auto", openedAt: 900, closedAt: 1300, openingOrderId: "oa", closingOrderId: "ca" },
    // Open and close within the day.
    { id: "b", source: "auto", openedAt: 1100, closedAt: 1600, openingOrderId: "ob", closingOrderId: "cb" },
    // Open during day and remain open at end.
    { id: "c", source: "manual", openedAt: 1400, closedAt: null, openingOrderId: "oc", closingOrderId: null },
    // Same symbol could reopen as a separate persisted lifecycle; identity is not symbol-only.
    { id: "d", source: "external", openedAt: 1700, closedAt: 1800, openingOrderId: "od", closingOrderId: "cd" },
  ];
  const reconciliation = reconcileTradeLifecycles(lifecycleRows, win, 3, 3);
  assert.equal(reconciliation.dayStartOpen, 1);
  assert.equal(reconciliation.openedDuringWindow, 3);
  assert.equal(reconciliation.closedDuringWindow, 3);
  assert.equal(reconciliation.dayEndOpen, 1);
  assert.equal(reconciliation.delta, 0);
  assert.equal(reconciliation.status, "PASS");

  // Distinct partial-close identities cannot safely be collapsed into one lifecycle close.
  const partialCloseRecon = reconcileTradeLifecycles(lifecycleRows, win, 3, 4);
  assert.equal(partialCloseRecon.status, "PARTIAL");

  // Missing historical exchange identities => partial, never fake PASS.
  const legacyRecon = reconcileTradeLifecycles([
    { id: "legacy", source: "unknown", openedAt: 1100, closedAt: 1600 },
  ], win, 1, 1);
  assert.equal(legacyRecon.status, "PARTIAL");

  // Conservation error must be explicit FAIL with numeric delta.
  const badRecon = reconcileTradeLifecycles([
    { id: "bad", source: "auto", openedAt: 900, closedAt: 1600, openingOrderId: "o", closingOrderId: "c" },
    { id: "orphan", source: "auto", openedAt: null, closedAt: 1700, closingOrderId: "x" },
  ], win, 0, 2);
  assert.notEqual(badRecon.status, "PASS");

  const sourceFull = summarizeTradeSourceCoverage([
    { source: "auto" }, { source: "manual" }, { source: "external" },
  ], 3);
  assert.equal(sourceFull.full, true);
  assert.equal(sourceFull.auto, 1);
  const sourcePartial = summarizeTradeSourceCoverage([{ source: "unknown" }], 4);
  assert.equal(sourcePartial.full, false);
  assert.equal(sourcePartial.coverage, 0);

  assert.equal(coverageForWindow(900, win), "FULL");
  assert.equal(coverageForWindow(1200, win), "PARTIAL");
  assert.equal(coverageForWindow(null, win), "UNAVAILABLE");
  assert.equal(snapshotReliability(1000, 1050, 60_000), true);
  assert.equal(snapshotReliability(1000, 70_001, 60_000), false);

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

  console.log("Telegram trading report tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
