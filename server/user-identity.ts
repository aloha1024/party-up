import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Prisma, User } from "@prisma/client";
import { db } from "./db";
import { AppError } from "./errors";

export const USER_COOKIE = "party_user";
export const GUEST_COOKIE = "party_identity";
export const USER_SECONDS = 30 * 24 * 60 * 60;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const validGuest = (value?: string): value is string =>
  !!value && /^[a-f0-9]{64}$/.test(value);
export const memberToken = (user: Pick<User, "identityKey">) =>
  `user:${user.identityKey}`;
export const validIdentity = (value?: string): value is string =>
  validGuest(value) || (!!value && /^user:[a-f0-9-]{36}$/.test(value));
const scopeState = globalThis as unknown as {
  partyIdentityScopeSecret?: string;
};
const fallbackSecret = (scopeState.partyIdentityScopeSecret ??=
  randomBytes(32).toString("hex"));
function opaque(value: string) {
  return createHmac(
    "sha256",
    process.env.ADMIN_SESSION_SECRET || fallbackSecret,
  )
    .update(value)
    .digest("hex");
}
export const identityStorageKey = (token: string) => opaque(`storage:${token}`);
export type Viewer = {
  mode: "anonymous" | "guest" | "user" | "invalid";
  token?: string;
  guestToken?: string;
  sessionHash?: string;
  user?: User;
  version: number;
  scope: string;
  storageKey: string;
};
export async function resolveViewer(
  userCookie?: string,
  guestCookie?: string,
): Promise<Viewer> {
  const guestToken = validGuest(guestCookie) ? guestCookie : undefined;
  if (userCookie) {
    const session = validGuest(userCookie)
      ? await db.userSession.findUnique({
          where: { id: digest(userCookie) },
          include: { user: true },
        })
      : null;
    if (
      !session ||
      session.expiresAt <= new Date() ||
      !session.user.isActive ||
      session.version !== session.user.version
    )
      return {
        mode: "invalid",
        guestToken,
        version: 0,
        scope: "invalid",
        storageKey: "invalid",
      };
    const token = memberToken(session.user);
    return {
      mode: "user",
      token,
      guestToken,
      sessionHash: session.id,
      user: session.user,
      version: session.version,
      scope: opaque(`session:${session.id}:${session.version}`),
      storageKey: opaque(`storage:${token}`),
    };
  }
  if (guestToken) {
    const guest = await db.guestIdentity.findUnique({
      where: { hash: digest(guestToken) },
    });
    if (!guest?.retired)
      return {
        mode: "guest",
        token: guestToken,
        guestToken,
        version: guest?.version ?? 0,
        scope: opaque(`guest:${guestToken}:${guest?.version ?? 0}`),
        storageKey: opaque(`storage:${guestToken}`),
      };
  }
  return {
    mode: "anonymous",
    guestToken,
    version: 0,
    scope: "anonymous",
    storageKey: "anonymous",
  };
}
export function publicViewer(v: Viewer) {
  const member = v.mode === "user" && !v.user!.mustChangePassword;
  return {
    ready: !!v.token && (v.mode !== "user" || member),
    mode: v.mode,
    scope: v.scope,
    storageKey: v.storageKey,
    user: v.user
      ? {
          username: v.user.username,
          nickname: v.user.nickname,
          mustChangePassword: v.user.mustChangePassword,
        }
      : null,
    capabilities: {
      createInvitation: member,
      copyReservation: member,
      calendar: member,
    },
  };
}
export const viewerContext = new AsyncLocalStorage<Viewer>();
export async function guardViewer(
  tx: Prisma.TransactionClient,
  viewer = viewerContext.getStore(),
) {
  if (!viewer) return;
  if (viewer.mode === "user") {
    const updated = await tx.user.updateMany({
      where: {
        id: viewer.user!.id,
        version: viewer.version,
        isActive: true,
        mustChangePassword: false,
      },
      data: { version: { increment: 0 } },
    });
    const session = await tx.userSession.findUnique({
      where: { id: viewer.sessionHash! },
    });
    if (
      !updated.count ||
      !session ||
      session.expiresAt <= new Date() ||
      session.version !== viewer.version
    )
      throw new AppError("USER_SESSION", "账号状态已变化，请重新登录", 401);
  } else if (viewer.mode === "guest") {
    const guest = await tx.guestIdentity.upsert({
      where: { hash: digest(viewer.token!) },
      create: { hash: digest(viewer.token!) },
      update: { version: { increment: 0 } },
    });
    if (guest.retired || guest.version !== viewer.version)
      throw new AppError(
        "IDENTITY_CHANGED",
        "游客记录已关联或身份已变化，请刷新",
        409,
      );
  } else
    throw new AppError(
      "USER_SESSION",
      "请重新登录或明确退出后使用游客模式",
      401,
    );
}
export async function requireMember(
  token?: string,
  client: Pick<Prisma.TransactionClient, "user"> = db,
) {
  const user = token?.startsWith("user:")
    ? await client.user.findUnique({ where: { identityKey: token.slice(5) } })
    : null;
  if (!user || !user.isActive || user.mustChangePassword)
    throw new AppError(
      "REGISTRATION_REQUIRED",
      "此功能需要注册并登录普通用户账号",
      403,
    );
  return user;
}
