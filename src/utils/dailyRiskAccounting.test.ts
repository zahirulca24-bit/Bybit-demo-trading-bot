import assert from "node:assert/strict";
import { buildRiskAccounting, evaluateEntryRiskAccounting, fetchClosedPnlRange, RISK_DATA_UNAVAILABLE } from "./dailyRiskAccounting";

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
  assert.ok(calls >= 3, "risk history must paginate beyond 100 rows");

  const failed = await fetchClosedPnlRange({
    async getClosedPnL() { throw new Error("network down"); },
  }, start, end);
  assert.equal(failed.ok, false);

  const accounting = buildRiskAccounting(failed, [{ unrealisedPnl: "-2.50" }], start);
  assert.equal(accounting.available, false);
  assert.equal(accounting.realized, null, "failed history must never become realized=0");
  assert.equal(accounting.net, null);
  const decision = evaluateEntryRiskAccounting(accounting, -50);
  assert.equal(decision.allowed, false, "new entries must fail closed when risk history is unavailable");
  assert.match(decision.reason || "", new RegExp(RISK_DATA_UNAVAILABLE));

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
