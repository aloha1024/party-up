import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { assertIsolatedTestEnvironment } from "./test-isolation.mjs";
import {
  applyBenchmarkSchema,
  timingSummary,
} from "./benchmark-legacy-index.mjs";
import {
  actors,
  benchmarkNow,
  expectedList,
  expectedSchedule,
  hashToken,
  seedClaimRows,
  seedReservations,
  syntheticToken,
} from "./benchmark-fixtures.mjs";

// This check precedes even importing application database modules.
const root = assertIsolatedTestEnvironment();
const [phase, rowText, warmupText, sampleText] = process.argv.slice(2);
assert.ok(["timing", "diagnostic"].includes(phase));
const rows = Number(rowText),
  warmups = Number(warmupText),
  samples = Number(sampleText);
assert.ok([5000, 50000].includes(rows) && warmups === 5 && samples === 30);
const fixtureDb = new DatabaseSync(join(root, "tests.db"));
let client;
try {
  const migrations = applyBenchmarkSchema(fixtureDb);
  fixtureDb.exec("PRAGMA foreign_keys=ON");
  const fixtureRows = seedReservations(fixtureDb, rows);
  const backgroundRows = Object.fromEntries(
    ["GameReservation", "Participant", "WaitlistEntry"].map((table) => [
      table,
      fixtureDb.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get().total,
    ]),
  );
  const { PrismaClient, Prisma } = await import("@prisma/client");
  const { databaseUrl } = await import("../server/database-config.ts");
  client = new PrismaClient({
    datasourceUrl: databaseUrl(process.env.DATABASE_URL),
    log: phase === "diagnostic" ? [{ level: "query", emit: "event" }] : [],
  });
  globalThis.prisma = client;
  let active;
  if (phase === "diagnostic")
    client.$on("query", (event) => {
      if (active) active.events.push(event);
    });
  const originalTransaction = client.$transaction.bind(client);
  if (phase === "diagnostic") {
    client.$transaction = (run, options) => {
      if (active) active.transactions++;
      return originalTransaction(
        (tx) =>
          run(
            new Proxy(tx, {
              get(target, name) {
                const value = target[name];
                if (typeof value === "function")
                  return (...args) => {
                    if (active && String(name).startsWith("$query"))
                      active.delegates[String(name)] =
                        (active.delegates[String(name)] ?? 0) + 1;
                    return value.apply(target, args);
                  };
                if (
                  !value ||
                  typeof value !== "object" ||
                  String(name).startsWith("_")
                )
                  return value;
                return new Proxy(value, {
                  get(delegate, operation) {
                    const method = delegate[operation];
                    if (typeof method !== "function") return method;
                    return (...args) => {
                      const key = `${String(name)}.${String(operation)}`;
                      if (active)
                        active.delegates[key] =
                          (active.delegates[key] ?? 0) + 1;
                      return method.apply(delegate, args);
                    };
                  },
                });
              },
            }),
          ),
        options,
      );
    };
  }
  const { listReservations, listMyReservations } =
    await import("../server/reservation-list.ts");
  const { listMySchedule } = await import("../server/reservation-schedule.ts");
  const { previewGuestClaim, claimGuestRecords } =
    await import("../server/guest-claims.ts");
  const { resolveViewer, viewerContext } =
    await import("../server/user-identity.ts");
  const { withRequestBudget } = await import("../server/request-budget.ts");
  await client.$connect();
  const sqlite = (
    await client.$queryRawUnsafe("SELECT sqlite_version() AS version")
  )[0].version;
  const scenarios = [];
  const withoutFilters = ({ filters: _filters, ...page }) => page;
  const scheduleProjection = ({ items, nearest, total, page, pageCount }) => ({
    items,
    nearest,
    total,
    page,
    pageCount,
  });
  function list(name, input, owner) {
    const expected = expectedList(fixtureRows, input, owner);
    scenarios.push({
      name,
      input,
      run: () =>
        owner
          ? listMyReservations(input, actors[owner], benchmarkNow)
          : listReservations(input, benchmarkNow),
      verify: (result) => {
        const value = withoutFilters(result);
        assert.deepEqual(value, expected);
        return value;
      },
    });
  }
  list("list.first", {});
  const futureCount = fixtureRows.filter(
    (r) =>
      r.deletedAt === null &&
      r.visibility === "PUBLIC" &&
      r.scheduledAt > benchmarkNow.getTime(),
  ).length;
  const boundarySize = [12, 11, 13].find((size) => futureCount % size !== 0);
  assert.ok(boundarySize);
  list("list.time-boundary", {
    pageSize: boundarySize,
    page: Math.floor(futureCount / boundarySize) + 1,
  });
  list("list.deep-page", { page: 100 });
  list("list.search-date", { q: "Board Game 3", date: "2030-01-03" });
  list("list.available", { view: "available" });
  list("list.empty", { q: "does-not-exist" });
  list("personal.hosted", { tab: "hosted" }, "dense");
  list("personal.joined", { tab: "joined" }, "dense");
  list("personal.waiting", { tab: "waiting" }, "dense");
  list("personal.sparse", { tab: "joined" }, "sparse");
  list("personal.available", { tab: "joined", view: "available" }, "dense");
  for (const [name, input, owner] of [
    ["schedule.first", {}, "dense"],
    ["schedule.last", { schedulePage: 100000 }, "dense"],
    ["schedule.today", { range: "today" }, "dense"],
    ["schedule.empty", {}, "empty"],
  ]) {
    const expected = expectedSchedule(fixtureRows, input, owner);
    scenarios.push({
      name,
      input,
      run: () => listMySchedule(input, actors[owner], benchmarkNow),
      verify: (value) => {
        const result = scheduleProjection(value);
        assert.deepEqual(result, expected);
        return result;
      },
    });
  }
  assert.ok(
    expectedSchedule(fixtureRows).items.some((item) => item.simultaneous),
    "Fixture must exercise simultaneous membership",
  );
  assert.ok(
    expectedSchedule(fixtureRows).nearest,
    "Fixture must exercise a nearest future reservation",
  );

  async function claimFixture(name, count, iteration, mode) {
    const prefix = `claim-${name}-${iteration}`;
    const guestToken = syntheticToken(prefix),
      sessionToken = syntheticToken(prefix + "-session");
    const user = await client.user.create({
      data: {
        username: prefix,
        nickname: "Synthetic member",
        passwordHash: "unused-benchmark-fixture",
      },
    });
    await client.userSession.create({
      data: {
        id: hashToken(sessionToken),
        userId: user.id,
        version: user.version,
        expiresAt: new Date("2100-01-01T00:00:00Z"),
      },
    });
    const guestHash = hashToken(guestToken),
      userHash = hashToken("user:" + user.identityKey);
    await client.guestIdentity.create({ data: { hash: guestHash } });
    const ids = seedClaimRows(
      fixtureDb,
      prefix,
      count,
      guestHash,
      userHash,
      mode === "tombstone",
    );
    const selected =
      mode === "partial" ? ids.slice(0, Math.ceil(count / 2)) : ids;
    const viewer = await resolveViewer(sessionToken, guestToken);
    assert.equal(viewer.mode, "user");
    const preview =
      mode === "preview"
        ? null
        : await viewerContext.run(viewer, () => previewGuestClaim(viewer));
    const input = preview
      ? { key: randomUUID(), fingerprint: preview.fingerprint, ids: selected }
      : null;
    return { prefix, user, viewer, ids, selected, guestHash, userHash, input };
  }
  async function cleanupClaim(fixture) {
    fixtureDb.exec("BEGIN");
    try {
      const remove = fixtureDb.prepare(
        "DELETE FROM GameReservation WHERE id=?",
      );
      for (const id of fixture.ids) remove.run(id);
      fixtureDb
        .prepare("DELETE FROM CreationRequest WHERE ownerTokenHash IN (?,?)")
        .run(fixture.guestHash, fixture.userHash);
      fixtureDb
        .prepare("DELETE FROM GuestIdentity WHERE hash=?")
        .run(fixture.guestHash);
      fixtureDb.exec("COMMIT");
    } catch (error) {
      fixtureDb.exec("ROLLBACK");
      throw error;
    }
    await client.user.delete({ where: { id: fixture.user.id } });
  }
  for (const count of [10, 100])
    for (const mode of ["preview", "full", "partial", "tombstone"]) {
      const name = `claim.${mode}.${count}`;
      scenarios.push({
        name,
        input: { records: count, mode },
        prepare: (iteration) => claimFixture(name, count, iteration, mode),
        cleanup: cleanupClaim,
        run: (fixture) =>
          viewerContext.run(fixture.viewer, () =>
            mode === "preview"
              ? previewGuestClaim(fixture.viewer)
              : claimGuestRecords(fixture.viewer, fixture.input),
          ),
        verify(result, fixture) {
          if (mode === "preview") {
            assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
            assert.deepEqual(
              result.items.map((item) => item.id),
              fixture.ids,
            );
            assert.ok(result.items.every((item) => item.conflict === null));
            assert.equal(
              result.items.filter((item) => !item.canOpen).length,
              Math.ceil(count / 10),
            );
            return {
              items: result.items.length,
              conflicts: 0,
              hidden: Math.ceil(count / 10),
            };
          }
          assert.deepEqual(result.ids, fixture.selected);
          assert.equal(result.retired, mode === "full");
          assert.equal(typeof result.fromStorage, "string");
          assert.equal(typeof result.toStorage, "string");
          assert.notEqual(result.fromStorage, result.toStorage);
          for (const [table, field, reservationKey] of [
            ["GameReservation", "hostTokenHash", "id"],
            ["Participant", "tokenHash", "reservationId"],
            ["RosterRemoval", "targetTokenHash", "reservationId"],
            ["ReservationAccess", "tokenHash", "reservationId"],
            ["CreationRequest", "ownerTokenHash", "reservationId"],
          ]) {
            const query = fixtureDb.prepare(
              `SELECT COUNT(*) AS total FROM "${table}" WHERE "${reservationKey}"=? AND "${field}"=?`,
            );
            for (const id of fixture.selected) {
              assert.equal(query.get(id, fixture.guestHash).total, 0);
              assert.equal(query.get(id, fixture.userHash).total, 1);
            }
          }
          const state = fixtureDb
            .prepare("SELECT retired FROM GuestIdentity WHERE hash=?")
            .get(fixture.guestHash);
          assert.equal(Boolean(state.retired), mode === "full");
          assert.equal(
            fixtureDb
              .prepare(
                "SELECT COUNT(*) AS total FROM GuestClaim WHERE userId=?",
              )
              .get(fixture.user.id).total,
            1,
          );
          const remaining = fixtureDb
            .prepare(
              "SELECT COUNT(*) AS total FROM CreationRequest WHERE ownerTokenHash=?",
            )
            .get(fixture.guestHash).total;
          assert.equal(
            remaining,
            mode === "full"
              ? 0
              : mode === "tombstone"
                ? 1
                : count - fixture.selected.length,
          );
          return {
            selected: fixture.selected.length,
            retired: result.retired,
            remainingCreationRecords: remaining,
            claims: 1,
          };
        },
      });
    }

  async function diagnostic(stats) {
    const control = stats.events.filter((event) =>
      /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i.test(
        event.query.trim(),
      ),
    );
    const statements = stats.events.filter((event) => !control.includes(event));
    const unique = new Map();
    for (const event of statements) {
      if (!/^SELECT\b/i.test(event.query.trim())) continue;
      const key = event.query.replace(/\s+/g, " ").trim();
      if (unique.has(key)) {
        unique.get(key).occurrences++;
        continue;
      }
      const parameters = JSON.parse(event.params);
      assert.ok(
        Array.isArray(parameters) &&
          parameters.every(
            (value) =>
              value === null ||
              ["string", "number", "boolean"].includes(typeof value),
          ),
        "Unexpected Prisma query parameter encoding",
      );
      // Replay only EXPLAIN of captured SELECTs, using bound synthetic parameters
      // and the same Prisma SQLite engine. Never replay writes or interpolate values.
      const plan = await client.$queryRawUnsafe(
        "EXPLAIN QUERY PLAN " + event.query,
        ...parameters,
      );
      unique.set(key, {
        sql: key,
        occurrences: 1,
        plan: plan.map((row) => ({
          id: Number(row.id),
          parent: Number(row.parent),
          detail: row.detail,
        })),
      });
    }
    return {
      transactions: stats.transactions,
      prismaDelegateCalls: stats.delegates,
      sqlStatements: statements.length,
      transactionControlStatements: control.length,
      selectStatements: stats.events.filter((e) =>
        /^SELECT\b/i.test(e.query.trim()),
      ).length,
      plans: [...unique.values()],
    };
  }
  const output = {};
  for (const scenario of scenarios) {
    const durations = [];
    let digest, detail;
    const iterations = phase === "timing" ? warmups + samples : 1;
    for (let i = 0; i < iterations; i++) {
      const fixture = await scenario.prepare?.(i);
      try {
        const stats = { transactions: 0, delegates: {}, events: [] };
        active = phase === "diagnostic" ? stats : undefined;
        const start = performance.now();
        const result = await withRequestBudget(() => scenario.run(fixture));
        const elapsed = performance.now() - start;
        if (phase === "diagnostic")
          await new Promise((resolve) => setImmediate(resolve));
        active = undefined;
        const normalized = scenario.verify(result, fixture);
        const currentDigest = createHash("sha256")
          .update(JSON.stringify(normalized))
          .digest("hex");
        if (digest)
          assert.equal(
            currentDigest,
            digest,
            `Unstable result: ${scenario.name}`,
          );
        digest = currentDigest;
        if (phase === "timing" && i >= warmups) durations.push(elapsed);
        if (phase === "diagnostic") {
          assert.equal(
            stats.transactions,
            1,
            `Expected one transaction: ${scenario.name}`,
          );
          assert.ok(
            stats.events.length,
            "SQL event capture must not silently be empty",
          );
          detail = await diagnostic(stats);
          if (
            scenario.name.startsWith("claim.") &&
            !scenario.name.startsWith("claim.preview.")
          ) {
            assert.equal(stats.delegates["gameReservation.findMany"], 1);
            assert.equal(stats.delegates["reservationAccess.findMany"] ?? 0, 0);
            assert.equal(
              stats.delegates["reservationAccess.findUnique"] ?? 0,
              0,
            );
          }
        }
      } finally {
        active = undefined;
        if (fixture) await scenario.cleanup(fixture);
      }
    }
    output[scenario.name] = {
      input: scenario.input,
      resultDigest: digest,
      ...(phase === "timing" ? timingSummary(durations) : detail),
    };
  }
  console.log(
    JSON.stringify({
      metadata: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        availableCpuThreads: availableParallelism(),
        prisma: Prisma.prismaVersion.client,
        sqlite,
        phase,
        rows,
        backgroundRows,
        fixedNow: benchmarkNow.toISOString(),
        fixture: "deterministic-v1",
        storage: "temporary file SQLite",
        schema: "versioned migration SQL applied only to the temporary file",
        migrations,
        warmups,
        samples: phase === "timing" ? samples : 1,
        connectionLimit: 1,
        logging: phase === "diagnostic",
        explain: phase === "diagnostic",
      },
      scenarios: output,
    }),
  );
} finally {
  if (client) await client.$disconnect();
  fixtureDb.close();
}
