import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";

const base = process.env.TEST_BASE_URL;
const temporaryPassword = process.env.TEST_ADMIN_PASSWORD;

test(
  "admin HTTP: first login changes password, later change invalidates sessions, and deletion is protected",
  { skip: !base || !temporaryPassword },
  async () => {
    let reservationId: string | undefined;
    const auditPrefix = "audit-page-" + randomUUID();
    const original = await db.adminCredential.findMany();
    const send = async (
      path: string,
      method: string,
      data?: unknown,
      cookie = "",
    ) => {
      if (
        path.startsWith("/api/reservations") &&
        method !== "GET" &&
        !cookie.includes("party_identity=")
      ) {
        const identityResponse = await fetch(base + "/api/identity", {
          method: "POST",
          headers: { Origin: base! },
        });
        cookie = [
          cookie,
          identityResponse.headers.get("set-cookie")!.split(";")[0],
        ]
          .filter(Boolean)
          .join("; ");
      }
      return fetch(`${base}${path}`, {
        method,
        headers: {
          Origin: base!,
          Cookie: cookie,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
    };
    const passwordAfterFirstLogin = "first-login-password-123";
    const changedPassword = "changed-password-456";
    try {
      await db.adminCredential.deleteMany();
      assert.equal((await send("/api/admin/audit", "GET")).status, 401);
      assert.equal((await send("/api/admin/trash", "GET")).status, 401);
      assert.equal(
        (await send("/api/admin/trash?page=bad", "GET")).status,
        401,
      );
      const created = await send("/api/reservations", "POST", {
        gameName: "Admin deletion test",
        hostName: "Host",
        maxPlayers: 3,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      });
      assert.equal(created.status, 200);
      reservationId = (await created.json()).data.id;
      const deleteUrl = `/api/admin/reservations/${reservationId}`;
      assert.equal((await send(deleteUrl, "DELETE")).status, 401);
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, "party_admin=forged"))
          .status,
        401,
      );
      assert.equal(
        (
          await send("/api/admin/session", "POST", {
            username: "admin",
            password: "wrong",
          })
        ).status,
        401,
      );

      const firstLogin = await send("/api/admin/session", "POST", {
        username: "admin",
        password: temporaryPassword,
      });
      assert.equal(firstLogin.status, 200);
      assert.equal((await firstLogin.json()).data.requiresPasswordChange, true);
      assert.equal(firstLogin.headers.get("set-cookie"), null);

      const setup = await send("/api/admin/session", "POST", {
        username: "admin",
        password: temporaryPassword,
        newPassword: passwordAfterFirstLogin,
      });
      assert.equal(setup.status, 200);
      const firstCookieHeader = setup.headers.get("set-cookie")!;
      assert.match(firstCookieHeader, /HttpOnly/i);
      assert.match(firstCookieHeader, /SameSite=strict/i);
      const firstCookie = firstCookieHeader.split(";")[0];
      assert.equal(
        (
          await send("/api/admin/session", "POST", {
            username: "admin",
            password: temporaryPassword,
          })
        ).status,
        401,
      );

      assert.equal(
        (
          await send(
            "/api/admin/session",
            "PATCH",
            { currentPassword: "wrong", newPassword: changedPassword },
            firstCookie,
          )
        ).status,
        401,
      );
      const changed = await send(
        "/api/admin/session",
        "PATCH",
        {
          currentPassword: passwordAfterFirstLogin,
          newPassword: changedPassword,
        },
        firstCookie,
      );
      assert.equal(changed.status, 200);
      const currentCookie = changed.headers.get("set-cookie")!.split(";")[0];
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, firstCookie)).status,
        401,
      );

      const accountInput = {
        username: "test_moderator",
        password: "moderator-temporary-123",
      };
      assert.equal(
        (await send("/api/admin/accounts", "POST", accountInput)).status,
        401,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            { ...accountInput, id: 1 },
            currentCookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            { ...accountInput, password: "short" },
            currentCookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            { ...accountInput, username: "admin" },
            currentCookie,
          )
        ).status,
        409,
      );
      const accounts = await Promise.all([
        send("/api/admin/accounts", "POST", accountInput, currentCookie),
        send("/api/admin/accounts", "POST", accountInput, currentCookie),
      ]);
      assert.deepEqual(accounts.map((r) => r.status).sort(), [200, 409]);
      const account = (await accounts.find((r) => r.status === 200)!.json())
        .data;
      assert.ok(account.id > 1);
      assert.equal(account.mustChangePassword, true);
      assert.deepEqual(Object.keys(account).sort(), [
        "id",
        "mustChangePassword",
        "username",
      ]);
      const rootBefore = await db.adminCredential.findUniqueOrThrow({
        where: { id: 1 },
      });
      const firstModeratorLogin = await send(
        "/api/admin/session",
        "POST",
        accountInput,
      );
      assert.equal(firstModeratorLogin.status, 200);
      assert.equal(
        (await firstModeratorLogin.json()).data.requiresPasswordChange,
        true,
      );
      assert.equal(firstModeratorLogin.headers.get("set-cookie"), null);
      const moderatorLogin = await send("/api/admin/session", "POST", {
        ...accountInput,
        newPassword: "moderator-final-123",
      });
      assert.equal(moderatorLogin.status, 200);
      const moderatorCookie = moderatorLogin.headers
        .get("set-cookie")!
        .split(";")[0];
      assert.equal(
        (
          await send(
            "/api/admin/accounts",
            "POST",
            {
              username: "blocked_admin",
              password: "blocked-password-123",
              administrator: true,
              role: "ROOT",
            },
            moderatorCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        await db.adminCredential.count({
          where: { username: "blocked_admin" },
        }),
        0,
      );
      const moderatorPage = await send(
        "/admin",
        "GET",
        undefined,
        moderatorCookie,
      );
      const moderatorHtml = await moderatorPage.text();
      assert.equal(moderatorHtml.includes('href="/admin/accounts"'), false);
      assert.equal(moderatorHtml.includes('href="/admin/password"'), true);
      const forbiddenPage = await fetch(base + "/admin/accounts", {
        headers: { Cookie: moderatorCookie },
        redirect: "manual",
      });
      const forbiddenHtml = await forbiddenPage.text();
      assert.ok(
        forbiddenPage.status === 307 || forbiddenHtml.includes("NEXT_REDIRECT"),
      );
      assert.equal(forbiddenHtml.includes('name="username"'), false);
      const moderatorChanged = await send(
        "/api/admin/session",
        "PATCH",
        {
          currentPassword: "moderator-final-123",
          newPassword: "moderator-changed-456",
          adminId: 1,
        },
        moderatorCookie,
      );
      assert.equal(moderatorChanged.status, 200);
      const moderatorCurrentCookie = moderatorChanged.headers
        .get("set-cookie")!
        .split(";")[0];
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, moderatorCookie)).status,
        401,
      );
      const rootAfter = await db.adminCredential.findUniqueOrThrow({
        where: { id: 1 },
      });
      assert.equal(rootAfter.passwordHash, rootBefore.passwordHash);
      assert.equal(rootAfter.sessionVersion, rootBefore.sessionVersion);

      const accountUrl = "/api/admin/accounts/" + account.id;
      assert.equal(
        (await send(accountUrl, "PATCH", { action: "disable" })).status,
        401,
      );
      assert.equal(
        (
          await send(
            accountUrl,
            "PATCH",
            { action: "disable" },
            moderatorCurrentCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await send(
            "/api/admin/accounts/1",
            "PATCH",
            { action: "disable" },
            currentCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await send(
            accountUrl,
            "PATCH",
            { action: "disable", isActive: true },
            currentCookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (await send(accountUrl, "PATCH", { action: "disable" }, currentCookie))
          .status,
        200,
      );
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, moderatorCurrentCookie))
          .status,
        401,
      );
      assert.equal(
        (
          await send("/api/admin/session", "POST", {
            username: accountInput.username,
            password: "moderator-changed-456",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await send(
            accountUrl,
            "PATCH",
            { action: "resetPassword", password: "short" },
            currentCookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await send(
            accountUrl,
            "PATCH",
            { action: "resetPassword", password: "reset-temporary-789" },
            currentCookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await send(
            "/api/admin/audit",
            "GET",
            undefined,
            moderatorCurrentCookie,
          )
        ).status,
        401,
      );
      const resetAccount = await db.adminCredential.findUniqueOrThrow({
        where: { id: account.id },
      });
      assert.equal(resetAccount.isActive, false);
      assert.equal(resetAccount.mustChangePassword, true);
      assert.equal(
        (await send(accountUrl, "PATCH", { action: "enable" }, currentCookie))
          .status,
        200,
      );
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, moderatorCurrentCookie))
          .status,
        401,
      );
      const resetLogin = await send("/api/admin/session", "POST", {
        username: accountInput.username,
        password: "reset-temporary-789",
      });
      assert.equal(resetLogin.status, 200);
      assert.equal((await resetLogin.json()).data.requiresPasswordChange, true);
      assert.equal(resetLogin.headers.get("set-cookie"), null);
      const resetComplete = await send("/api/admin/session", "POST", {
        username: accountInput.username,
        password: "reset-temporary-789",
        newPassword: "reset-final-password-123",
      });
      assert.equal(resetComplete.status, 200);
      const enabledCookie = resetComplete.headers
        .get("set-cookie")!
        .split(";")[0];
      const editUrl = `/api/reservations/${reservationId}`;
      const changes = {
        gameName: "Admin edited",
        editVersion: 0,
        hostName: "Updated host",
        maxPlayers: 4,
        description: "Updated by admin",
        scheduledAt: new Date(Date.now() + 7200000).toISOString(),
      };
      assert.equal(
        (await send(editUrl, "PATCH", { ...changes, administrator: true }))
          .status,
        403,
      );
      assert.equal(
        (await send(editUrl, "PATCH", changes, currentCookie)).status,
        200,
      );
      const staleEdit = await send(
        editUrl,
        "PATCH",
        { ...changes, description: "stale overwrite" },
        enabledCookie,
      );
      assert.equal(staleEdit.status, 409);
      assert.equal((await staleEdit.json()).code, "EDIT_CONFLICT");
      const latestEdit = (await (await send(editUrl, "GET")).json()).data;
      assert.equal(latestEdit.editVersion, 1);
      assert.equal(latestEdit.description, changes.description);
      const { editVersion: ignoredVersion, ...missingVersion } = changes;
      assert.equal(
        (await send(editUrl, "PATCH", missingVersion, currentCookie)).status,
        400,
      );
      assert.equal(
        (
          await send(
            editUrl,
            "PATCH",
            { ...changes, editVersion: 1, actorId: 999, actorName: "forged" },
            enabledCookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, enabledCookie)).status,
        200,
      );
      assert.equal(await db.participant.count({ where: { reservationId } }), 1);
      assert.equal(
        (await send(`/api/reservations/${reservationId}`, "GET")).status,
        404,
      );

      const trashListingUrl = "/api/admin/trash?q=" + reservationId;
      assert.equal(
        (await send(trashListingUrl, "GET", undefined, moderatorCurrentCookie))
          .status,
        401,
      );
      const trashListingResponse = await send(
        trashListingUrl + "&page=99&pageSize=1",
        "GET",
        undefined,
        enabledCookie,
      );
      assert.equal(trashListingResponse.status, 200);
      assert.equal(
        trashListingResponse.headers.get("cache-control"),
        "no-store",
      );
      const trashListing = (await trashListingResponse.json()).data;
      assert.deepEqual(
        [trashListing.total, trashListing.page, trashListing.items.length],
        [1, 1, 1],
      );
      assert.equal(trashListing.items[0].id, reservationId);
      assert.equal(trashListing.items[0].participantCount, 1);
      assert.deepEqual(Object.keys(trashListing.items[0]).sort(), [
        "deletedAt",
        "gameName",
        "hostName",
        "id",
        "participantCount",
      ]);
      for (const query of [
        "pageSize=49",
        "date=2030-02-30",
        "page=1&page=2",
        "q=a&q=b",
      ]) {
        assert.equal(
          (
            await send(
              "/api/admin/trash?" + query,
              "GET",
              undefined,
              enabledCookie,
            )
          ).status,
          400,
        );
      }
      const trashPage = await send(
        "/admin/trash?q=" + reservationId,
        "GET",
        undefined,
        enabledCookie,
      );
      assert.equal(trashPage.status, 200);
      assert.match(await trashPage.text(), /移入日期（北京时间）/);
      const invalidTrashPage = await send(
        "/admin/trash?page=bad",
        "GET",
        undefined,
        enabledCookie,
      );
      assert.match(await invalidTrashPage.text(), /筛选条件无效/);
      const trashUrl = "/api/admin/trash/" + reservationId;
      assert.equal((await send(trashUrl, "POST")).status, 401);
      assert.equal((await send(trashUrl, "DELETE")).status, 401);
      assert.equal(
        (await send(trashUrl, "POST", undefined, enabledCookie)).status,
        200,
      );
      assert.equal((await send(editUrl, "GET")).status, 200);
      assert.equal(
        (
          await (
            await send(trashListingUrl, "GET", undefined, enabledCookie)
          ).json()
        ).data.total,
        0,
      );
      assert.equal(
        (await send(trashUrl, "DELETE", undefined, enabledCookie)).status,
        409,
      );
      assert.equal(
        (
          await send(
            editUrl + "/cancel",
            "POST",
            { reason: "管理员取消" },
            enabledCookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, enabledCookie)).status,
        200,
      );
      assert.equal(
        (await send(trashUrl, "POST", undefined, enabledCookie)).status,
        200,
      );
      assert.equal(
        (await (await send(editUrl, "GET")).json()).data.status,
        "CANCELLED",
      );
      assert.equal(
        (await send(deleteUrl, "DELETE", undefined, enabledCookie)).status,
        200,
      );
      assert.equal(
        (await send(trashUrl, "DELETE", undefined, enabledCookie)).status,
        200,
      );
      assert.equal(await db.participant.count({ where: { reservationId } }), 0);
      const rootFinal = await db.adminCredential.findUniqueOrThrow({
        where: { id: 1 },
      });
      assert.equal(rootFinal.passwordHash, rootBefore.passwordHash);
      assert.equal(rootFinal.sessionVersion, rootBefore.sessionVersion);
      const auditResponse = await send(
        "/api/admin/audit?q=" + reservationId,
        "GET",
        undefined,
        enabledCookie,
      );
      assert.equal(auditResponse.status, 200);
      assert.equal(auditResponse.headers.get("cache-control"), "no-store");
      const auditPage = (await auditResponse.json()).data;
      assert.equal(auditPage.total, 9);
      assert.equal(
        auditPage.items.filter(
          (row: { action: string }) => row.action === "RESERVATION_PURGE",
        ).length,
        1,
      );
      assert.ok(
        auditPage.items.every(
          (row: { actorId: number; actorName: string }) =>
            [1, account.id].includes(row.actorId) && row.actorName !== "forged",
        ),
      );
      const logText = JSON.stringify(auditPage);
      for (const value of [
        changes.description,
        temporaryPassword!,
        "reset-temporary-789",
        rootFinal.passwordHash,
        process.env.ADMIN_SESSION_SECRET!,
      ])
        assert.equal(logText.includes(value), false);
      const resetLogs = (
        await (
          await send(
            "/api/admin/audit?action=ADMIN_RESET_PASSWORD&q=" +
              accountInput.username,
            "GET",
            undefined,
            currentCookie,
          )
        ).json()
      ).data;
      assert.equal(resetLogs.total, 1);
      assert.equal(resetLogs.items[0].actorId, 1);
      assert.equal(resetLogs.items[0].targetId, String(account.id));
      assert.equal(
        (
          await send(
            "/api/admin/audit?page=1&page=2",
            "GET",
            undefined,
            currentCookie,
          )
        ).status,
        400,
      );
      const auditHtml = await (
        await send("/admin/audit", "GET", undefined, enabledCookie)
      ).text();
      assert.ok(auditHtml.includes('aria-label="筛选操作记录"'));
      assert.ok(auditHtml.includes("操作记录"));
      const pageIds = Array.from(
        { length: 23 },
        (_, i) => auditPrefix + String(i).padStart(2, "0"),
      );
      await db.adminAuditLog.createMany({
        data: pageIds.map((id) => ({
          id,
          actorId: 1,
          actorName: "admin",
          action: "ADMIN_ENABLE",
          targetType: "admin",
          targetId: auditPrefix,
          targetLabel: auditPrefix,
          createdAt: new Date("2026-01-01"),
        })),
      });
      const page1 = (
        await (
          await send(
            "/api/admin/audit?q=" + auditPrefix,
            "GET",
            undefined,
            currentCookie,
          )
        ).json()
      ).data;
      const page2 = (
        await (
          await send(
            "/api/admin/audit?q=" + auditPrefix + "&page=2",
            "GET",
            undefined,
            currentCookie,
          )
        ).json()
      ).data;
      assert.equal(page1.total, 23);
      assert.deepEqual(
        [...page1.items, ...page2.items].map((row: { id: string }) => row.id),
        [...pageIds].reverse(),
      );

      // Simulate unavailable audit storage for this account only; the password and session must stay unchanged.
      const trigger = "audit_account_fail_" + randomUUID().replaceAll("-", "");
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON AdminAuditLog WHEN NEW.action = 'ADMIN_CHANGE_PASSWORD' AND NEW.targetId = '1' BEGIN SELECT RAISE(ABORT, 'simulated audit storage failure'); END`,
      );
      try {
        const failedChange = await send(
          "/api/admin/session",
          "PATCH",
          {
            currentPassword: changedPassword,
            newPassword: "must-not-be-saved-123",
          },
          currentCookie,
        );
        assert.equal(failedChange.status, 503);
        assert.equal(failedChange.headers.get("set-cookie"), null);
        const unchanged = await db.adminCredential.findUniqueOrThrow({
          where: { id: 1 },
        });
        assert.equal(unchanged.passwordHash, rootFinal.passwordHash);
        assert.equal(unchanged.sessionVersion, rootFinal.sessionVersion);
      } finally {
        await db.$executeRawUnsafe("DROP TRIGGER " + trigger);
      }
      const logout = await send(
        "/api/admin/session",
        "DELETE",
        undefined,
        currentCookie,
      );
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/i);
    } finally {
      await db.adminAuditLog.deleteMany({ where: { targetId: auditPrefix } });
      if (reservationId)
        await db.gameReservation.deleteMany({ where: { id: reservationId } });
      await db.adminCredential.deleteMany();
      if (original.length)
        await db.adminCredential.createMany({ data: original });
      await db.$disconnect();
    }
  },
);
