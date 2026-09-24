import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test(
  "maintenance health transitions, lock and private state",
  {
    skip: process.platform !== "linux",
  },
  () => {
    const result = spawnSync("bash", ["tests/maintenance.test.sh"], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
