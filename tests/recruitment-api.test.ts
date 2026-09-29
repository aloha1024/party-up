import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../server/db";
import { createReservation } from "../server/reservations";
import { resolveViewer } from "../server/user-identity";
import { createAdminSession } from "../server/admin-auth";
import { ensureAdminRecord } from "../server/admin";
import { identityFetch, registeredToken, testCookie } from "./support/member";
import type { Reservation, ReservationPage } from "../types/reservation";
import { historyPageSchema } from "../lib/reservation-history";

const base = process.env.TEST_BASE_URL;
test(
  "HTTP recruitment enforces scope, host, validation, versions and uncached closure responses",
  { skip: !base },
  async () => {
    const token = randomBytes(32).toString("hex"),
      other = randomBytes(32).toString("hex");
    const viewer = await resolveViewer(undefined, token);
    const r = await createReservation(
      {
        gameName: "HTTP recruitment",
        hostName: "Host",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        maxPlayers: 3,
      },
      token,
    );
    const send = (
      path: string,
      method: string,
      data: unknown,
      credential = token,
      scope = viewer.scope,
      origin = base!,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: "party_identity=" + credential,
          "X-Identity-Scope": scope,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
    const path = `/api/reservations/${r.id}/recruitment`;
    try {
      assert.equal(
        (
          await send(
            path,
            "PATCH",
            { paused: true, editVersion: 0 },
            token,
            viewer.scope,
            "https://other.test",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await send(
            path,
            "PATCH",
            { paused: true, editVersion: 0 },
            token,
            "stale",
          )
        ).status,
        409,
      );
      const stranger = await resolveViewer(undefined, other);
      assert.equal(
        (
          await send(
            path,
            "PATCH",
            { paused: true, editVersion: 0 },
            other,
            stranger.scope,
          )
        ).status,
        403,
      );
      assert.equal(
        (await send(path, "PATCH", { paused: "yes", editVersion: 0 })).status,
        400,
      );
      const response = await send(path, "PATCH", {
        paused: true,
        editVersion: 0,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).data.recruitmentPaused, true);
      assert.equal(
        (await send(path, "PATCH", { paused: false, editVersion: 0 })).status,
        409,
      );
      for (const endpoint of ["participants", "waitlist"]) {
        const closed = await send(
          `/api/reservations/${r.id}/${endpoint}`,
          "POST",
          { name: "Guest" },
          other,
          stranger.scope,
        );
        assert.equal(closed.status, 409);
        assert.equal((await closed.json()).code, "RECRUITMENT_CLOSED");
      }
      assert.equal(
        (await send(path, "PATCH", { paused: false, editVersion: 1 })).status,
        200,
      );
      await db.gameReservation.update({
        where: { id: r.id },
        data: { registrationDeadline: new Date(0), recruitmentPaused: true },
      });
      assert.equal(
        (await send(path, "PATCH", { paused: false, editVersion: 2 })).status,
        409,
      );
    } finally {
      await db.gameReservation.delete({ where: { id: r.id } });
      await db.$disconnect();
    }
  },
);

test(
  "HTTP deadline creation and edits preserve omitted values, clear null, and retain submission protection",
  { skip: !base },
  async () => {
    const token = randomBytes(32).toString("hex");
    const key = randomBytes(20).toString("hex");
    const ids: string[] = [];
    const input = {
      gameName: "HTTP cutoff compatibility",
      hostName: "Host",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      registrationDeadline: new Date(Date.now() + 3600000).toISOString(),
      maxPlayers: 3,
      description: "",
    };
    const send = (
      path: string,
      method: string,
      data: unknown,
      requestKey = key,
    ) =>
      identityFetch(base + path, {
        method,
        headers: {
          Origin: base!,
          Cookie: testCookie(token),
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: JSON.stringify(data),
      });
    try {
      const created = await send("/api/reservations", "POST", input);
      assert.equal(created.status, 200);
      const reservation = (await created.json()).data as Reservation;
      ids.push(reservation.id);
      assert.equal(
        reservation.registrationDeadline,
        input.registrationDeadline,
      );
      assert.equal(reservation.recruitmentPaused, false);
      const repeat = await send("/api/reservations", "POST", input);
      assert.equal(repeat.status, 200);
      assert.equal((await repeat.json()).data.id, reservation.id);
      assert.equal(
        (
          await send("/api/reservations", "POST", {
            ...input,
            registrationDeadline: null,
          })
        ).status,
        409,
      );
      for (const registrationDeadline of [
        new Date(0).toISOString(),
        new Date(Date.parse(input.scheduledAt) + 1).toISOString(),
        "invalid",
      ]) {
        assert.equal(
          (
            await send(
              "/api/reservations",
              "POST",
              { ...input, registrationDeadline },
              randomBytes(20).toString("hex"),
            )
          ).status,
          400,
        );
      }
      const path = `/api/reservations/${reservation.id}`;
      const edit = {
        gameName: input.gameName,
        hostName: input.hostName,
        scheduledAt: input.scheduledAt,
        maxPlayers: input.maxPlayers,
        description: "Unrelated edit",
        editVersion: reservation.editVersion,
      };
      const preserved = await send(path, "PATCH", edit);
      assert.equal(preserved.status, 200);
      const unchanged = (await preserved.json()).data as Reservation;
      assert.equal(unchanged.registrationDeadline, input.registrationDeadline);
      const cleared = await send(path, "PATCH", {
        ...edit,
        editVersion: unchanged.editVersion,
        registrationDeadline: null,
      });
      assert.equal(cleared.status, 200);
      assert.equal((await cleared.json()).data.registrationDeadline, null);
      assert.equal(cleared.headers.get("cache-control"), "no-store");

      const { registrationDeadline: _deadline, ...legacyInput } = input;
      const legacyKey = randomBytes(20).toString("hex");
      const legacy = await send(
        "/api/reservations",
        "POST",
        legacyInput,
        legacyKey,
      );
      assert.equal(legacy.status, 200);
      const legacyReservation = (await legacy.json()).data as Reservation;
      ids.push(legacyReservation.id);
      assert.equal(legacyReservation.registrationDeadline, null);
      const legacyRetry = await send(
        "/api/reservations",
        "POST",
        { ...legacyInput, registrationDeadline: null },
        legacyKey,
      );
      assert.equal(legacyRetry.status, 200);
      assert.equal((await legacyRetry.json()).data.id, legacyReservation.id);
    } finally {
      await db.creationRequest.deleteMany({
        where: { reservationId: { in: ids } },
      });
      await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
  },
);

test(
  "HTTP recruitment checks administrator enablement, password requirements and session versions on every request",
  { skip: !base },
  async () => {
    const owner = randomBytes(32).toString("hex");
    const visitor = randomBytes(32).toString("hex");
    const reservation = await createReservation(
      {
        gameName: "HTTP recruitment admin",
        hostName: "Host",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        maxPlayers: 3,
      },
      owner,
    );
    await ensureAdminRecord();
    const admin = await db.adminCredential.create({
      data: {
        username: "recruit_" + randomBytes(6).toString("hex"),
        passwordHash: "unused-test-password",
        mustChangePassword: false,
        isActive: true,
      },
    });
    const send = (paused: boolean, editVersion: number, sessionVersion = 0) =>
      identityFetch(`${base}/api/reservations/${reservation.id}/recruitment`, {
        method: "PATCH",
        headers: {
          Origin: base!,
          Cookie: `${testCookie(visitor)}; party_admin=${createAdminSession(admin.id, sessionVersion)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paused, editVersion }),
      });
    try {
      assert.equal((await send(true, 0)).status, 200);
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { sessionVersion: 1 },
      });
      assert.equal((await send(false, 1)).status, 403);
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { isActive: false },
      });
      assert.equal((await send(false, 1, 1)).status, 403);
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { isActive: true, mustChangePassword: true },
      });
      assert.equal((await send(false, 1, 1)).status, 403);
      const stillPaused = await db.gameReservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      assert.equal(stillPaused.recruitmentPaused, true);
      assert.equal(stillPaused.editVersion, 1);
      await db.adminCredential.update({
        where: { id: admin.id },
        data: { mustChangePassword: false },
      });
      assert.equal((await send(false, 1, 1)).status, 200);
      assert.deepEqual(
        (
          await db.adminAuditLog.findMany({
            where: { actorId: admin.id, targetId: reservation.id },
            orderBy: { createdAt: "asc" },
          })
        ).map((entry) => entry.action),
        ["RESERVATION_PAUSE", "RESERVATION_RESUME"],
      );
      const history = await fetch(
        `${base}/api/reservations/${reservation.id}/history`,
      );
      assert.equal(history.status, 200);
      const publicHistory = await history.text();
      assert.ok(!publicHistory.includes(admin.username));
      assert.deepEqual(
        historyPageSchema
          .parse(JSON.parse(publicHistory).data)
          .items.map((entry) => entry.actorRole),
        ["ADMIN", "ADMIN"],
      );
    } finally {
      await db.adminAuditLog.deleteMany({ where: { actorId: admin.id } });
      await db.gameReservation.delete({ where: { id: reservation.id } });
      await db.adminCredential.delete({ where: { id: admin.id } });
      await db.$disconnect();
    }
  },
);

test(
  "HTTP available filters before pagination, keeps closed public records in other views and hides invitations",
  { skip: !base },
  async () => {
    const owner = await registeredToken();
    const prefix = "RecruitmentList-" + randomBytes(6).toString("hex");
    const ids: string[] = [];
    const openIds: string[] = [];
    const user = await db.user.findUniqueOrThrow({
      where: { identityKey: owner.slice("user:".length) },
    });
    try {
      for (let i = 0; i < 7; i++) {
        const row = await createReservation(
          {
            gameName: prefix + "-" + i,
            hostName: "Host",
            maxPlayers: 3,
            scheduledAt: new Date(
              Date.now() + 86400000 + i * 60000,
            ).toISOString(),
            ...(i === 6 ? { visibility: "INVITE" } : {}),
          },
          owner,
        );
        ids.push(row.id);
        if ([0, 2, 5].includes(i)) openIds.push(row.id);
        if (i === 1 || i === 4)
          await db.gameReservation.update({
            where: { id: row.id },
            data: { recruitmentPaused: true },
          });
        if (i === 3 || i === 4)
          await db.gameReservation.update({
            where: { id: row.id },
            data: { registrationDeadline: new Date(0) },
          });
        if (i === 5)
          await db.gameReservation.update({
            where: { id: row.id },
            data: { registrationDeadline: new Date(Date.now() + 3600000) },
          });
      }
      const path = `/api/reservations?q=${encodeURIComponent(prefix)}`;
      for (const [page, expectedPage, expectedId] of [
        [1, 1, openIds[0]],
        [2, 2, openIds[1]],
        [999, 3, openIds[2]],
      ] as const) {
        const response = await fetch(
          `${base}${path}&view=available&pageSize=1&page=${page}`,
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const data = (await response.json()).data as ReservationPage;
        assert.equal(data.total, 3);
        assert.equal(data.page, expectedPage);
        assert.equal(data.pageCount, 3);
        assert.deepEqual(
          data.items.map((entry) => entry.id),
          [expectedId],
        );
        const item = data.items[0];
        assert.equal(item.recruitmentPaused, false);
        for (const privateField of [
          "participants",
          "waitlist",
          "hostTokenHash",
          "inviteTokenHash",
          "inviteTokenEncrypted",
        ])
          assert.ok(!(privateField in item));
      }
      for (const view of ["all", "upcoming"]) {
        const response = await fetch(`${base}${path}&view=${view}`);
        assert.equal(response.status, 200);
        const data = (await response.json()).data as ReservationPage;
        assert.equal(data.total, 6);
        assert.deepEqual(
          data.items.map((entry) => entry.id),
          ids.slice(0, 6),
        );
      }
      const inviteId = ids[6];
      assert.equal(
        (await fetch(`${base}/api/reservations/${inviteId}`)).status,
        404,
      );
      const own = await fetch(`${base}/api/reservations/${inviteId}`, {
        headers: { Cookie: testCookie(owner) },
      });
      assert.equal(own.status, 200);
      const pause = await identityFetch(
        `${base}/api/reservations/${inviteId}/recruitment`,
        {
          method: "PATCH",
          headers: {
            Origin: base!,
            Cookie: testCookie(owner),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ paused: true, editVersion: 0 }),
        },
      );
      assert.equal(pause.status, 200);
      assert.equal((await pause.json()).data.recruitmentPaused, true);
      assert.equal(
        (await fetch(`${base}${path}&view=available&view=all`)).status,
        400,
      );
    } finally {
      await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
