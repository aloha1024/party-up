import "./support/isolated";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../server/db";
import { registeredToken, testCookie } from "./support/member";
import { resolveViewer, type Viewer } from "../server/user-identity";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
import {
  createSavedTemplate,
  deleteSavedTemplate,
  getSavedTemplate,
  listSavedTemplates,
  updateSavedTemplate,
} from "../server/saved-templates";

const users: string[] = [];
const input = () => ({
  name: "周末组局",
  visibility: "PUBLIC" as const,
  gameName: "Saved-" + randomUUID(),
  hostName: "模板队长",
  maxPlayers: 4,
  description: "语音集合",
});
async function account() {
  const token = await registeredToken();
  const cookie = testCookie(token);
  const viewer = await resolveViewer(cookie.split("=")[1]);
  users.push(viewer.user!.id);
  return { cookie, viewer };
}
after(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function rejectsSession(viewer: Viewer, id: string) {
  for (const action of [
    () => listSavedTemplates(viewer),
    () => getSavedTemplate(viewer, id),
    () => createSavedTemplate(viewer, input()),
    () => updateSavedTemplate(viewer, id, { ...input(), version: 0 }),
    () => deleteSavedTemplate(viewer, id, { version: 0 }),
  ])
    await assert.rejects(action, { code: "USER_SESSION" });
}

test("saved templates expose only reusable configuration and belong to one ordinary account", async () => {
  const owner = await account();
  const other = await account();
  const data = input();
  assert.deepEqual(await listSavedTemplates(owner.viewer), {
    items: [],
    max: 20,
  });
  const created = await createSavedTemplate(owner.viewer, data);
  assert.match(created.id, /^c[a-z0-9]{24}$/);
  assert.equal(created.version, 0);
  for (const value of [created.createdAt, created.updatedAt])
    assert.equal(new Date(value).toISOString(), value);
  assert.deepEqual(created, {
    ...data,
    platform: "",
    gameServer: "",
    id: created.id,
    version: 0,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });
  assert.equal(JSON.stringify(created).includes(owner.viewer.user!.id), false);
  assert.deepEqual(await getSavedTemplate(owner.viewer, created.id), created);
  assert.deepEqual(await listSavedTemplates(owner.viewer), {
    items: [created],
    max: 20,
  });
  assert.deepEqual(await listSavedTemplates(other.viewer), {
    items: [],
    max: 20,
  });
  for (const action of [
    () => getSavedTemplate(other.viewer, created.id),
    () =>
      updateSavedTemplate(other.viewer, created.id, { ...data, version: 0 }),
    () => deleteSavedTemplate(other.viewer, created.id, { version: 0 }),
  ])
    await assert.rejects(action, { code: "NOT_FOUND" });
  for (const viewer of [
    await resolveViewer(),
    await resolveViewer(undefined, randomBytes(32).toString("hex")),
    await resolveViewer("invalid"),
  ])
    await rejectsSession(viewer, created.id);
  assert.deepEqual(await getSavedTemplate(owner.viewer, created.id), created);
});

test("saved templates strictly reject dates, private fields, invalid configuration and invalid versions", async () => {
  const { viewer } = await account();
  const data = input();
  const privateFields = {
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    registrationDeadline: null,
    date: "2030-01-01",
    time: "20:00",
    participants: [],
    invitationKey: "private-invitation",
    roomName: "private-room",
    roomPassword: "private-password",
    voice: "https://voice.example.test/private",
    userId: viewer.user!.id,
  };
  for (const [key, value] of Object.entries(privateFields))
    await assert.rejects(
      createSavedTemplate(viewer, { ...data, [key]: value }),
      {
        name: "ZodError",
      },
    );
  for (const invalid of [
    { name: " " },
    { name: "名".repeat(41) },
    { visibility: "SECRET" },
    { gameName: "" },
    { gameName: "游".repeat(81) },
    { hostName: "队".repeat(25) },
    { maxPlayers: 1 },
    { maxPlayers: 101 },
    { maxPlayers: 2.5 },
    { description: "备".repeat(1001) },
    { platform: "平".repeat(81) },
    { gameServer: "服".repeat(81) },
  ])
    await assert.rejects(createSavedTemplate(viewer, { ...data, ...invalid }), {
      name: "ZodError",
    });
  assert.equal((await listSavedTemplates(viewer)).items.length, 0);
  const created = await createSavedTemplate(viewer, {
    ...data,
    name: "名".repeat(40),
    visibility: "INVITE",
    platform: "PC",
    gameServer: "亚洲区",
  });
  for (const [key, value] of Object.entries(privateFields))
    await assert.rejects(
      updateSavedTemplate(viewer, created.id, {
        ...data,
        version: 0,
        [key]: value,
      }),
      { name: "ZodError" },
    );
  for (const version of [undefined, -1, 0.5, "0"])
    for (const action of [
      () => updateSavedTemplate(viewer, created.id, { ...data, version }),
      () => deleteSavedTemplate(viewer, created.id, { version }),
    ])
      await assert.rejects(action, { name: "ZodError" });
  assert.deepEqual(await getSavedTemplate(viewer, created.id), created);
});

test("concurrent template edits have one winner and stale versions cannot overwrite or delete it", async () => {
  const { viewer } = await account();
  const data = input();
  const created = await createSavedTemplate(viewer, data);
  const results = await Promise.allSettled(
    ["周五", "周六"].map((name) =>
      updateSavedTemplate(viewer, created.id, { ...data, name, version: 0 }),
    ),
  );
  const winners = results.filter((result) => result.status === "fulfilled");
  const failures = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.code, "TEMPLATE_CONFLICT");
  const current = await getSavedTemplate(viewer, created.id);
  assert.deepEqual(current, winners[0].value);
  assert.equal(current.version, 1);
  assert.equal(current.createdAt, created.createdAt);
  for (const action of [
    () => updateSavedTemplate(viewer, created.id, { ...data, version: 0 }),
    () => deleteSavedTemplate(viewer, created.id, { version: 0 }),
  ])
    await assert.rejects(action, { code: "TEMPLATE_CONFLICT" });
  assert.deepEqual(await getSavedTemplate(viewer, created.id), current);
  await deleteSavedTemplate(viewer, created.id, { version: current.version });
  await assert.rejects(getSavedTemplate(viewer, created.id), {
    code: "NOT_FOUND",
  });
  assert.equal((await listSavedTemplates(viewer)).items.length, 0);
});

test("concurrent creates cannot exceed twenty templates and deletion releases capacity", async () => {
  const { viewer } = await account();
  for (let i = 0; i < 19; i++)
    await createSavedTemplate(viewer, { ...input(), name: `模板 ${i}` });
  const results = await Promise.allSettled(
    ["最后位置 A", "最后位置 B"].map((name) =>
      createSavedTemplate(viewer, { ...input(), name }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failures = results.filter((result) => result.status === "rejected");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.code, "TEMPLATE_LIMIT");
  const full = await listSavedTemplates(viewer);
  assert.equal(full.items.length, 20);
  assert.equal(full.max, 20);
  await assert.rejects(createSavedTemplate(viewer, input()), {
    code: "TEMPLATE_LIMIT",
  });
  await deleteSavedTemplate(viewer, full.items[0].id, {
    version: full.items[0].version,
  });
  await createSavedTemplate(viewer, input());
  assert.equal((await listSavedTemplates(viewer)).items.length, 20);
});

test("template reads and writes recheck resolved sessions and current account state", async () => {
  for (const state of [
    "expired",
    "revoked",
    "version",
    "disabled",
    "password",
  ]) {
    const { viewer, cookie } = await account();
    const created = await createSavedTemplate(viewer, input());
    if (state === "expired")
      await db.userSession.update({
        where: { id: viewer.sessionHash! },
        data: { expiresAt: new Date(0) },
      });
    else if (state === "revoked")
      await db.userSession.delete({ where: { id: viewer.sessionHash! } });
    else
      await db.user.update({
        where: { id: viewer.user!.id },
        data:
          state === "version"
            ? { version: { increment: 1 } }
            : state === "disabled"
              ? { isActive: false }
              : { mustChangePassword: true },
      });
    await rejectsSession(viewer, created.id);
    await rejectsSession(await resolveViewer(cookie.split("=")[1]), created.id);
  }
});

test(
  "HTTP templates enforce ordinary account ownership, identity scopes and same-origin writes",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!;
    const owner = await account();
    const other = await account();
    const data = input();
    const admin = await db.adminCredential.create({
      data: {
        username: "templates_" + randomUUID().slice(0, 8),
        passwordHash: "test-only-disabled-password",
        mustChangePassword: false,
      },
    });
    const send = (
      path: string,
      method: string,
      cookie: string,
      scope?: string,
      body?: unknown,
      origin = base,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          ...(scope === undefined ? {} : { "X-Identity-Scope": scope }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const path = "/api/user/templates";
      const createdResponse = await send(
        path,
        "POST",
        owner.cookie,
        owner.viewer.scope,
        data,
      );
      assert.equal(createdResponse.status, 200);
      assert.equal(createdResponse.headers.get("cache-control"), "no-store");
      const created = (await createdResponse.json()).data;
      const itemPath = `${path}/${created.id}`;
      assert.equal("userId" in created, false);
      for (const cookie of [
        "",
        `party_identity=${randomBytes(32).toString("hex")}`,
        `${ADMIN_COOKIE}=${createAdminSession(admin.id, admin.sessionVersion)}`,
      ]) {
        assert.equal((await send(path, "GET", cookie)).status, 401);
        assert.equal((await send(itemPath, "GET", cookie)).status, 401);
        assert.equal(
          (await send(path, "POST", cookie, "anonymous", data)).status,
          401,
        );
      }
      for (const scope of [undefined, other.viewer.scope])
        assert.equal(
          (await send(path, "POST", owner.cookie, scope, data)).status,
          409,
        );
      assert.equal(
        (
          await send(
            path,
            "POST",
            owner.cookie,
            owner.viewer.scope,
            data,
            "https://foreign.example",
          )
        ).status,
        403,
      );
      assert.equal((await send(itemPath, "GET", other.cookie)).status, 404);
      assert.deepEqual(
        (await (await send(path, "GET", other.cookie)).json()).data.items,
        [],
      );
      for (const [method, body] of [
        ["PATCH", { ...data, version: 0 }],
        ["DELETE", { version: 0 }],
      ] as const) {
        assert.equal(
          (await send(itemPath, method, other.cookie, other.viewer.scope, body))
            .status,
          404,
        );
        for (const scope of [undefined, other.viewer.scope])
          assert.equal(
            (await send(itemPath, method, owner.cookie, scope, body)).status,
            409,
          );
        assert.equal(
          (
            await send(
              itemPath,
              method,
              owner.cookie,
              owner.viewer.scope,
              body,
              "https://foreign.example",
            )
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await send(path, "POST", owner.cookie, owner.viewer.scope, {
            ...data,
            roomPassword: "secret",
          })
        ).status,
        400,
      );
      const updated = await send(
        itemPath,
        "PATCH",
        owner.cookie,
        owner.viewer.scope,
        { ...data, name: "更新模板", version: 0 },
      );
      assert.equal(updated.status, 200);
      const current = (await updated.json()).data;
      assert.equal(current.version, 1);
      assert.equal(
        (
          await send(itemPath, "DELETE", owner.cookie, owner.viewer.scope, {
            version: 0,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await send(itemPath, "DELETE", owner.cookie, owner.viewer.scope, {
            version: 1,
          })
        ).status,
        200,
      );
      assert.equal((await send(itemPath, "GET", owner.cookie)).status, 404);
    } finally {
      await db.adminCredential.delete({ where: { id: admin.id } });
    }
  },
);
