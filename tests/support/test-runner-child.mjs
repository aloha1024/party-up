import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { assertIsolatedTestEnvironment } from "../../scripts/test-isolation.mjs";

const keys = [
  "DATABASE_URL",
  "PARTY_TEST_ROOT",
  "PARTY_TEST_TOKEN",
  "ADMIN_PASSWORD_HASH",
  "ADMIN_SESSION_SECRET",
  "TEST_BASE_URL",
  "TEST_ADMIN_PASSWORD",
  "NODE_OPTIONS",
  "NODE_TEST_CONTEXT",
];

export async function runFixture(kind, args = []) {
  const stage =
    kind === "prisma" ? args.join("-") : kind === "next" ? args[0] : kind;
  const logPath = process.env.RUNNER_FIXTURE_LOG;
  assert.ok(logPath);
  const prior = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  const environment = Object.fromEntries(
    keys.map((key) => [key, process.env[key] ?? null]),
  );
  let marker = null;
  if (stage !== "typecheck") {
    const root = assertIsolatedTestEnvironment();
    marker = JSON.parse(readFileSync(join(root, "test-context.json"), "utf8"));
    assert.equal(process.env.ADMIN_USERNAME, "admin");
    assert.equal(process.env.TRUST_PROXY, "0");
    assert.equal(process.env.NODE_OPTIONS, undefined);
    if (stage === "migrate-deploy") {
      assert.ok(
        readFileSync(join(root, "tests.db"), "utf8") === "",
        "new database starts empty",
      );
      const earlier = prior.filter((event) => event.stage === "migrate-deploy");
      for (const event of earlier) {
        assert.ok(
          event.environment.PARTY_TEST_ROOT !== root,
          "stage roots differ",
        );
        assert.equal(existsSync(event.environment.PARTY_TEST_ROOT), false);
        assert.ok(
          event.environment.PARTY_TEST_TOKEN !== process.env.PARTY_TEST_TOKEN,
          "stage tokens differ",
        );
        assert.ok(
          event.environment.ADMIN_PASSWORD_HASH !==
            process.env.ADMIN_PASSWORD_HASH,
          "stage password hashes differ",
        );
        assert.ok(
          event.environment.ADMIN_SESSION_SECRET !==
            process.env.ADMIN_SESSION_SECRET,
          "stage session secrets differ",
        );
      }
      assert.equal(process.env.TEST_BASE_URL, undefined);
      assert.ok(
        process.env.TEST_ADMIN_PASSWORD === undefined,
        "no admin password before service start",
      );
      assert.equal(marker.baseUrl, undefined);
      writeFileSync(
        join(root, "tests.db"),
        "migrated:" + process.env.PARTY_TEST_TOKEN,
      );
    }
    if (stage === "business" || stage === "browser") {
      assert.ok(
        /^[a-f0-9]{48}$/.test(process.env.TEST_ADMIN_PASSWORD ?? ""),
        "fresh random administrator password",
      );
      assert.equal(marker.baseUrl, process.env.TEST_BASE_URL);
      const health = await fetch(process.env.TEST_BASE_URL + "/api/health");
      assert.equal(health.ok, true);
      assert.ok(
        (await health.text()) === process.env.PARTY_TEST_TOKEN,
        "service belongs to the current stage",
      );
      if (stage === "business") {
        writeFileSync(join(root, "tests.db"), "business-only-data");
      } else {
        assert.ok(
          readFileSync(join(root, "tests.db"), "utf8") ===
            "migrated:" + process.env.PARTY_TEST_TOKEN,
          "browser database contains no business-stage rows",
        );
        assert.equal(
          prior.some(
            (event) =>
              event.stage === "business" &&
              event.environment.TEST_BASE_URL === process.env.TEST_BASE_URL,
          ),
          false,
        );
      }
    }
    if (stage === "unit") {
      assert.equal(process.env.TEST_BASE_URL, undefined);
      assert.ok(
        process.env.TEST_ADMIN_PASSWORD === undefined,
        "unit mode has no HTTP password",
      );
      assert.equal(marker.baseUrl, undefined);
    }
  } else {
    for (const key of [
      "PARTY_TEST_ROOT",
      "PARTY_TEST_TOKEN",
      "TEST_BASE_URL",
      "TEST_ADMIN_PASSWORD",
    ])
      assert.ok(
        process.env[key] === undefined,
        `${key} must not escape the disposed business stage`,
      );
    for (const event of prior.filter(
      (entry) => entry.stage === "migrate-deploy",
    ))
      assert.equal(existsSync(event.environment.PARTY_TEST_ROOT), false);
  }
  appendFileSync(
    logPath,
    JSON.stringify({ stage, args, environment, marker, pid: process.pid }) +
      "\n",
    { mode: 0o600 },
  );
  if (process.env.RUNNER_FIXTURE_FAIL === stage) process.exit(17);
  if (stage === "start") {
    const port = Number(args[args.indexOf("--port") + 1]);
    const server = createServer((_req, res) => {
      res.end(process.env.PARTY_TEST_TOKEN);
    });
    server.listen(port, "127.0.0.1");
  } else if (process.env.RUNNER_FIXTURE_HOLD === stage) {
    setInterval(() => {}, 1000);
  }
}
