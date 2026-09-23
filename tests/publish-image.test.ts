import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test(
  "image publication verifies the tested artifact and digest without rebuilding or leaking CLI output",
  { skip: process.platform !== "linux" },
  () => {
    const result = spawnSync("bash", ["tests/publish-image.test.sh"], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
