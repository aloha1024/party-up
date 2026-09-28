import "./support/isolated";
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../server/db";
import { claimGuestRecords, previewGuestClaim } from "../server/guest-claims";
import {
  digest,
  identityStorageKey,
  memberToken,
  resolveViewer,
  type Viewer,
} from "../server/user-identity";

const reservationIds: string[] = [],
  userIds: string[] = [],
  guestHashes: string[] = [];
const secret = () => randomBytes(32).toString("hex");
const future = new Date("2100-01-01T00:00:00.000Z");

after(async () => {
  await db.creationRequest.deleteMany({
    where: { reservationId: { in: reservationIds } },
  });
  await db.gameReservation.deleteMany({
    where: { id: { in: reservationIds } },
  });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.guestIdentity.deleteMany({ where: { hash: { in: guestHashes } } });
  await db.$disconnect();
});

async function account() {
  const guestToken = secret(),
    sessionToken = secret();
  const user = await db.user.create({
    data: {
      username: "claim_" + randomUUID().replaceAll("-", "").slice(0, 20),
      nickname: "Member",
      passwordHash: "unused-claim-fixture",
    },
  });
  userIds.push(user.id);
  await db.userSession.create({
    data: {
      id: digest(sessionToken),
      userId: user.id,
      version: user.version,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const guestHash = digest(guestToken);
  guestHashes.push(guestHash);
  await db.guestIdentity.create({ data: { hash: guestHash } });
  return {
    viewer: await resolveViewer(sessionToken, guestToken),
    guestHash,
    userHash: digest(memberToken(user)),
  };
}

async function reservation(
  data: Partial<Prisma.GameReservationCreateInput> = {},
) {
  const id = data.id ?? randomUUID();
  reservationIds.push(id);
  return db.gameReservation.create({
    data: {
      id,
      gameName: "Claim fixture " + id,
      hostName: "Host",
      scheduledAt: future,
      maxPlayers: 8,
      ...data,
    },
  });
}

async function creation(
  ownerTokenHash: string,
  reservationId: string = randomUUID(),
  key: string = randomUUID(),
  id: string = randomUUID(),
) {
  reservationIds.push(reservationId);
  return db.creationRequest.create({
    data: { id, ownerTokenHash, reservationId, key, inputHash: digest(id) },
  });
}

async function submit(viewer: Viewer, ids: string[]) {
  const preview = await previewGuestClaim(viewer);
  return claimGuestRecords(viewer, {
    key: randomUUID(),
    fingerprint: preview.fingerprint,
    ids,
  });
}

// Independent pre-optimization oracle: keep its full data shape, sort order and
// nested scans so this catches accidental narrowing of the confirmation scope.
async function legacyPreview(viewer: Viewer) {
  const guestHash = digest(viewer.guestToken!),
    userHash = digest(memberToken(viewer.user!));
  return db.$transaction(async (tx) => {
    const [guest, reservations, submissions] = await Promise.all([
      tx.guestIdentity.findUnique({ where: { hash: guestHash } }),
      tx.gameReservation.findMany({
        where: {
          OR: [
            { hostTokenHash: guestHash },
            { participants: { some: { tokenHash: guestHash } } },
            { waitlist: { some: { tokenHash: guestHash } } },
            { access: { some: { tokenHash: guestHash } } },
            { removals: { some: { targetTokenHash: guestHash } } },
          ],
        },
        orderBy: { id: "asc" },
        include: {
          participants: { orderBy: { id: "asc" } },
          waitlist: { orderBy: { id: "asc" } },
          access: { orderBy: { id: "asc" } },
          removals: {
            where: { targetTokenHash: guestHash },
            orderBy: { id: "asc" },
          },
        },
      }),
      tx.creationRequest.findMany({
        where: { ownerTokenHash: { in: [guestHash, userHash] } },
        orderBy: { id: "asc" },
      }),
    ]);
    const source = submissions.filter((s) => s.ownerTokenHash === guestHash);
    const dest = submissions.filter((s) => s.ownerTokenHash === userHash);
    const items = reservations.map((r) => {
      const entries = [...r.participants, ...r.waitlist];
      const mine = entries.filter((p) => p.tokenHash === guestHash),
        theirs = entries.filter((p) => p.tokenHash === userHash);
      const hostConflict =
        (r.hostTokenHash === guestHash &&
          theirs.some((p) => p.name !== r.hostName)) ||
        (r.hostTokenHash === userHash &&
          mine.some((p) => p.name !== r.hostName));
      const keyConflict = source.some(
        (s) => s.reservationId === r.id && dest.some((d) => d.key === s.key),
      );
      const conflict =
        mine.length && theirs.length
          ? "同场存在两份正式或候补名额"
          : hostConflict
            ? "发起人昵称与关联后的名单不一致"
            : keyConflict
              ? "创建提交编号冲突"
              : null;
      const grant = r.access.find((g) => g.tokenHash === guestHash);
      const readable =
        r.visibility === "PUBLIC" ||
        r.hostTokenHash === guestHash ||
        mine.length ||
        (grant && (grant.hasJoined || grant.inviteVersion === r.inviteVersion));
      return {
        id: r.id,
        label: r.deletedAt
          ? "已移入回收站的预约"
          : readable
            ? r.gameName
            : "邀请权限已失效的预约",
        conflict,
        canOpen: !r.deletedAt && !!readable,
        historical:
          r.scheduledAt <= new Date() ||
          r.status === "CANCELLED" ||
          r.status === "ENDED",
      };
    });
    for (const s of source)
      if (!items.some((i) => i.id === s.reservationId))
        items.push({
          id: s.reservationId,
          label: "已永久删除的创建记录",
          conflict: dest.some((d) => d.key === s.key)
            ? "创建提交编号冲突"
            : null,
          canOpen: false,
          historical: true,
        });
    return {
      items: guest?.retired ? [] : items,
      fingerprint: digest(
        JSON.stringify({
          guest: {
            version: guest?.version ?? 0,
            retired: guest?.retired ?? false,
          },
          reservations,
          submissions,
        }),
      ),
      guestStorageKey: identityStorageKey(viewer.guestToken!),
    };
  });
}

test("guest preview matches the original fingerprint, ordering, conflict priority and private labels", async () => {
  const a = await account(),
    prefix = randomUUID();
  const membership = await reservation({
    id: prefix + "-c",
    hostTokenHash: a.guestHash,
    deletedAt: new Date(0),
    participants: {
      create: [
        {
          id: prefix + "-p-z",
          name: "Host",
          nameKey: "host",
          tokenHash: a.guestHash,
        },
        {
          id: prefix + "-p-a",
          name: "Third party",
          nameKey: "third",
          tokenHash: digest(secret()),
        },
      ],
    },
    waitlist: {
      create: {
        name: "Different",
        nameKey: "different",
        tokenHash: a.userHash,
      },
    },
  });
  const host = await reservation({
    id: prefix + "-a",
    hostTokenHash: a.guestHash,
    participants: {
      create: {
        name: "Different",
        nameKey: "different",
        tokenHash: a.userHash,
      },
    },
  });
  const keyOnly = await reservation({
    id: prefix + "-b",
    hostTokenHash: a.guestHash,
    scheduledAt: new Date(0),
    status: "ENDED",
  });
  for (const r of [membership, host, keyOnly]) {
    const source = await creation(a.guestHash, r.id);
    await creation(a.userHash, undefined, source.key);
  }
  const hidden = await reservation({
    id: prefix + "-d",
    gameName: "PRIVATE TITLE MUST STAY HIDDEN",
    visibility: "INVITE",
    inviteVersion: 3,
    access: { create: { tokenHash: a.guestHash, inviteVersion: 1 } },
    removals: {
      create: {
        kind: "participants",
        entryId: randomUUID(),
        targetTokenHash: a.guestHash,
        targetName: "PRIVATE NAME",
        reason: "PRIVATE REMOVAL REASON",
        actorRole: "HOST",
      },
    },
  });
  const readable = await reservation({
    id: prefix + "-e",
    visibility: "INVITE",
    inviteVersion: 3,
    access: {
      create: { tokenHash: a.guestHash, inviteVersion: 1, hasJoined: true },
    },
  });
  const tombstoneLater = await creation(
    a.guestHash,
    prefix + "-tombstone-a",
    undefined,
    prefix + "-submission-z",
  );
  const tombstoneFirst = await creation(
    a.guestHash,
    prefix + "-tombstone-z",
    undefined,
    prefix + "-submission-a",
  );
  await creation(a.userHash, undefined, tombstoneFirst.key);
  await db.guestIdentity.update({
    where: { hash: a.guestHash },
    data: { version: 7 },
  });
  const actual = await previewGuestClaim(a.viewer);
  assert.deepEqual(actual, await legacyPreview(a.viewer));
  assert.deepEqual(
    actual.items.map((i) => i.id),
    [
      host.id,
      keyOnly.id,
      membership.id,
      hidden.id,
      readable.id,
      tombstoneFirst.reservationId,
      tombstoneLater.reservationId,
    ],
  );
  const byId = new Map(actual.items.map((item) => [item.id, item]));
  assert.equal(byId.get(membership.id)!.conflict, "同场存在两份正式或候补名额");
  assert.equal(byId.get(host.id)!.conflict, "发起人昵称与关联后的名单不一致");
  assert.equal(byId.get(keyOnly.id)!.conflict, "创建提交编号冲突");
  assert.equal(
    byId.get(tombstoneFirst.reservationId)!.conflict,
    "创建提交编号冲突",
  );
  assert.equal(byId.get(keyOnly.id)!.historical, true);
  assert.equal(byId.get(membership.id)!.label, "已移入回收站的预约");
  assert.equal(byId.get(hidden.id)!.label, "邀请权限已失效的预约");
  assert.equal(byId.get(hidden.id)!.canOpen, false);
  assert.equal(byId.get(readable.id)!.canOpen, true);
  const serialized = JSON.stringify(actual);
  for (const privateValue of [
    hidden.gameName,
    "PRIVATE NAME",
    "PRIVATE REMOVAL REASON",
    a.guestHash,
    a.userHash,
  ])
    assert.equal(serialized.includes(privateValue), false);
});

for (const changed of [
  "participant name",
  "attendance",
  "waitlist",
  "grant",
  "account creation",
] as const) {
  test(`guest confirmation stays stale after unrelated ${changed} changes without touching the reservation`, async () => {
    const a = await account();
    const r = await reservation({
      hostTokenHash: a.guestHash,
      participants: {
        create: {
          name: "Other",
          nameKey: "other",
          tokenHash: digest(secret()),
        },
      },
      waitlist: {
        create: {
          name: "Waiting",
          nameKey: "waiting",
          tokenHash: digest(secret()),
        },
      },
      access: { create: { tokenHash: digest(secret()), inviteVersion: 1 } },
    });
    const unrelatedCreation = await creation(a.userHash);
    const preview = await previewGuestClaim(a.viewer);
    if (changed === "participant name")
      await db.participant.updateMany({
        where: { reservationId: r.id },
        data: { name: "Changed" },
      });
    else if (changed === "attendance")
      await db.participant.updateMany({
        where: { reservationId: r.id },
        data: { checkedInAt: new Date(0), attendanceVersion: { increment: 1 } },
      });
    else if (changed === "waitlist")
      await db.waitlistEntry.updateMany({
        where: { reservationId: r.id },
        data: { name: "Changed" },
      });
    else if (changed === "grant")
      await db.reservationAccess.updateMany({
        where: { reservationId: r.id },
        data: { hasJoined: true },
      });
    else
      await db.creationRequest.update({
        where: { id: unrelatedCreation.id },
        data: { inputHash: digest("changed") },
      });
    assert.deepEqual(
      await db.gameReservation.findUniqueOrThrow({ where: { id: r.id } }),
      r,
    );
    await assert.rejects(
      claimGuestRecords(a.viewer, {
        key: randomUUID(),
        fingerprint: preview.fingerprint,
        ids: [r.id],
      }),
      { code: "CLAIM_STALE" },
    );
    assert.equal(
      (await db.gameReservation.findUniqueOrThrow({ where: { id: r.id } }))
        .hostTokenHash,
      a.guestHash,
    );
  });
}

type DelegateCall = { model: string; operation: string; args: unknown };
function trackTransactionDelegates(t: TestContext) {
  const calls: DelegateCall[] = [];
  const original = db.$transaction;
  const transaction = original.bind(db);
  t.after(() => {
    db.$transaction = original;
  });
  const models = new Set([
    "guestIdentity",
    "gameReservation",
    "creationRequest",
    "reservationAccess",
  ]);
  // Observe public Prisma delegate calls while every operation still executes
  // against the real isolated database. Relation includes may emit several SQL
  // statements, so these counts deliberately make no claim about SQL totals.
  const intercept = async (
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: Parameters<typeof db.$transaction>[1],
  ) =>
    transaction(
      async (tx) =>
        run(
          new Proxy(tx, {
            get(target, model, receiver) {
              const delegate = Reflect.get(target, model, receiver);
              if (typeof model !== "string" || !models.has(model))
                return delegate;
              return new Proxy(delegate, {
                get(targetDelegate, operation, delegateReceiver) {
                  const method = Reflect.get(
                    targetDelegate,
                    operation,
                    delegateReceiver,
                  );
                  if (
                    typeof operation !== "string" ||
                    typeof method !== "function"
                  )
                    return method;
                  return (...args: unknown[]) => {
                    calls.push({ model, operation, args: args[0] });
                    return Reflect.apply(method, targetDelegate, args);
                  };
                },
              });
            },
          }),
        ),
      options,
    );
  db.$transaction = intercept as typeof db.$transaction;
  return (model: string, operation: string) =>
    calls.filter(
      (call) => call.model === model && call.operation === operation,
    );
}

for (const grantCount of [1, 4]) {
  test(`claim with ${grantCount} grant(s) reads one full snapshot and reuses its access rows`, async (t) => {
    const a = await account(),
      selected: string[] = [];
    for (let i = 0; i < grantCount; i++) {
      const r = await reservation({
        access: {
          create: [
            { tokenHash: a.guestHash, inviteVersion: 1 },
            { tokenHash: a.userHash, inviteVersion: 2 },
          ],
        },
      });
      selected.push(r.id);
    }
    const hasRemaining = grantCount > 1;
    if (hasRemaining) await reservation({ hostTokenHash: a.guestHash });
    const preview = await previewGuestClaim(a.viewer);
    const calls = trackTransactionDelegates(t);
    const result = await claimGuestRecords(a.viewer, {
      key: randomUUID(),
      fingerprint: preview.fingerprint,
      ids: selected,
    });
    assert.equal(result.retired, !hasRemaining);
    assert.equal(calls("gameReservation", "findMany").length, 1);
    assert.equal(calls("creationRequest", "findMany").length, 1);
    assert.equal(calls("guestIdentity", "findUnique").length, 1);
    assert.equal(calls("reservationAccess", "findMany").length, 0);
    assert.equal(calls("reservationAccess", "findUnique").length, 0);
    assert.deepEqual(
      calls("gameReservation", "findFirst").map((call) => call.args),
      [
        {
          where: {
            OR: [
              { hostTokenHash: a.guestHash },
              { participants: { some: { tokenHash: a.guestHash } } },
              { waitlist: { some: { tokenHash: a.guestHash } } },
              { access: { some: { tokenHash: a.guestHash } } },
              { removals: { some: { targetTokenHash: a.guestHash } } },
            ],
          },
          select: { id: true },
        },
      ],
    );
    assert.deepEqual(
      calls("creationRequest", "findFirst").map((call) => call.args),
      hasRemaining
        ? []
        : [
            {
              where: { ownerTokenHash: a.guestHash },
              select: { id: true },
            },
          ],
    );
  });
}

for (const remaining of [
  "host",
  "participant",
  "waitlist",
  "access",
  "removal",
  "creation",
] as const) {
  test(`a remaining guest ${remaining} prevents retirement even when hidden or historical`, async () => {
    const a = await account();
    const selected = await reservation({ hostTokenHash: a.guestHash });
    const residual = await reservation({
      ...(remaining === "host"
        ? { hostTokenHash: a.guestHash, deletedAt: new Date(0) }
        : {}),
      ...(remaining === "participant"
        ? {
            scheduledAt: new Date(0),
            participants: {
              create: { name: "Past", nameKey: "past", tokenHash: a.guestHash },
            },
          }
        : {}),
      ...(remaining === "waitlist"
        ? {
            status: "CANCELLED",
            waitlist: {
              create: {
                name: "Waiting",
                nameKey: "waiting",
                tokenHash: a.guestHash,
              },
            },
          }
        : {}),
      ...(remaining === "access"
        ? {
            visibility: "INVITE",
            inviteVersion: 5,
            access: { create: { tokenHash: a.guestHash, inviteVersion: 1 } },
          }
        : {}),
      ...(remaining === "removal"
        ? {
            visibility: "INVITE",
            removals: {
              create: {
                kind: "participants",
                entryId: randomUUID(),
                targetTokenHash: a.guestHash,
                targetName: "Removed",
                reason: "Private",
                actorRole: "HOST",
              },
            },
          }
        : {}),
    });
    if (remaining === "creation") {
      await creation(a.guestHash, residual.id);
      await db.gameReservation.delete({ where: { id: residual.id } });
    }
    assert.equal((await submit(a.viewer, [selected.id])).retired, false);
    const next = await previewGuestClaim(a.viewer);
    assert.deepEqual(
      next.items.map((item) => item.id),
      [residual.id],
    );
    assert.equal((await submit(a.viewer, [residual.id])).retired, true);
    assert.deepEqual(
      await db.guestIdentity.findUniqueOrThrow({
        where: { hash: a.guestHash },
      }),
      {
        hash: a.guestHash,
        version: 2,
        retired: true,
      },
    );
  });
}

test("claim merges access versions and membership history while preserving the surviving grant ID", async () => {
  const a = await account();
  const cases = [
    {
      sourceVersion: 3,
      sourceJoined: false,
      target: null,
      version: 3,
      joined: false,
    },
    {
      sourceVersion: 1,
      sourceJoined: true,
      target: { inviteVersion: 4, hasJoined: false },
      version: 4,
      joined: true,
    },
    {
      sourceVersion: 4,
      sourceJoined: false,
      target: { inviteVersion: 1, hasJoined: true },
      version: 4,
      joined: true,
    },
    {
      sourceVersion: 1,
      sourceJoined: false,
      target: { inviteVersion: 2, hasJoined: false },
      version: 2,
      joined: false,
    },
  ];
  const expected = [];
  for (const fixture of cases) {
    const r = await reservation({ visibility: "INVITE", inviteVersion: 5 });
    const source = await db.reservationAccess.create({
      data: {
        reservationId: r.id,
        tokenHash: a.guestHash,
        inviteVersion: fixture.sourceVersion,
        hasJoined: fixture.sourceJoined,
      },
    });
    const target = fixture.target
      ? await db.reservationAccess.create({
          data: {
            reservationId: r.id,
            tokenHash: a.userHash,
            ...fixture.target,
          },
        })
      : null;
    expected.push({
      id: target?.id ?? source.id,
      reservationId: r.id,
      tokenHash: a.userHash,
      inviteVersion: fixture.version,
      hasJoined: fixture.joined,
    });
  }
  assert.equal(
    (
      await submit(
        a.viewer,
        expected.map((grant) => grant.reservationId),
      )
    ).retired,
    true,
  );
  const actual = await db.reservationAccess.findMany({
    where: {
      reservationId: { in: expected.map((grant) => grant.reservationId) },
    },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    actual,
    expected.sort((a, b) => a.id - b.id),
  );
});

test("an access merge failure rolls back preceding ownership and authorization updates", async () => {
  const a = await account();
  const r = await reservation({
    hostTokenHash: a.guestHash,
    participants: {
      create: { name: "Host", nameKey: "host", tokenHash: a.guestHash },
    },
    removals: {
      create: {
        kind: "participants",
        entryId: randomUUID(),
        targetTokenHash: a.guestHash,
        targetName: "Past",
        reason: "Private",
        actorRole: "HOST",
      },
    },
  });
  await creation(a.guestHash, r.id);
  const source = await db.reservationAccess.create({
    data: {
      reservationId: r.id,
      tokenHash: a.guestHash,
      inviteVersion: 3,
      hasJoined: true,
    },
  });
  await db.reservationAccess.create({
    data: {
      reservationId: r.id,
      tokenHash: a.userHash,
      inviteVersion: 1,
      hasJoined: false,
    },
  });
  const before = await legacyPreview(a.viewer);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_claim_access_delete BEFORE DELETE ON ReservationAccess WHEN OLD.id = ${source.id} BEGIN SELECT RAISE(ABORT, 'test access failure'); END`,
  );
  try {
    await assert.rejects(
      claimGuestRecords(a.viewer, {
        key: randomUUID(),
        fingerprint: before.fingerprint,
        ids: [r.id],
      }),
    );
  } finally {
    await db.$executeRawUnsafe("DROP TRIGGER fail_claim_access_delete");
  }
  assert.deepEqual(await legacyPreview(a.viewer), before);
  assert.equal(
    await db.guestClaim.count({ where: { userId: a.viewer.user!.id } }),
    0,
  );
});
