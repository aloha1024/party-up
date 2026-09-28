import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { writeTransaction } from "./request-budget";
import { lockUser, requireUser } from "./user-accounts";
import {
  digest,
  memberToken,
  identityStorageKey,
  type Viewer,
} from "./user-identity";

async function snapshot(
  tx: Prisma.TransactionClient,
  guestHash: string,
  userHash: string,
) {
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
      (r.hostTokenHash === userHash && mine.some((p) => p.name !== r.hostName));
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
        conflict: dest.some((d) => d.key === s.key) ? "创建提交编号冲突" : null,
        canOpen: false,
        historical: true,
      });
  // Include both identities' membership and authorization state in the confirmation fingerprint.
  return {
    items,
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
    version: guest?.version ?? 0,
    retired: guest?.retired ?? false,
  };
}
export async function previewGuestClaim(v: Viewer) {
  const user = requireUser(v);
  if (!v.guestToken) return { items: [], fingerprint: "", guestStorageKey: "" };
  const s = await db.$transaction((tx) =>
    snapshot(tx, digest(v.guestToken!), digest(memberToken(user))),
  );
  return {
    items: s.retired ? [] : s.items,
    fingerprint: s.fingerprint,
    guestStorageKey: identityStorageKey(v.guestToken),
  };
}
export async function claimGuestRecords(v: Viewer, input: unknown) {
  const user = requireUser(v);
  const data = z
    .object({
      key: z.string().uuid(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      ids: z.array(z.string().min(1).max(128)).min(1),
    })
    .strict()
    .parse(input);
  if (!v.guestToken)
    throw new AppError("GUEST_MISSING", "当前浏览器没有可关联的游客身份", 409);
  const ids = [...new Set(data.ids)].sort(),
    inputHash = digest(JSON.stringify({ fingerprint: data.fingerprint, ids }));
  const guestHash = digest(v.guestToken),
    userHash = digest(memberToken(user));
  return writeTransaction(async (tx) => {
    await lockUser(tx, v);
    const old = await tx.guestClaim.findUnique({
      where: { userId_key: { userId: user.id, key: data.key } },
    });
    if (old) {
      if (old.guestHash !== guestHash || old.inputHash !== inputHash)
        throw new AppError(
          "CLAIM_CHANGED",
          "关联编号已用于其他内容，请重新预览",
          409,
        );
      return JSON.parse(old.result) as {
        ids: string[];
        retired: boolean;
        fromStorage: string;
        toStorage: string;
      };
    }
    // This first write serializes guest mutations, membership promotion and competing claims.
    await tx.guestIdentity.upsert({
      where: { hash: guestHash },
      create: { hash: guestHash },
      update: { version: { increment: 0 } },
    });
    const s = await snapshot(tx, guestHash, userHash);
    if (s.retired || s.fingerprint !== data.fingerprint)
      throw new AppError(
        "CLAIM_STALE",
        "记录已变化，请重新预览并确认关联",
        409,
      );
    if (ids.some((id) => !s.items.some((i) => i.id === id && !i.conflict)))
      throw new AppError(
        "CLAIM_CONFLICT",
        "所选场次存在冲突或不属于当前游客",
        409,
      );
    await tx.gameReservation.updateMany({
      where: { id: { in: ids }, hostTokenHash: guestHash },
      data: { hostTokenHash: userHash },
    });
    await tx.participant.updateMany({
      where: { reservationId: { in: ids }, tokenHash: guestHash },
      data: { tokenHash: userHash },
    });
    await tx.waitlistEntry.updateMany({
      where: { reservationId: { in: ids }, tokenHash: guestHash },
      data: { tokenHash: userHash },
    });
    await tx.rosterRemoval.updateMany({
      where: { reservationId: { in: ids }, targetTokenHash: guestHash },
      data: { targetTokenHash: userHash },
    });
    await tx.creationRequest.updateMany({
      where: { reservationId: { in: ids }, ownerTokenHash: guestHash },
      data: { ownerTokenHash: userHash },
    });
    const grants = await tx.reservationAccess.findMany({
      where: { reservationId: { in: ids }, tokenHash: guestHash },
    });
    for (const grant of grants) {
      const target = await tx.reservationAccess.findUnique({
        where: {
          reservationId_tokenHash: {
            reservationId: grant.reservationId,
            tokenHash: userHash,
          },
        },
      });
      if (target) {
        await tx.reservationAccess.update({
          where: { id: target.id },
          data: {
            inviteVersion: Math.max(target.inviteVersion, grant.inviteVersion),
            hasJoined: target.hasJoined || grant.hasJoined,
          },
        });
        await tx.reservationAccess.delete({ where: { id: grant.id } });
      } else
        await tx.reservationAccess.update({
          where: { id: grant.id },
          data: { tokenHash: userHash },
        });
    }
    const remaining = await snapshot(tx, guestHash, userHash);
    const retired = remaining.items.length === 0;
    await tx.guestIdentity.update({
      where: { hash: guestHash },
      data: { retired, version: { increment: 1 } },
    });
    const result = {
      ids,
      retired,
      fromStorage: identityStorageKey(v.guestToken!),
      toStorage: v.storageKey,
    };
    await tx.guestClaim.create({
      data: {
        userId: user.id,
        guestHash,
        key: data.key,
        inputHash,
        result: JSON.stringify(result),
      },
    });
    return result;
  });
}
