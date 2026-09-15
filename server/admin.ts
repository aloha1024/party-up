import { cookies } from "next/headers";
import { db } from "./db";
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

export async function isAdmin() {
  if (!adminBootstrapConfigured()) return false;
  const session = readAdminSession((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!session) return false;
  const admin = await ensureAdminRecord();
  return (
    !admin.mustChangePassword && admin.sessionVersion === session.sessionVersion
  );
}

export async function requireAdmin() {
  if (!(await isAdmin()))
    throw new AppError("UNAUTHORIZED", "请先登录管理员账号", 401);
  return db.adminCredential.findUniqueOrThrow({ where: { id: ADMIN_ID } });
}

export async function verifyAdminCredentials(
  username: string,
  password: string,
) {
  const admin = await ensureAdminRecord();
  return {
    admin,
    valid:
      username === admin.username &&
      (await verifyPasswordHash(password, admin.passwordHash)),
  };
}

export async function replaceAdminPassword(
  currentHash: string,
  newPassword: string,
) {
  const passwordHash = await hashPassword(newPassword);
  const updated = await db.adminCredential.updateMany({
    where: { id: ADMIN_ID, passwordHash: currentHash },
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
  return db.adminCredential.findUniqueOrThrow({ where: { id: ADMIN_ID } });
}
