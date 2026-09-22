import { Prisma } from "@prisma/client";
import { z } from "zod";
import { cookies } from "next/headers";
import { db } from "./db";
import { recordAdminAction } from "./admin-audit";
import {
  ADMIN_COOKIE,
  adminBootstrapConfigured,
  bootstrapFingerprint,
  hashPassword,
  readAdminSession,
  verifyPasswordHash,
} from "./admin-auth";
import { AppError } from "./reservations";

const ADMIN_ID = 1;

export async function ensureAdminRecord() {
  if (!adminBootstrapConfigured())
    throw new AppError(
      "NOT_CONFIGURED",
      "管理员尚未配置，请在服务器运行 npm run admin:setup",
      503,
    );
  const fingerprint = bootstrapFingerprint();
  const existing = await db.adminCredential.findUnique({
    where: { id: ADMIN_ID },
  });
  if (!existing)
    return db.adminCredential.create({
      data: {
        id: ADMIN_ID,
        username: process.env.ADMIN_USERNAME!,
        passwordHash: process.env.ADMIN_PASSWORD_HASH!,
        bootstrapFingerprint: fingerprint,
        mustChangePassword: true,
      },
    });
  if (existing.bootstrapFingerprint !== fingerprint)
    return db.adminCredential.update({
      where: { id: ADMIN_ID },
      data: {
        username: process.env.ADMIN_USERNAME!,
        passwordHash: process.env.ADMIN_PASSWORD_HASH!,
        bootstrapFingerprint: fingerprint,
        mustChangePassword: true,
        sessionVersion: { increment: 1 },
      },
    });
  return existing;
}

// The installation's original account retains exclusive account-creation rights.
export const canCreateAdministrators = (admin: { id: number }) =>
  admin.id === ADMIN_ID;

export async function currentAdmin() {
  if (!adminBootstrapConfigured()) return null;
  const session = readAdminSession((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!session) return null;
  await ensureAdminRecord();
  const admin = await db.adminCredential.findUnique({
    where: { id: session.adminId },
  });
  if (
    !admin ||
    !admin.isActive ||
    admin.mustChangePassword ||
    admin.sessionVersion !== session.sessionVersion
  )
    return null;
  return admin;
}

export async function isAdmin() {
  return !!(await currentAdmin());
}

export async function requireAdmin() {
  const admin = await currentAdmin();
  if (!admin) throw new AppError("UNAUTHORIZED", "请先登录管理员账号", 401);
  return admin;
}

export async function requireAccountOwner() {
  const admin = await requireAdmin();
  if (!canCreateAdministrators(admin))
    throw new AppError("FORBIDDEN", "只有主管理员可以管理管理员账号", 403);
  return admin;
}

export async function verifyAdminCredentials(
  username: string,
  password: string,
) {
  const owner = await ensureAdminRecord();
  const admin = await db.adminCredential.findUnique({ where: { username } });
  // Perform password hashing even for unknown usernames.
  const passwordValid = await verifyPasswordHash(
    password,
    admin?.passwordHash ?? owner.passwordHash,
  );
  return { admin, valid: !!admin && admin.isActive && passwordValid };
}

const accountSchema = z
  .object({
    username: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{3,32}$/, "账号需为 3–32 位小写字母、数字或下划线"),
    password: z
      .string()
      .min(10, "临时密码至少 10 个字符")
      .max(128, "临时密码最多 128 个字符"),
  })
  .strict();

export async function createAdministrator(input: unknown) {
  const actor = await requireAccountOwner();
  const data = accountSchema.parse(input);
  const owner = await db.adminCredential.findUniqueOrThrow({
    where: { id: ADMIN_ID },
  });
  if (data.username === owner.username.toLowerCase())
    throw new AppError("DUPLICATE_ACCOUNT", "该管理员账号已存在", 409);
  const passwordHash = await hashPassword(data.password);
  try {
    return await db.$transaction(async (tx) => {
      const account = await tx.adminCredential.create({
        data: { username: data.username, passwordHash },
        select: { id: true, username: true, mustChangePassword: true },
      });
      await recordAdminAction(tx, actor, "ADMIN_CREATE", {
        id: String(account.id),
        label: account.username,
      });
      return account;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw new AppError("DUPLICATE_ACCOUNT", "该管理员账号已存在", 409);
    throw e;
  }
}

export async function replaceAdminPassword(
  adminId: number,
  currentHash: string,
  newPassword: string,
) {
  const passwordHash = await hashPassword(newPassword);
  return db.$transaction(async (tx) => {
    const updated = await tx.adminCredential.updateMany({
      where: { id: adminId, passwordHash: currentHash, isActive: true },
      data: {
        passwordHash,
        mustChangePassword: false,
        sessionVersion: { increment: 1 },
      },
    });
    if (!updated.count)
      throw new AppError(
        "PASSWORD_CHANGED",
        "管理员密码已被修改，请重新登录",
        409,
      );
    const admin = await tx.adminCredential.findUniqueOrThrow({
      where: { id: adminId },
    });
    await recordAdminAction(tx, admin, "ADMIN_CHANGE_PASSWORD", {
      id: String(admin.id),
      label: admin.username,
    });
    return admin;
  });
}
