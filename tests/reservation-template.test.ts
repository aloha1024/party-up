import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  createReservation,
  joinReservation,
  detail,
  hashToken,
} from "../server/reservations";
import { reservationTemplate } from "../server/reservation-template";
import { reservationTemplateSourceSchema } from "../lib/reservation-template";
import { listMyReservations } from "../server/reservation-list";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";

const ids: string[] = [];
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
async function fixture() {
  const owner = randomBytes(32).toString("hex");
  const input = {
    gameName: "Template-" + randomUUID(),
    hostName: "队长",
    maxPlayers: 2,
    description: "语音集合",
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const reservation = await createReservation(input, owner);
  ids.push(reservation.id);
  return { owner, input, reservation };
}

test("only the original browser can copy active, full, started or cancelled reservations without private fields", async () => {
  const { owner, input, reservation } = await fixture();
  const expected = {
    visibility: "PUBLIC",
    gameName: input.gameName,
    hostName: input.hostName,
    maxPlayers: input.maxPlayers,
    description: input.description,
  };
  assert.deepEqual(await reservationTemplate(reservation.id, owner), expected);
  for (const token of [undefined, "invalid", randomBytes(32).toString("hex")]) {
    await assert.rejects(reservationTemplate(reservation.id, token), {
      code: "FORBIDDEN",
    });
  }
  await joinReservation(
    reservation.id,
    { name: "队友" },
    randomBytes(32).toString("hex"),
  );
  assert.equal((await detail(reservation.id)).status, "FULL");
  assert.deepEqual(await reservationTemplate(reservation.id, owner), expected);
  await db.gameReservation.update({
    where: { id: reservation.id },
    data: { scheduledAt: new Date(0) },
  });
  assert.deepEqual(await reservationTemplate(reservation.id, owner), expected);
  await db.gameReservation.update({
    where: { id: reservation.id },
    data: { status: "CANCELLED" },
  });
  assert.deepEqual(await reservationTemplate(reservation.id, owner), expected);
  const before = await detail(reservation.id, owner);
  const created = await createReservation(
    { ...expected, scheduledAt: input.scheduledAt },
    owner,
  );
  ids.push(created.id);
  assert.notEqual(created.id, reservation.id);
  assert.equal(created.participants.length, 1);
  assert.equal(created.isHost, true);
  assert.deepEqual(await detail(reservation.id, owner), before);
  for (const tab of ["joined", "hosted"]) {
    assert.ok(
      (await listMyReservations({ tab }, owner)).items.some(
        (r) => r.id === created.id,
      ),
    );
  }
  await db.gameReservation.update({
    where: { id: reservation.id },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(reservationTemplate(reservation.id, owner), {
    code: "NOT_FOUND",
  });
  await assert.rejects(reservationTemplate(randomUUID(), owner), {
    code: "NOT_FOUND",
  });
  for (const source of [
    "",
    "../etc",
    "x".repeat(129),
    [reservation.id, reservation.id],
  ]) {
    assert.equal(
      reservationTemplateSourceSchema.safeParse(source).success,
      false,
    );
  }
});

test(
  "copy page enforces browser ownership even for administrators and validates source parameters",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!;
    const { owner, input, reservation } = await fixture();
    const admin = await db.adminCredential.create({
      data: {
        username: "copy-" + randomUUID(),
        passwordHash: process.env.ADMIN_PASSWORD_HASH!,
        mustChangePassword: false,
      },
    });
    try {
      const adminCookie = `${ADMIN_COOKIE}=${createAdminSession(admin.id, admin.sessionVersion)}`;
      assert.equal(
        (
          await fetch(base + "/api/admin/audit", {
            headers: { Cookie: adminCookie },
          })
        ).status,
        200,
      );
      for (const cookie of [
        "",
        "party_identity=invalid",
        `party_identity=${randomBytes(32).toString("hex")}`,
        adminCookie,
      ]) {
        const html = await (
          await fetch(`${base}/reservation/new?from=${reservation.id}`, {
            headers: { Cookie: cookie },
          })
        ).text();
        assert.ok(html.includes("只有原发起人可以再开一局"));
        assert.equal(html.includes(input.gameName), false);
      }
      const own = await (
        await fetch(`${base}/reservation/new?from=${reservation.id}`, {
          headers: { Cookie: `party_identity=${owner}` },
        })
      ).text();
      assert.ok(own.includes(input.gameName));
      assert.equal(own.includes(owner), false);
      assert.equal(own.includes(hashToken(owner)), false);
      for (const query of [
        "from=",
        "from=..%2Fx",
        `from=${reservation.id}&from=${reservation.id}`,
      ]) {
        const html = await (
          await fetch(`${base}/reservation/new?${query}`)
        ).text();
        assert.ok(html.includes("来源预约参数无效"));
      }
      const missing = await fetch(
        `${base}/reservation/new?from=${randomUUID()}`,
      );
      // Next can stream a not-found boundary with status 200; the noindex marker identifies it.
      assert.ok(
        missing.status === 404 ||
          (await missing.text()).includes('name="robots" content="noindex"'),
      );
    } finally {
      await db.adminCredential.delete({ where: { id: admin.id } });
    }
  },
);
