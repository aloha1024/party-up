import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { hashPassword, verifyPasswordHash } from "./admin-auth";
import { AppError } from "./errors";
import { writeTransaction } from "./request-budget";
import { digest, USER_SECONDS, type Viewer } from "./user-identity";
import {
  registrationSchema,
  loginSchema,
  passwordSchema,
  usernameSchema,
} from "../lib/user-account";
import { nickname } from "../lib/validation";
import { recordAdminAction, type AuditActor } from "./admin-audit";
import { sessionDevice } from "../lib/user-sessions";

const randomSecret = () => randomBytes(32).toString("hex");
const dummyHash = hashPassword(randomSecret());
const accountError = () =>
  new AppError("USER_CREDENTIALS", "账号、密码或账号状态无效", 401);
function sessionData(
  user: { id: string; version: number },
  token: string,
  userAgent?: string | null,
) {
  const now = new Date();
  return {
    id: digest(token),
    userId: user.id,
    version: user.version,
    expiresAt: new Date(now.getTime() + USER_SECONDS * 1000),
    createdAt: now,
    ...sessionDevice(userAgent),
  };
}
async function cleanupExpiredSessions(
  tx: Prisma.TransactionClient,
  now = new Date(),
) {
  const expired = await tx.userSession.findMany({
    where: { expiresAt: { lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  if (expired.length)
    await tx.userSession.deleteMany({
      where: {
        id: { in: expired.map((session) => session.id) },
        expiresAt: { lte: now },
      },
    });
}
export async function registerUser(input: unknown, userAgent?: string | null) {
  const data = registrationSchema.parse(input);
  const passwordHash = await hashPassword(data.password);
  const recoveryCode = randomSecret(),
    token = randomSecret();
  try {
    await writeTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: data.username,
          nickname: data.nickname,
          passwordHash,
          recoveryHash: digest(recoveryCode),
        },
      });
      await tx.userSession.create({
        data: sessionData(user, token, userAgent),
      });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw new AppError(
        "USERNAME_TAKEN",
        "用户名已被使用；如上次注册结果不明确，请尝试登录",
        409,
      );
    throw e;
  }
  return { token, recoveryCode };
}
export async function loginUser(input: unknown, userAgent?: string | null) {
  const data = loginSchema.parse(input);
  const user = await db.user.findUnique({ where: { username: data.username } });
  const valid = await verifyPasswordHash(
    data.password,
    user?.passwordHash ?? (await dummyHash),
  );
  if (!user || !valid || !user.isActive) throw accountError();
  const token = randomSecret();
  await writeTransaction(async (tx) => {
    const locked = await tx.user.updateMany({
      where: {
        id: user.id,
        version: user.version,
        passwordHash: user.passwordHash,
        isActive: true,
      },
      data: { version: { increment: 0 } },
    });
    if (!locked.count) throw accountError();
    await cleanupExpiredSessions(tx);
    await tx.userSession.create({ data: sessionData(user, token, userAgent) });
  });
  return { token, mustChangePassword: user.mustChangePassword };
}
export function requireUser(v: Viewer, limited = false) {
  if (v.mode !== "user" || !v.user || (!limited && v.user.mustChangePassword))
    throw new AppError("USER_SESSION", "请登录账号并完成密码修改", 401);
  return v.user;
}
export async function lockUser(
  tx: Prisma.TransactionClient,
  v: Viewer,
  limited = false,
) {
  const user = requireUser(v, limited);
  const locked = await tx.user.updateMany({
    where: { id: user.id, isActive: true, version: v.version },
    data: { version: { increment: 0 } },
  });
  const session = await tx.userSession.findUnique({
    where: { id: v.sessionHash! },
  });
  if (!locked.count || !session || session.expiresAt <= new Date())
    throw new AppError("USER_SESSION", "登录或账号状态已变化，请重新登录", 401);
  return user;
}
export async function updateProfile(v: Viewer, input: unknown) {
  const data = z.object({ nickname }).strict().parse(input);
  return writeTransaction(async (tx) => {
    const u = await lockUser(tx, v);
    await tx.user.update({ where: { id: u.id }, data });
    return { updated: true };
  });
}
export async function changeUserPassword(v: Viewer, input: unknown) {
  const data = z
    .object({ currentPassword: passwordSchema, password: passwordSchema })
    .strict()
    .parse(input);
  const user = requireUser(v, true);
  if (!(await verifyPasswordHash(data.currentPassword, user.passwordHash)))
    throw accountError();
  const passwordHash = await hashPassword(data.password);
  await writeTransaction(async (tx) => {
    await lockUser(tx, v, true);
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        version: { increment: 1 },
      },
    });
    await tx.userSession.deleteMany({ where: { userId: user.id } });
  });
  return { changed: true };
}
export async function rotateRecovery(v: Viewer, input: unknown) {
  const { password } = z
    .object({ password: passwordSchema })
    .strict()
    .parse(input);
  const user = requireUser(v);
  if (!(await verifyPasswordHash(password, user.passwordHash)))
    throw accountError();
  const recoveryCode = randomSecret();
  await writeTransaction(async (tx) => {
    await lockUser(tx, v);
    await tx.user.update({
      where: { id: user.id },
      data: { recoveryHash: digest(recoveryCode) },
    });
  });
  return { recoveryCode };
}
export async function recoverUser(input: unknown) {
  const data = z
    .object({
      username: usernameSchema,
      recoveryCode: z.string().regex(/^[a-f0-9]{64}$/),
      password: passwordSchema,
    })
    .strict()
    .parse(input);
  const passwordHash = await hashPassword(data.password);
  await writeTransaction(async (tx) => {
    const found = await tx.user.updateMany({
      where: {
        username: data.username,
        recoveryHash: digest(data.recoveryCode),
        isActive: true,
      },
      data: {
        passwordHash,
        recoveryHash: null,
        mustChangePassword: false,
        version: { increment: 1 },
      },
    });
    if (!found.count)
      throw new AppError("RECOVERY_INVALID", "账号、恢复码或账号状态无效", 400);
    const user = await tx.user.findUniqueOrThrow({
      where: { username: data.username },
    });
    await tx.userSession.deleteMany({ where: { userId: user.id } });
  });
  return { recovered: true };
}
export async function revokeUserSessions(v: Viewer) {
  await writeTransaction(async (tx) => {
    const u = await lockUser(tx, v);
    await tx.user.update({
      where: { id: u.id },
      data: { version: { increment: 1 } },
    });
    await tx.userSession.deleteMany({ where: { userId: u.id } });
  });
  return { revoked: true };
}
export async function listUsers(input: unknown) {
  const { q, page } = z
    .object({
      q: z.string().trim().max(80).default(""),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    })
    .parse(input);
  return db.$transaction(async (tx) => {
    const where = {
      OR: [{ username: { contains: q } }, { nickname: { contains: q } }],
    };
    const total = await tx.user.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / 20)),
      actual = Math.min(page, pageCount);
    const items = await tx.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (actual - 1) * 20,
      take: 20,
      select: {
        id: true,
        username: true,
        nickname: true,
        isActive: true,
        mustChangePassword: true,
        version: true,
        createdAt: true,
      },
    });
    return { items, total, page: actual, pageCount };
  });
}
export async function manageUser(
  id: string,
  input: unknown,
  actor: AuditActor,
) {
  const data = z
    .object({
      action: z.enum(["enable", "disable", "revoke", "reset"]),
      version: z.number().int().nonnegative(),
      password: passwordSchema.optional(),
    })
    .strict()
    .parse(input);
  if (data.action === "reset" && !data.password)
    throw new AppError("VALIDATION", "请填写临时密码", 400);
  const passwordHash =
    data.action === "reset" ? await hashPassword(data.password!) : undefined;
  await writeTransaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id, version: data.version },
      data: {
        version: { increment: 1 },
        ...(data.action === "enable" || data.action === "disable"
          ? { isActive: data.action === "enable" }
          : {}),
        ...(passwordHash
          ? { passwordHash, recoveryHash: null, mustChangePassword: true }
          : {}),
      },
    });
    if (!result.count)
      throw new AppError("USER_CONFLICT", "账号已变化，请刷新后重新确认", 409);
    await tx.userSession.deleteMany({ where: { userId: id } });
    const u = await tx.user.findUniqueOrThrow({ where: { id } });
    await recordAdminAction(
      tx,
      actor,
      {
        enable: "USER_ENABLE",
        disable: "USER_DISABLE",
        revoke: "USER_REVOKE_SESSIONS",
        reset: "USER_RESET_PASSWORD",
      }[data.action] as
        | "USER_ENABLE"
        | "USER_DISABLE"
        | "USER_REVOKE_SESSIONS"
        | "USER_RESET_PASSWORD",
      { id, label: u.username },
    );
  });
  return { updated: true };
}
