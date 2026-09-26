import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
test("roster management migration preserves all existing data and removes private history only on purge", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migration = "20260926000300_roster_management";
    for (const name of readdirSync("prisma/migrations")
      .filter((n) => /^\d/.test(n) && n < migration)
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt) VALUES ('r','Game','Host',2000000000000,2,CURRENT_TIMESTAMP);
      INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash) VALUES ('p','r','Host','host','h');
      INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash) VALUES ('r','Waiter','waiter','w');
      INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId) VALUES ('c','h','key','input','r');
      INSERT INTO AdminCredential(id,username,passwordHash,updatedAt) VALUES (1,'admin','hash',CURRENT_TIMESTAMP);
      INSERT INTO AdminAuditLog(id,actorId,actorName,action,targetType,targetId,targetLabel) VALUES ('a',1,'admin','RESERVATION_EDIT','reservation','r','Game');
      INSERT INTO ReservationChange(reservationId,action,actorRole,fields) VALUES ('r','EDIT','HOST','["description"]');`);
    const tables = [
      "GameReservation",
      "Participant",
      "WaitlistEntry",
      "CreationRequest",
      "AdminCredential",
      "AdminAuditLog",
      "ReservationChange",
    ];
    const before = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    db.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
    assert.deepEqual(
      tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all()),
      before,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM RosterRemoval").get()!.n,
      0,
    );
    const insert = db.prepare(
      "INSERT INTO RosterRemoval(reservationId,kind,entryId,targetTokenHash,targetName,reason,actorRole) VALUES ('r','participants','old','oldhash','Old','Reason','HOST')",
    );
    insert.run();
    assert.throws(() => insert.run());
    db.exec(
      "UPDATE GameReservation SET deletedAt=CURRENT_TIMESTAMP WHERE id='r'",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM RosterRemoval").get()!.n,
      1,
    );
    db.exec("DELETE FROM GameReservation WHERE id='r'");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM RosterRemoval").get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});
test("history migration preserves every existing table and cascades only on permanent deletion", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migration = "20260926000200_reservation_history";
    for (const name of readdirSync("prisma/migrations")
      .filter((n) => /^\d/.test(n) && n < migration)
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt) VALUES ('history','Game','Host',2000000000000,2,CURRENT_TIMESTAMP);
      INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash) VALUES ('p','history','Host','host','h');
      INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash) VALUES ('history','Waiter','waiter','w');
      INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId) VALUES ('c','h','key','input','history');
      INSERT INTO AdminCredential(id,username,passwordHash,updatedAt) VALUES (1,'admin','hash',CURRENT_TIMESTAMP);
      INSERT INTO AdminAuditLog(id,actorId,actorName,action,targetType,targetId,targetLabel) VALUES ('a',1,'admin','RESERVATION_EDIT','RESERVATION','history','Game');`);
    const tables = [
      "GameReservation",
      "Participant",
      "WaitlistEntry",
      "CreationRequest",
      "AdminCredential",
      "AdminAuditLog",
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    db.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
    assert.deepEqual(
      tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM ReservationChange").get()!.n,
      0,
    );
    db.exec(`INSERT INTO ReservationChange(reservationId,action,actorRole,fields) VALUES ('history','EDIT','HOST','["description"]');
      UPDATE GameReservation SET deletedAt=CURRENT_TIMESTAMP WHERE id='history';`);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM ReservationChange").get()!.n,
      1,
    );
    db.exec("DELETE FROM GameReservation WHERE id='history'");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM ReservationChange").get()!.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM AdminAuditLog").get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});
test("upgrade retains reservations, roster, root and moderator credentials with safe defaults", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort();
    const lifecycleIndex = migrations.indexOf(
      "20260921000100_admin_lifecycle_and_recycle_bin",
    );
    for (const name of migrations.slice(0, lifecycleIndex))
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
    for (const name of migrations.slice(lifecycleIndex))
      db.exec(
        readFileSync("prisma/migrations/" + name + "/migration.sql", "utf8"),
      );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM AdminAuditLog").get()!.count,
      0,
    );
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM GameReservation").get()! },
      {
        ...before,
        deletedAt: null,
        cancellationReason: "",
        editVersion: 0,
        endedAt: null,
        visibility: "PUBLIC",
        inviteVersion: 1,
        inviteHash: null,
        inviteCipher: null,
      },
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM Participant")
        .all()
        .map((r) => ({ ...r })),
      roster.map((r) => ({ ...r, checkedInAt: null, attendanceVersion: 0 })),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM WaitlistEntry").get()!.count,
      0,
    );
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

test("waitlist migration preserves creation submissions and enforces uniqueness, FIFO ids and cascade", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort();
    const latest = "20260926000100_waitlist";
    for (const name of migrations.filter((name) => name < latest))
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`INSERT INTO GameReservation (id, gameName, hostName, scheduledAt, maxPlayers, updatedAt) VALUES ('r', 'Game', 'Host', 2000000000000, 2, CURRENT_TIMESTAMP);
      INSERT INTO CreationRequest (id, ownerTokenHash, key, inputHash, reservationId) VALUES ('c', 'owner', 'key', 'input', 'r');`);
    const before = db.prepare("SELECT * FROM CreationRequest").all();
    db.exec(readFileSync(`prisma/migrations/${latest}/migration.sql`, "utf8"));
    assert.deepEqual(db.prepare("SELECT * FROM CreationRequest").all(), before);
    const insert = db.prepare(
      "INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash) VALUES ('r',?,?,?)",
    );
    const first = insert.run("A", "a", "one").lastInsertRowid;
    assert.throws(() => insert.run("A", "a", "two"));
    assert.throws(() => insert.run("B", "b", "one"));
    db.prepare("DELETE FROM WaitlistEntry WHERE id=?").run(first);
    assert.ok(insert.run("B", "b", "two").lastInsertRowid > first);
    db.exec("DELETE FROM GameReservation WHERE id='r'");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM WaitlistEntry").get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("invitation migration preserves all existing tables and defaults old reservations to public", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = readdirSync("prisma/migrations")
      .filter((name) => /^\d/.test(name))
      .sort();
    for (const name of names.filter(
      (name) => name < "20260926000400_invitations",
    ))
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt) VALUES ('old','Game','Host',2000000000000,2,CURRENT_TIMESTAMP);
  INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId) VALUES ('request','owner','key','hash','old');
  INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash) VALUES ('old','Waiter','waiter','waiter');
  INSERT INTO ReservationChange(reservationId,action,actorRole,fields) VALUES ('old','EDIT','HOST','[]');
  INSERT INTO RosterRemoval(reservationId,kind,entryId,targetTokenHash,targetName,reason,actorRole) VALUES ('old','participants','gone','gone','Gone','Reason','HOST');`);
    const tables = [
      "CreationRequest",
      "Participant",
      "WaitlistEntry",
      "ReservationChange",
      "RosterRemoval",
      "AdminCredential",
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM "${table}"`).all(),
    );
    db.exec(
      readFileSync(
        "prisma/migrations/20260926000400_invitations/migration.sql",
        "utf8",
      ),
    );
    assert.equal(
      db.prepare("SELECT visibility FROM GameReservation").get()!.visibility,
      "PUBLIC",
    );
    for (let i = 0; i < tables.length; i++)
      assert.deepEqual(
        db.prepare(`SELECT * FROM "${tables[i]}"`).all(),
        before[i],
      );
    db.exec(
      "INSERT INTO ReservationAccess(reservationId,tokenHash,inviteVersion) VALUES ('old','one',1)",
    );
    assert.throws(() =>
      db.exec(
        "INSERT INTO ReservationAccess(reservationId,tokenHash,inviteVersion) VALUES ('old','one',2)",
      ),
    );
    db.exec("DELETE FROM GameReservation");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM ReservationAccess").get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("attendance migration preserves rows and gives old members safe defaults", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync("prisma/migrations")
      .filter(
        (name) =>
          /^\d/.test(name) && name < "20260926000500_attendance_completion",
      )
      .sort())
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
    db.exec(`INSERT INTO GameReservation(id,gameName,hostName,scheduledAt,maxPlayers,updatedAt,visibility) VALUES ('r','Game','Host',2000000000000,2,CURRENT_TIMESTAMP,'INVITE');
  INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash) VALUES ('p','r','Host','host','host');
  INSERT INTO ReservationAccess(reservationId,tokenHash,inviteVersion,hasJoined) VALUES ('r','host',1,1);`);
    const old = db.prepare("SELECT * FROM Participant").get()!,
      reservation = db.prepare("SELECT * FROM GameReservation").get()!,
      grants = db.prepare("SELECT * FROM ReservationAccess").all();
    db.exec(
      readFileSync(
        "prisma/migrations/20260926000500_attendance_completion/migration.sql",
        "utf8",
      ),
    );
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM Participant").get()! },
      { ...old, checkedInAt: null, attendanceVersion: 0 },
    );
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM GameReservation").get()! },
      { ...reservation, endedAt: null },
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ReservationAccess").all(),
      grants,
    );
  } finally {
    db.close();
  }
});
