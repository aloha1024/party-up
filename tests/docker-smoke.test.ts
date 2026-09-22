import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test(
  "Docker smoke rediscovers ports after restart and stops safely on failed health checks",
  { skip: process.platform !== "linux" },
  () => {
    const result = spawnSync("bash", ["tests/docker-smoke.test.sh"], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
