import assert from "node:assert/strict";
import { buildFreshAccountSnapshot, extractApiError, QUICK_TEST_REQUESTED_QTY } from "./frontendContract";
assert.equal(extractApiError({ error: { message: "private API denied" }, message: "wrong" }), "private API denied");
assert.equal(extractApiError({ error: "flat error" }), "flat error");
assert.equal(QUICK_TEST_REQUESTED_QTY, "0.001");
const snap = buildFreshAccountSnapshot({ balance: "1000" }, { positions: [{ unrealisedPnl: "12.5" }, { unrealisedPnl: "-2.5" }] });
assert.deepEqual(snap && { walletBalance: snap.walletBalance, unrealizedPnl: snap.unrealizedPnl, estimatedEquity: snap.estimatedEquity }, { walletBalance: 1000, unrealizedPnl: 10, estimatedEquity: 1010 });
assert.equal(buildFreshAccountSnapshot({ balance: "1000" }, { positions: [{ unrealisedPnl: undefined }] }), null);
console.log("frontend contract regression tests passed");
