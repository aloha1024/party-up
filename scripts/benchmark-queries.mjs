import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const database = new DatabaseSync(":memory:");
const indexMigration = "20260922000400_query_indexes";
try {
  for (const name of readdirSync("prisma/migrations")
    .filter((n) => /^\d/.test(n) && n !== indexMigration)
    .sort())
    database.exec(
      readFileSync("prisma/migrations/" + name + "/migration.sql", "utf8"),
    );
  const insert = database.prepare(
    "INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt,deletedAt) VALUES(?,?,?,?,3,0,?)",
  );
  const audit = database.prepare(
    "INSERT INTO AdminAuditLog(id,actorId,actorName,action,targetType,targetId,targetLabel,createdAt) VALUES(?,1,'admin','RESERVATION_EDIT','reservation',?,'Game',?)",
  );
  database.exec("BEGIN");
  for (let i = 0; i < 50000; i++) {
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
    const results = {};
    for (const [name, sql] of Object.entries(queries)) {
      const query = database.prepare(sql);
      for (let i = 0; i < 10; i++) query.all();
      const start = performance.now();
      for (let i = 0; i < 100; i++) query.all();
      results[name] = {
        meanMs: Number(((performance.now() - start) / 100).toFixed(3)),
        plan: database
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all()
          .map((r) => r.detail),
        ids: query.all().map((r) => r.id),
      };
    }
    return results;
  }
  const before = measure();
  database.exec(
    readFileSync(
      "prisma/migrations/" + indexMigration + "/migration.sql",
      "utf8",
    ),
  );
  const after = measure();
  for (const name of Object.keys(queries)) {
    if (JSON.stringify(before[name].ids) !== JSON.stringify(after[name].ids))
      throw new Error("Query result changed");
    delete before[name].ids;
    delete after[name].ids;
  }
  console.log(
    JSON.stringify(
      {
        rows: 50000,
        iterations: 100,
        storage: "in-memory synthetic SQLite",
        before,
        after,
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
