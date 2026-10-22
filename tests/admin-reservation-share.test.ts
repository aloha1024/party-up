import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { ensureAdminRecord } from "../server/admin";
import { createAdminSession } from "../server/admin-auth";
import {
  newInvitation,
  decryptInvitation,
} from "../server/invitation-credential";
import { adminReservationShare } from "../server/admin-reservation-share";
import {
  adminReservationShareSchema,
  adminReservationShareText,
} from "../lib/admin-reservation-share";

const require = createRequire(import.meta.url);
after(() => db.$disconnect());

test("admin sharing uses a fresh complete availability snapshot with current invitation links and no rosters", async (t) => {
  await ensureAdminRecord();
  const key = "share_" + randomUUID();
  const admin = await db.adminCredential.create({
    data: { username: key, passwordHash: "unused", mustChangePassword: false },
  });
  let cookie: string | undefined;
  t.mock.method(require("next/headers"), "cookies", async () => ({
    get: () => (cookie ? { value: cookie } : undefined),
  }));
  const now = new Date("2030-01-01T12:00:00Z");
  const future = new Date(now.getTime() + 3600000);
  const base = {
    gameName: key,
    hostName: "private-host",
    scheduledAt: future,
    maxPlayers: 2,
    description: "private-notes",
  };
  const invitation = newInvitation();
  try {
    await assert.rejects(adminReservationShare(now), { status: 401 });
    cookie = "forged";
    await assert.rejects(adminReservationShare(now), { status: 401 });
    cookie = createAdminSession(admin.id, admin.sessionVersion);
    const rows = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        db.gameReservation.create({
          data: { ...base, id: `${key}-${String(i).padStart(2, "0")}` },
        }),
      ),
    );
    const invited = await db.gameReservation.create({
      data: {
        ...base,
        id: `${key}-invite`,
        visibility: "INVITE",
        ...invitation,
      },
    });
    for (const data of [
      { deletedAt: now },
      { scheduledAt: now },
      { scheduledAt: new Date(now.getTime() - 1) },
      { status: "CANCELLED" },
      { status: "ENDED" },
      { recruitmentPaused: true },
      { registrationDeadline: now },
      { registrationDeadline: new Date(now.getTime() - 1) },
      {
        participants: {
          create: [0, 1].map((i) => ({
            name: `private-name-${i}`,
            nameKey: String(i),
            tokenHash: `private-token-${i}`,
          })),
        },
      },
    ])
      await db.gameReservation.create({ data: { ...base, ...data } });
    const first = adminReservationShareSchema
      .parse(await adminReservationShare(now))
      .items.filter((r) => r.gameName === key);
    assert.equal(first.length, 51);
    assert.deepEqual(
      first.slice(0, 50).map((r) => r.path),
      rows.map((r) => `/reservation/${r.id}`),
    );
    assert.equal(
      first.at(-1)!.path,
      `/reservation/${invited.id}#invite=${decryptInvitation(invitation.inviteCipher)}`,
    );
    assert.deepEqual(
      Object.keys(first[0]).sort(),
      [
        "gameName",
        "participantCount",
        "maxPlayers",
        "scheduledAt",
        "visibility",
        "path",
      ].sort(),
    );
    assert.equal(first[0].scheduledAt, future.toISOString());
    await db.participant.createMany({
      data: [0, 1].map((i) => ({
        reservationId: rows[0].id,
        name: `late-${i}`,
        nameKey: String(i),
        tokenHash: `late-${i}`,
      })),
    });
    await db.gameReservation.update({
      where: { id: rows[1].id },
      data: { deletedAt: now },
    });
    const rotated = newInvitation();
    await db.gameReservation.update({
      where: { id: invited.id },
      data: rotated,
    });
    const fresh = (await adminReservationShare(now)).items.filter(
      (r) => r.gameName === key,
    );
    assert.equal(fresh.length, 49);
    assert.equal(
      fresh.some((r) => r.path === `/reservation/${rows[0].id}`),
      false,
    );
    assert.equal(
      fresh.at(-1)!.path,
      `/reservation/${invited.id}#invite=${decryptInvitation(rotated.inviteCipher)}`,
    );
    assert.equal(
      (await adminReservationShare(future)).items.filter(
        (r) => r.gameName === key,
      ).length,
      0,
    );
    await db.adminCredential.update({
      where: { id: admin.id },
      data: { isActive: false },
    });
    await assert.rejects(adminReservationShare(now), { status: 401 });
  } finally {
    await db.gameReservation.deleteMany({ where: { gameName: key } });
    await db.adminCredential.delete({ where: { id: admin.id } });
  }
});

test("compact sharing uses three lines per game and an explicit Beijing date without extra details", () => {
  const text = adminReservationShareText(
    [
      {
        gameName: "  无畏契约\n  五排  ",
        participantCount: 2,
        maxPlayers: 5,
        scheduledAt: "2030-12-31T16:30:00Z",
        visibility: "PUBLIC",
        path: "/reservation/example",
      },
    ],
    "https://party.example",
  );
  assert.equal(
    text,
    "可报名接龙（北京时间）\n\n1. 无畏契约 五排\n2/5 人 · 2031/01/01 00:30\nhttps://party.example/reservation/example\n\n人数以接龙页面为准。",
  );
});
