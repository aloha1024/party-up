import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test(
  "Linux backup script stops/restarts correctly and fails closed on interrupted restore",
  { skip: process.platform !== "linux" },
  () => {
    const result = spawnSync("bash", ["tests/backup-shell.test.sh"], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
