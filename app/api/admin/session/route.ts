import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { z } from "zod";
import { body, respond } from "@/server/http";
import { AppError } from "@/server/reservations";
import {
  requireAdmin,
  replaceAdminPassword,
  verifyAdminCredentials,
} from "@/server/admin";
import {
  ADMIN_COOKIE,
  SESSION_SECONDS,
  allowLoginAttempt,
  createAdminSession,
  verifyPasswordHash,
} from "@/server/admin-auth";

const passwordSchema = z
  .string()
  .min(10, "新密码至少需要 10 个字符")
  .max(128, "新密码最多 128 个字符");
const cookieOptions = (req: NextRequest) => ({
  httpOnly: true as const,
  sameSite: "strict" as const,
  secure: req.nextUrl.protocol === "https:",
  path: "/",
  maxAge: SESSION_SECONDS,
});

export const POST = (req: NextRequest) =>
  respond(
    req,
    async () => {
      if (!allowLoginAttempt())
        throw new AppError(
          "RATE_LIMIT",
          "登录尝试过于频繁，请一分钟后重试",
          429,
        );
      const input = z
        .object({
          username: z.string().trim().min(1).max(64),
          password: z.string().min(1).max(256),
          newPassword: passwordSchema.optional(),
        })
        .parse(await body(req));
      const { admin, valid } = await verifyAdminCredentials(
        input.username,
        input.password,
      );
      if (!valid) throw new AppError("INVALID_LOGIN", "账号或密码错误", 401);
      if (admin.mustChangePassword && !input.newPassword)
        return { requiresPasswordChange: true };
      if (
        admin.mustChangePassword &&
        (await verifyPasswordHash(input.newPassword!, admin.passwordHash))
      )
        throw new AppError("SAME_PASSWORD", "新密码不能与临时密码相同", 400);
      const authenticated = admin.mustChangePassword
        ? await replaceAdminPassword(admin.passwordHash, input.newPassword!)
        : admin;
      (await cookies()).set(
        ADMIN_COOKIE,
        createAdminSession(authenticated.sessionVersion),
        cookieOptions(req),
      );
      return { ok: true, requiresPasswordChange: false };
    },
    false,
  );

export const PATCH = (req: NextRequest) =>
  respond(
    req,
    async () => {
      const admin = await requireAdmin();
      const input = z
        .object({
          currentPassword: z.string().min(1).max(256),
          newPassword: passwordSchema,
        })
        .parse(await body(req));
      if (
        !(await verifyPasswordHash(input.currentPassword, admin.passwordHash))
      )
        throw new AppError("INVALID_PASSWORD", "当前密码错误", 401);
      if (await verifyPasswordHash(input.newPassword, admin.passwordHash))
        throw new AppError("SAME_PASSWORD", "新密码不能与当前密码相同", 400);
      const updated = await replaceAdminPassword(
        admin.passwordHash,
        input.newPassword,
      );
      (await cookies()).set(
        ADMIN_COOKIE,
        createAdminSession(updated.sessionVersion),
        cookieOptions(req),
      );
      return { ok: true };
    },
    false,
  );

export const DELETE = (req: NextRequest) =>
  respond(
    req,
    async () => {
      (await cookies()).set(ADMIN_COOKIE, "", {
        ...cookieOptions(req),
        maxAge: 0,
      });
      return { ok: true };
    },
    false,
  );
