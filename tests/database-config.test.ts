import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl } from "../server/database-config";

test("SQLite connection configuration preserves paths and parameters while bounding the pool", () => {
  for (const path of [
    "file:./dev.db",
    "file:/tmp/Party Up/预约.db",
    "file:C:/data/party.db",
  ])
    assert.equal(databaseUrl(path), path + "?connection_limit=1");
  assert.equal(
    databaseUrl(
      "file:/data/db?socket_timeout=2&connection_limit=9&connection_limit=4",
    ),
    "file:/data/db?socket_timeout=2&connection_limit=1",
  );
  assert.equal(
    databaseUrl("file:/data/db?connection_limit=1"),
    "file:/data/db?connection_limit=1",
  );
});
test("database configuration leaves missing URLs and other providers unchanged", () => {
  for (const url of [
    undefined,
    "postgresql://localhost/party?connection_limit=5",
    "mysql://localhost/party",
  ])
    assert.equal(databaseUrl(url), url);
});
