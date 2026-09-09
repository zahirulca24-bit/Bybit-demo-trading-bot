import assert from "node:assert/strict";
import { DAILY_PNL_UNAVAILABLE, buildRiskAccounting, evaluateEntryRiskAccounting, fetchClosedPnlRange } from "./dailyRiskAccounting";

async function run() {
  const start = Date.parse("2026-09-09T00:00:00.000Z");
  const end = Date.parse("2026-09-10T00:00:00.000Z");
  const rows = Array.from({ length: 205 }, (_, i) => ({
    orderId: `c-${i}`,
    closedPnl: i % 2 ? "1" : "-1",
    updatedTime: String(end - 1 - i * 1000),
  }));
  let calls = 0;
  const pagedClient = {
    async getClosedPnL(params: any) {
      const offset = params.cursor ? Number(params.cursor) : 0;
      calls++;
      return {
        retCode: 0,
        result: {
          list: rows.slice(offset, offset + 100),
          nextPageCursor: offset + 100 < rows.length ? String(offset + 100) : "",
        },
      };
    },
  };
  const loaded = await fetchClosedPnlRange(pagedClient, start, end, 10);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.items.length, 205);
  assert.equal(calls, 3, "daily ClosedPnL must follow every cursor until the requested range is exhausted");

  const failed = await fetchClosedPnlRange({
    async getClosedPnL() { throw new Error("network down"); },
  }, start, end);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.reason, DAILY_PNL_UNAVAILABLE);

  const rejected = await fetchClosedPnlRange({
    async getClosedPnL() { return { retCode: 10006, retMsg: "rate limited" }; },
  }, start, end);
  assert.equal(rejected.ok, false, "non-zero Bybit retCode must fail closed");

  let repeatedCalls = 0;
  const repeatedCursor = await fetchClosedPnlRange({
    async getClosedPnL() {
      repeatedCalls++;
      return {
        retCode: 0,
        result: {
          list: [{ closedPnl: "1", updatedTime: String(end - 1000) }],
          nextPageCursor: "same-cursor",
        },
      };
    },
  }, start, end, 10);
  assert.equal(repeatedCursor.ok, false, "repeated cursor must not silently produce incomplete daily PnL");
  assert.ok(repeatedCalls >= 2);

  const maxPageFailure = await fetchClosedPnlRange({
    async getClosedPnL(params: any) {
      return {
        retCode: 0,
        result: {
          list: [{ closedPnl: "1", updatedTime: String(end - 1000) }],
          nextPageCursor: String(Number(params.cursor || 0) + 1),
        },
      };
    },
  }, start, end, 2);
  assert.equal(maxPageFailure.ok, false, "pagination safety limit must fail closed instead of using a partial daily total");

  const accounting = buildRiskAccounting(failed, [{ unrealisedPnl: "-2.50" }], start);
  assert.equal(accounting.available, false);
  assert.equal(accounting.realized, null, "failed history must never become realized=0");
  assert.equal(accounting.net, null, "unknown daily net must remain unknown");
  const decision = evaluateEntryRiskAccounting(accounting, -50);
  assert.equal(decision.allowed, false, "new entries must fail closed when daily PnL is unavailable");
  assert.equal(decision.reason, DAILY_PNL_UNAVAILABLE);

  const knownZero = buildRiskAccounting({ ok: true, items: [] }, [], start);
  assert.equal(knownZero.realized, 0, "successful empty ClosedPnL is a known zero, distinct from unavailable");
  assert.equal(knownZero.net, 0);

  const healthy = buildRiskAccounting({ ok: true, items: [
    { closedPnl: "-48", updatedTime: String(start + 1000) },
  ] }, [{ unrealisedPnl: "-3" }], start);
  assert.equal(healthy.net, -51);
  const breaker = evaluateEntryRiskAccounting(healthy, -50);
  assert.equal(breaker.allowed, false);
  assert.equal(breaker.breakerTriggered, true);

  const safe = buildRiskAccounting({ ok: true, items: [
    { closedPnl: "-10", updatedTime: String(start + 1000) },
  ] }, [{ unrealisedPnl: "1" }], start);
  assert.equal(evaluateEntryRiskAccounting(safe, -50).allowed, true);

  console.log("Daily risk accounting tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
