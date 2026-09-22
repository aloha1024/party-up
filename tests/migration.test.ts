import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
test("upgrade retains reservations, roster, root and moderator credentials with safe defaults", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort();
    for (const name of migrations.slice(0, -1))
      db.exec(
        readFileSync("prisma/migrations/" + name + "/migration.sql", "utf8"),
      );
    db.exec(`
      INSERT INTO GameReservation(id, gameName, hostName, scheduledAt, maxPlayers, updatedAt, hostTokenHash)
        VALUES ('r1', 'Game', 'Host', '2027-01-01', 3, CURRENT_TIMESTAMP, 'owner-token-hash');
      INSERT INTO Participant(id, reservationId, name, nameKey, tokenHash) VALUES ('p1', 'r1', 'Host', 'host', 'token-hash');
      INSERT INTO AdminCredential(id, username, passwordHash, mustChangePassword, sessionVersion, updatedAt)
        VALUES (1, 'admin', 'root-hash', 0, 7, CURRENT_TIMESTAMP), (2, 'moderator', 'mod-hash', 1, 3, CURRENT_TIMESTAMP);
    `);
    const before = db.prepare("SELECT * FROM GameReservation").get()!;
    const roster = db.prepare("SELECT * FROM Participant").all();
    const accounts = db
      .prepare("SELECT * FROM AdminCredential ORDER BY id")
      .all();
    db.exec(
      readFileSync(
        "prisma/migrations/" + migrations.at(-1) + "/migration.sql",
        "utf8",
      ),
    );
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM GameReservation").get()! },
      { ...before, deletedAt: null, cancellationReason: "" },
    );
    assert.deepEqual(db.prepare("SELECT * FROM Participant").all(), roster);
    assert.deepEqual(
      db
        .prepare("SELECT * FROM AdminCredential ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      accounts.map((row) => ({ ...row, isActive: 1 })),
    );
  } finally {
    db.close();
  }
});
