import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { digest } from "../server/user-identity";
import { registeredToken, testCookie } from "./support/member";
import { listReservationConflicts } from "../server/reservation-conflicts";
import {
  reservationConflictsInputSchema,
  reservationConflictsSchema,
  reservationConflictsSearchParams,
} from "../lib/reservation-conflicts";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";

const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const adminIds: number[] = [];
const scheduledAt = "2030-01-01T12:00:00.000Z";
async function seed(
  identity: string,
  options: {
    id?: string;
    formal?: boolean;
    host?: boolean;
    waiting?: boolean;
    invite?: boolean;
    grant?: boolean;
    status?: string;
    deleted?: boolean;
    time?: string;
  } = {},
) {
  const id = options.id ?? randomUUID();
  ids.push(id);
  return db.gameReservation.create({
    data: {
      id,
      gameName: "Conflict-" + id,
      hostName: "Host",
      maxPlayers: 2,
      description: "Private description must not escape",
      meetingCipher: "not-selected",
      scheduledAt: new Date(options.time ?? scheduledAt),
      hostTokenHash: options.host ? digest(identity) : digest(token()),
      status: options.status ?? "OPEN",
      deletedAt: options.deleted ? new Date() : null,
      visibility: options.invite ? "INVITE" : "PUBLIC",
      participants: options.formal
        ? {
            create: {
              name: "Member",
              nameKey: "member",
              tokenHash: digest(identity),
            },
          }
        : undefined,
      waitlist: options.waiting
        ? {
            create: {
              name: "Waiter",
              nameKey: "waiter",
              tokenHash: digest(identity),
            },
          }
        : undefined,
      access: options.grant
        ? { create: { tokenHash: digest(identity), inviteVersion: 1 } }
        : undefined,
    },
  });
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.adminCredential.deleteMany({ where: { id: { in: adminIds } } });
  await db.$disconnect();
});

test("conflict query includes only exact-time current formal memberships across public and invitation reservations", async () => {
  const viewer = token();
  const publicParty = await seed(viewer, { formal: true });
  const privateParty = await seed(viewer, { formal: true, invite: true });
  for (const options of [
    { host: true },
    { waiting: true },
    { invite: true, grant: true },
    { formal: true, status: "CANCELLED" },
    { formal: true, status: "ENDED" },
    { formal: true, deleted: true },
    { formal: true, time: "2030-01-01T12:00:00.001Z" },
  ])
    await seed(viewer, options);
  await seed(token(), { formal: true });
  const result = await listReservationConflicts(viewer, { scheduledAt });
  assert.deepEqual(
    new Set(result.items.map((r) => r.id)),
    new Set([publicParty.id, privateParty.id]),
  );
  assert.equal(result.hasMore, false);
  assert.deepEqual(reservationConflictsSchema.parse(result), result);
  for (const row of result.items)
    assert.deepEqual(Object.keys(row).sort(), [
      "gameName",
      "id",
      "scheduledAt",
    ]);
  assert.equal(JSON.stringify(result).includes("Private description"), false);
  assert.equal(JSON.stringify(result).includes(digest(viewer)), false);
  assert.deepEqual(
    await listReservationConflicts(viewer, {
      scheduledAt: "2030-01-01T20:00:00+08:00",
    }),
    result,
  );
  const excluded = await listReservationConflicts(viewer, {
    scheduledAt,
    exclude: privateParty.id,
  });
  assert.deepEqual(
    excluded.items.map((r) => r.id),
    [publicParty.id],
  );
  assert.deepEqual(await listReservationConflicts(token(), { scheduledAt }), {
    items: [],
    hasMore: false,
  });
  await db.participant.deleteMany({
    where: { reservationId: privateParty.id, tokenHash: digest(viewer) },
  });
  assert.deepEqual(
    (await listReservationConflicts(viewer, { scheduledAt })).items.map(
      (r) => r.id,
    ),
    [publicParty.id],
  );
});

test("conflict results have a deterministic five-item bound and a sixth-row hasMore signal", async () => {
  const viewer = await registeredToken(),
    prefix = randomUUID();
  const expected: string[] = [];
  for (let i = 0; i < 7; i++) {
    const row = await seed(viewer, { id: `${prefix}-${i}`, formal: true });
    expected.push(row.id);
  }
  const result = await listReservationConflicts(viewer, { scheduledAt });
  assert.deepEqual(
    result.items.map((r) => r.id),
    expected.slice(0, 5),
  );
  assert.equal(result.hasMore, true);
  await db.participant.deleteMany({
    where: { reservationId: { in: expected.slice(5) } },
  });
  const last = await listReservationConflicts(viewer, { scheduledAt });
  assert.equal(last.items.length, 5);
  assert.equal(last.hasMore, false);
});

test("anonymous conflict checks are empty and input parsing rejects duplicate or malformed query parameters", async () => {
  const count = await db.guestIdentity.count();
  for (const viewer of [undefined, "", "invalid"])
    assert.deepEqual(await listReservationConflicts(viewer, { scheduledAt }), {
      items: [],
      hasMore: false,
    });
  assert.equal(await db.guestIdentity.count(), count);
  for (const input of [
    {},
    { scheduledAt: "tomorrow" },
    { scheduledAt: "2030-01-01T12:00" },
    { scheduledAt, exclude: "../private" },
    { scheduledAt, exclude: "" },
    { scheduledAt, exclude: "x".repeat(129) },
    { scheduledAt, token: token() },
  ])
    assert.equal(
      reservationConflictsInputSchema.safeParse(input).success,
      false,
    );
  const valid = new URLSearchParams({ scheduledAt, exclude: "party_1-2" });
  assert.deepEqual(reservationConflictsSearchParams(valid), {
    scheduledAt,
    exclude: "party_1-2",
  });
  for (const query of [
    new URLSearchParams([
      ["scheduledAt", scheduledAt],
      ["scheduledAt", scheduledAt],
    ]),
    new URLSearchParams([
      ["scheduledAt", scheduledAt],
      ["exclude", "first"],
      ["exclude", "second"],
    ]),
    new URLSearchParams({ scheduledAt, admin: "true" }),
  ])
    assert.throws(() => reservationConflictsSearchParams(query));
});

test(
  "conflict HTTP query uses only the active identity without guest fallback or administrator scope expansion",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!,
      member = await registeredToken(),
      guest = token();
    const owned = await seed(member, { formal: true, invite: true });
    await seed(guest, { formal: true });
    const admin = await db.adminCredential.create({
      data: {
        username: "conflict-" + randomUUID(),
        passwordHash: "unused",
        mustChangePassword: false,
      },
    });
    adminIds.push(admin.id);
    const adminCookie = `${ADMIN_COOKIE}=${createAdminSession(admin.id, admin.sessionVersion)}`;
    const path = `${base}/api/reservations/conflicts?${new URLSearchParams({ scheduledAt })}`;
    const combined = `${testCookie(member)}; ${testCookie(guest)}; ${adminCookie}`;
    const result = await fetch(path, { headers: { Cookie: combined } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("set-cookie"), null);
    assert.deepEqual((await result.json()).data, {
      items: [{ id: owned.id, gameName: owned.gameName, scheduledAt }],
      hasMore: false,
    });
    for (const cookie of [
      adminCookie,
      "",
      `party_user=${token()}; ${testCookie(guest)}`,
    ]) {
      const empty = await fetch(path, { headers: { Cookie: cookie } });
      assert.deepEqual((await empty.json()).data, {
        items: [],
        hasMore: false,
      });
      assert.equal(empty.headers.get("set-cookie"), null);
    }
    for (const query of [
      "",
      "scheduledAt=bad",
      `${new URLSearchParams({ scheduledAt })}&scheduledAt=other`,
      `${new URLSearchParams({ scheduledAt })}&exclude=a&exclude=b`,
      `${new URLSearchParams({ scheduledAt })}&exclude=..%2Fa`,
    ])
      assert.equal(
        (
          await fetch(`${base}/api/reservations/conflicts?${query}`, {
            headers: { Cookie: combined },
          })
        ).status,
        400,
      );
  },
);
