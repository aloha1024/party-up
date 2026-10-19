import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  detail,
  editReservation,
  joinReservation,
  joinWaitlist,
} from "../server/reservations";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
import { ensureAdminRecord } from "../server/admin";
import { registeredToken, testCookie } from "./support/member";
import { digest, resolveViewer } from "../server/user-identity";

const base = process.env.TEST_BASE_URL,
  ids: string[] = [],
  users: string[] = [];
const token = () => randomBytes(32).toString("hex");
async function scope(cookie: string) {
  return (
    await (
      await fetch(base + "/api/identity", { headers: { Cookie: cookie } })
    ).json()
  ).data.scope as string;
}
async function send(
  id: string,
  body: unknown,
  cookie: string,
  extra: Record<string, string> = {},
  suffix = "schedule-confirmation",
) {
  return fetch(`${base}/api/reservations/${id}/${suffix}`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      Origin: base!,
      "Content-Type": "application/json",
      "X-Identity-Scope": await scope(cookie),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
async function fixture() {
  const owner = token(),
    member = token(),
    outsider = token();
  const input = {
    gameName: "Confirmation HTTP-" + randomUUID(),
    hostName: "Host",
    maxPlayers: 2,
    scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const r = await createReservation(input, owner);
  ids.push(r.id);
  await joinReservation(r.id, { name: "Member", scheduleVersion: 0 }, member);
  const moved = await editReservation(
    r.id,
    {
      ...input,
      scheduledAt: new Date(Date.now() + 7200000).toISOString(),
      editVersion: 0,
    },
    owner,
  );
  const p = (await detail(r.id, member)).participants.find((p) => p.isMe)!;
  return {
    r: moved,
    owner,
    member,
    outsider,
    request: { participantId: p.id, scheduleVersion: moved.scheduleVersion },
  };
}
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test(
  "HTTP reschedule confirmation validates identity scope, origin, exact payload, membership and administrator non-delegation",
  { skip: !base },
  async () => {
    const f = await fixture(),
      memberCookie = testCookie(f.member);
    await ensureAdminRecord();
    const admin = await db.adminCredential.create({
      data: {
        username: "schedule-" + randomUUID(),
        passwordHash: "unused",
        mustChangePassword: false,
      },
    });
    const adminCookie = `${ADMIN_COOKIE}=${createAdminSession(admin.id, admin.sessionVersion)}`;
    try {
      assert.equal(
        (
          await send(f.r.id, f.request, memberCookie, {
            Origin: "https://elsewhere.test",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await send(f.r.id, f.request, memberCookie, {
            "X-Identity-Scope": "old-scope",
          })
        ).status,
        409,
      );
      assert.equal((await send(f.r.id, f.request, "")).status, 428);
      assert.equal(
        (await send(f.r.id, f.request, "party_user=invalid")).status,
        401,
      );
      for (const body of [
        {},
        { ...f.request, participantId: "" },
        { ...f.request, scheduleVersion: -1 },
        { ...f.request, scheduleVersion: 0.5 },
        { ...f.request, scheduleVersion: "1" },
        { ...f.request, scheduleVersion: Number.MAX_SAFE_INTEGER + 1 },
        { ...f.request, token: f.member },
        { ...f.request, checkedIn: true },
      ])
        assert.equal((await send(f.r.id, body, memberCookie)).status, 400);
      for (const cookie of [
        testCookie(f.owner),
        `${testCookie(f.outsider)}; ${adminCookie}`,
      ]) {
        const result = await send(f.r.id, f.request, cookie);
        assert.equal(result.status, 409);
        assert.equal((await result.json()).code, "ROSTER_CHANGED");
      }
      await joinWaitlist(
        f.r.id,
        { name: "Waiter", scheduleVersion: f.r.scheduleVersion },
        f.outsider,
      );
      assert.equal(
        (await send(f.r.id, f.request, testCookie(f.outsider))).status,
        409,
      );
      const stale = await send(
        f.r.id,
        { ...f.request, scheduleVersion: 0 },
        memberCookie,
      );
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "SCHEDULE_CONFLICT");
      const response = await send(f.r.id, f.request, memberCookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json(),
        mine = result.data.participants.find((p: { isMe: boolean }) => p.isMe);
      assert.equal(mine.scheduleConfirmed, true);
      assert.ok(mine.scheduleConfirmedAt);
      const stored = JSON.stringify(result);
      for (const secret of [
        f.member,
        digest(f.member),
        "tokenHash",
        "acceptedScheduleVersion",
      ])
        assert.equal(stored.includes(secret), false);
      const repeated = await send(f.r.id, f.request, memberCookie);
      assert.equal(repeated.status, 200);
      assert.equal(
        (await repeated.json()).data.participants.find(
          (p: { isMe: boolean }) => p.isMe,
        ).scheduleConfirmedAt,
        mine.scheduleConfirmedAt,
      );
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { sessionVersion: 1 },
      });
      assert.equal(
        (
          await send(
            f.r.id,
            f.request,
            `${testCookie(f.outsider)}; ${adminCookie}`,
          )
        ).status,
        409,
      );
    } finally {
      await db.adminCredential.delete({ where: { id: admin.id } });
    }
  },
);

test(
  "HTTP reschedule confirmation uses the existing shared enrollment quota and rejects revoked normal accounts",
  { skip: !base },
  async () => {
    const f = await fixture(),
      limitedCookie = testCookie(token());
    for (let i = 0; i < 29; i++)
      assert.equal((await send(f.r.id, f.request, limitedCookie)).status, 409);
    const attendance = await send(
      f.r.id,
      {
        participantId: f.request.participantId,
        attendanceVersion: 0,
        editVersion: f.r.editVersion,
        checkedIn: true,
      },
      limitedCookie,
      {},
      "attendance",
    );
    assert.equal(attendance.status, 409);
    assert.equal((await send(f.r.id, f.request, limitedCookie)).status, 429);
    const accountToken = await registeredToken(),
      cookie = testCookie(accountToken),
      viewer = await resolveViewer(cookie.split("=")[1]);
    users.push(viewer.user!.id);
    const r = await createReservation(
      {
        gameName: "Session guard",
        hostName: "Member",
        maxPlayers: 2,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      },
      accountToken,
    );
    ids.push(r.id);
    const request = { participantId: r.participants[0].id, scheduleVersion: 0 };
    await db.userSession.delete({ where: { id: viewer.sessionHash! } });
    assert.equal((await send(r.id, request, cookie)).status, 401);
  },
);
