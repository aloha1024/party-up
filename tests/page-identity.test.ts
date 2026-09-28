import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("page identity is shared only within a real React server render", async () => {
  // The normal node:test React entry does not install the RSC cache dispatcher.
  // Use an isolated process with React's server condition and Next's renderer.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "./scripts/test-preload.mjs",
      "--import",
      "tsx",
      "tests/support/page-identity-render.ts",
    ],
    { env, timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.match(stdout, /RSC identity checks passed/);
  assert.equal(stderr, "");
});
