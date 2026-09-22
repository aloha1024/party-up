import { test } from "node:test";
import assert from "node:assert/strict";
import { assertIsolatedTestEnvironment } from "../scripts/test-isolation.mjs";
test("test guard accepts only the runner database and HTTP endpoint", () => {
  assert.ok(assertIsolatedTestEnvironment());
  assert.throws(() =>
    assertIsolatedTestEnvironment({
      ...process.env,
      DATABASE_URL: "file:./production.db",
    }),
  );
  assert.throws(() =>
    assertIsolatedTestEnvironment({
      ...process.env,
      PARTY_TEST_TOKEN: "invalid",
    }),
  );
  assert.throws(() =>
    assertIsolatedTestEnvironment({
      ...process.env,
      TEST_BASE_URL: "http://production.example",
    }),
  );
  assert.throws(() => assertIsolatedTestEnvironment({ NODE_ENV: "test" }));
});
