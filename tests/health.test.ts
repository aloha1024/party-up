import { test } from "node:test";
import assert from "node:assert/strict";
import { healthStatus } from "../lib/health";
test("health checks handle database errors and bound stalled probes", async () => {
  assert.equal(await healthStatus(async () => 1), 200);
  assert.equal(
    await healthStatus(async () => {
      throw new Error("private database detail");
    }),
    503,
  );
  assert.equal(await healthStatus(() => new Promise(() => {}), 10), 503);
});
