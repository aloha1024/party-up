import { createHash } from "node:crypto";

export const benchmarkNow = new Date("2030-01-02T04:00:00.000Z");
const day = 86400000;
export const syntheticToken = (value) =>
  createHash("sha256")
    .update("benchmark-fixture:" + value)
    .digest("hex");
export const hashToken = (value) =>
  createHash("sha256").update(value).digest("hex");
export const actors = {
  dense: syntheticToken("dense"),
  sparse: syntheticToken("sparse"),
  empty: syntheticToken("empty"),
};

export function seedReservations(database, count) {
  const insert = database.prepare(
    "INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,status,visibility,updatedAt,deletedAt,registrationDeadline,recruitmentPaused) VALUES(?,?,?,?,?,4,?,?,?,?,?,?)",
  );
  const participant = database.prepare(
    "INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash,checkedInAt) VALUES(?,?,?,?,?,?)",
  );
  const waiter = database.prepare(
    "INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash) VALUES(?,?,?,?)",
  );
  const rows = [];
  database.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const row = {
        id: "bench-" + String(i).padStart(6, "0"),
        gameName: "Board Game " + (i % 10),
        hostName: "Host " + (i % 13),
        owner:
          i % 8 === 1 ? "dense" : i % 503 === 1 ? "sparse" : "other-host-" + i,
        scheduledAt:
          benchmarkNow.getTime() +
          ((i % 21) - 7) * day +
          (Math.floor(i / 21) % 4) * 3600000,
        maxPlayers: 4,
        status: i % 19 === 0 ? "CANCELLED" : i % 23 === 0 ? "ENDED" : "OPEN",
        visibility: i % 7 === 0 ? "INVITE" : "PUBLIC",
        deletedAt: i % 17 === 0 ? benchmarkNow.getTime() - day : null,
        registrationDeadline:
          i % 11 === 0
            ? Math.min(
                benchmarkNow.getTime(),
                benchmarkNow.getTime() + ((i % 21) - 7) * day,
              )
            : null,
        recruitmentPaused: i % 13 === 0,
        participants: [],
        waiters: [],
      };
      const identity = (owner) =>
        hashToken(actors[owner] ?? syntheticToken(owner));
      insert.run(
        row.id,
        row.gameName,
        row.hostName,
        identity(row.owner),
        row.scheduledAt,
        row.status,
        row.visibility,
        benchmarkNow.getTime(),
        row.deletedAt,
        row.registrationDeadline,
        Number(row.recruitmentPaused),
      );
      for (let j = 0; j < i % 5; j++) {
        const owner =
          j === 0 && i % 8 === 0
            ? "dense"
            : j === 0 && i % 503 === 0
              ? "sparse"
              : `other-participant-${i}-${j}`;
        const checkedInAt = i % 3 === 0 ? benchmarkNow.getTime() - 1000 : null;
        row.participants.push({ owner, checkedInAt });
        participant.run(
          `${row.id}-p${j}`,
          row.id,
          "Player " + j,
          "player " + j,
          identity(owner),
          checkedInAt,
        );
      }
      if (row.participants.length === 4) {
        for (let j = 0; j < i % 3; j++) {
          const owner =
            j === 0 && i % 8 === 2
              ? "dense"
              : j === 0 && i % 503 === 2
                ? "sparse"
                : `other-waiter-${i}-${j}`;
          row.waiters.push(owner);
          waiter.run(row.id, "Waiter " + j, "waiter " + j, identity(owner));
        }
      }
      rows.push(row);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return rows;
}

function summary(row) {
  return {
    id: row.id,
    visibility: row.visibility,
    gameName: row.gameName,
    hostName: row.hostName,
    scheduledAt: new Date(row.scheduledAt).toISOString(),
    registrationDeadline:
      row.registrationDeadline === null
        ? null
        : new Date(row.registrationDeadline).toISOString(),
    recruitmentPaused: row.recruitmentPaused,
    maxPlayers: row.maxPlayers,
    participantCount: row.participants.length,
    status: ["CANCELLED", "ENDED"].includes(row.status)
      ? row.status
      : row.scheduledAt <= benchmarkNow.getTime()
        ? "STARTED"
        : row.participants.length >= row.maxPlayers
          ? "FULL"
          : "OPEN",
  };
}
const byTime = (a, b) =>
  a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id);
const joined = (row, owner) => row.participants.some((p) => p.owner === owner);

// Independent fixture oracle: no application query builders or serializers.
export function expectedList(rows, input = {}, owner) {
  const view = input.view ?? "all",
    pageSize = input.pageSize ?? 12;
  const matching = rows.filter((r) => {
    if (r.deletedAt !== null || (!owner && r.visibility !== "PUBLIC"))
      return false;
    if (
      owner &&
      !(input.tab === "hosted"
        ? r.owner === owner
        : input.tab === "waiting"
          ? r.waiters.includes(owner)
          : joined(r, owner))
    )
      return false;
    if (
      input.q &&
      !`${r.gameName}\n${r.hostName}`
        .toLowerCase()
        .includes(input.q.toLowerCase())
    )
      return false;
    if (
      input.date &&
      new Date(r.scheduledAt + 8 * 3600000).toISOString().slice(0, 10) !==
        input.date
    )
      return false;
    const active = !["CANCELLED", "ENDED"].includes(r.status),
      future = r.scheduledAt > benchmarkNow.getTime();
    if (view === "upcoming" && !(future && active)) return false;
    if (view === "started" && !(!future && active)) return false;
    if (
      view === "available" &&
      !(
        future &&
        active &&
        !r.recruitmentPaused &&
        (r.registrationDeadline === null ||
          r.registrationDeadline > benchmarkNow.getTime()) &&
        r.participants.length < r.maxPlayers
      )
    )
      return false;
    if (view === "cancelled" && r.status !== "CANCELLED") return false;
    if (view === "ended" && r.status !== "ENDED") return false;
    return true;
  });
  matching.sort(
    (a, b) =>
      Number(b.scheduledAt > benchmarkNow.getTime()) -
        Number(a.scheduledAt > benchmarkNow.getTime()) || byTime(a, b),
  );
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.min(input.page ?? 1, pageCount);
  return {
    items: matching.slice((page - 1) * pageSize, page * pageSize).map(summary),
    total: matching.length,
    page,
    pageSize,
    pageCount,
  };
}

export function expectedSchedule(rows, input = {}, owner = "dense") {
  const start = Date.parse("2030-01-02T00:00:00+08:00");
  const end = start + (input.range === "today" ? 1 : 7) * day;
  const base = rows.filter(
    (r) =>
      r.deletedAt === null && r.scheduledAt >= start && r.scheduledAt < end,
  );
  const all = base
    .filter(
      (r) => r.owner === owner || joined(r, owner) || r.waiters.includes(owner),
    )
    .sort(byTime);
  const active = base.filter(
    (r) => joined(r, owner) && !["CANCELLED", "ENDED"].includes(r.status),
  );
  const nearest = active
    .filter((r) => r.scheduledAt > benchmarkNow.getTime())
    .sort(byTime)[0];
  const pageCount = Math.max(1, Math.ceil(all.length / 12)),
    page = Math.min(input.schedulePage ?? 1, pageCount);
  return {
    total: all.length,
    page,
    pageCount,
    nearest: nearest ? summary(nearest) : null,
    items: all.slice((page - 1) * 12, page * 12).map((r) => {
      const me = r.participants.find((p) => p.owner === owner),
        closed = ["CANCELLED", "ENDED"].includes(r.status);
      return {
        ...summary(r),
        isHost: r.owner === owner,
        isParticipant: !!me,
        isWaiting: r.waiters.includes(owner),
        checkedInAt: me?.checkedInAt
          ? new Date(me.checkedInAt).toISOString()
          : null,
        attendance: !me
          ? null
          : closed
            ? "closed"
            : me.checkedInAt
              ? "confirmed"
              : benchmarkNow.getTime() >= r.scheduledAt - 30 * 60000
                ? "ready"
                : "waiting",
        simultaneous:
          !!me &&
          !closed &&
          active.filter((other) => other.scheduledAt === r.scheduledAt).length >
            1,
      };
    }),
  };
}

// Only synthetic records are inserted. Account/session creation stays in Prisma
// so current client defaults (including public session IDs) remain effective.
export function seedClaimRows(
  database,
  prefix,
  count,
  guestHash,
  userHash,
  tombstone,
) {
  const reservation = database.prepare(
    "INSERT INTO GameReservation(id,gameName,hostName,hostTokenHash,scheduledAt,maxPlayers,status,visibility,updatedAt,deletedAt) VALUES(?,?,?, ?,?,8,'OPEN','INVITE',?,?)",
  );
  const participant = database.prepare(
    "INSERT INTO Participant(id,reservationId,name,nameKey,tokenHash) VALUES(?,?,?,?,?)",
  );
  const wait = database.prepare(
    "INSERT INTO WaitlistEntry(reservationId,name,nameKey,tokenHash) VALUES(?,?,?,?)",
  );
  const access = database.prepare(
    "INSERT INTO ReservationAccess(reservationId,tokenHash,inviteVersion,hasJoined) VALUES(?,?,1,0)",
  );
  const removal = database.prepare(
    "INSERT INTO RosterRemoval(reservationId,kind,entryId,targetTokenHash,targetName,reason,actorRole) VALUES(?,'participants',?,?,'Guest','Synthetic fixture','HOST')",
  );
  const creation = database.prepare(
    "INSERT INTO CreationRequest(id,ownerTokenHash,key,inputHash,reservationId) VALUES(?,?,?,?,?)",
  );
  const ids = [];
  database.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-r${String(i).padStart(3, "0")}`;
      ids.push(id);
      reservation.run(
        id,
        "Claim " + i,
        "Guest",
        guestHash,
        Date.parse("2100-01-01T00:00:00Z"),
        benchmarkNow.getTime(),
        i % 10 === 0 ? benchmarkNow.getTime() : null,
      );
      participant.run(id + "-p", id, "Guest", "guest", guestHash);
      participant.run(id + "-other", id, "Other", "other", syntheticToken(id));
      wait.run(
        id,
        "Other waiter",
        "other waiter",
        syntheticToken(id + "waiter"),
      );
      access.run(id, guestHash);
      if (i % 2 === 0) access.run(id, userHash);
      removal.run(id, id + "removed", guestHash);
      creation.run(
        id + "-creation",
        guestHash,
        id + "-key",
        syntheticToken(id + "input"),
        id,
      );
    }
    if (tombstone)
      creation.run(
        prefix + "-deleted-request",
        guestHash,
        prefix + "-deleted-key",
        syntheticToken(prefix),
        prefix + "-deleted-reservation",
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return ids;
}
