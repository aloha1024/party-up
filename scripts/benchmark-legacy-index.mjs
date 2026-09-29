import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

export function applyBenchmarkSchema(database, omitted) {
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const names = readdirSync(directory)
    .filter((name) => /^\d/.test(name) && name !== omitted)
    .sort();
  for (const name of names)
    database.exec(
      readFileSync(new URL(`${name}/migration.sql`, directory), "utf8"),
    );
  return names;
}

export function timingSummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3));
  return {
    samples: sorted.length,
    meanMs: Number(
      (sorted.reduce((sum, n) => sum + n, 0) / sorted.length).toFixed(3),
    ),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}

export function legacyIndexBenchmark({ rows, warmups, samples }) {
  const database = new DatabaseSync(":memory:");
  const indexMigration = "20260922000400_query_indexes";
  try {
    applyBenchmarkSchema(database, indexMigration);
    const insert = database.prepare(
      "INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt,deletedAt) VALUES(?,?,?,?,3,0,?)",
    );
    const audit = database.prepare(
      "INSERT INTO AdminAuditLog(id,actorId,actorName,action,targetType,targetId,targetLabel,createdAt) VALUES(?,1,'admin','RESERVATION_EDIT','reservation',?,'Game',?)",
    );
    database.exec("BEGIN");
    for (let i = 0; i < rows; i++) {
      const id = String(i).padStart(6, "0");
      insert.run(id, "Game " + i, "Host", i % 100, i % 3 === 0 ? i % 20 : null);
      audit.run(id, id, i % 100);
    }
    database.exec("COMMIT");
    const queries = {
      upcoming:
        "SELECT id,gameName FROM GameReservation WHERE deletedAt IS NULL AND scheduledAt>50 ORDER BY scheduledAt ASC,id ASC LIMIT 12 OFFSET 1000",
      trash:
        "SELECT id,gameName FROM GameReservation WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC,id ASC LIMIT 12 OFFSET 1000",
      audit:
        "SELECT id,actorName FROM AdminAuditLog WHERE action='RESERVATION_EDIT' ORDER BY createdAt DESC,id DESC LIMIT 20 OFFSET 1000",
    };
    function measure() {
      return Object.fromEntries(
        Object.entries(queries).map(([name, sql]) => {
          const query = database.prepare(sql);
          for (let i = 0; i < warmups; i++) query.all();
          const durations = [];
          for (let i = 0; i < samples; i++) {
            const start = performance.now();
            query.all();
            durations.push(performance.now() - start);
          }
          return [
            name,
            {
              ...timingSummary(durations),
              plan: database
                .prepare("EXPLAIN QUERY PLAN " + sql)
                .all()
                .map((r) => r.detail),
              ids: query.all().map((r) => r.id),
            },
          ];
        }),
      );
    }
    const before = measure();
    database.exec(
      readFileSync(
        new URL(
          `../prisma/migrations/${indexMigration}/migration.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const after = measure();
    for (const name of Object.keys(queries)) {
      assert.deepEqual(before[name].ids, after[name].ids);
      delete before[name].ids;
      delete after[name].ids;
    }
    return {
      rows,
      storage: "in-memory synthetic SQLite",
      sqlite: database.prepare("SELECT sqlite_version() AS version").get()
        .version,
      indexMigration,
      before,
      after,
    };
  } finally {
    database.close();
  }
}
