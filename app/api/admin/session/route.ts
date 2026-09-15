import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { z } from "zod";
import { body, respond } from "@/server/http";
import { AppError } from "@/server/reservations";
import {
  ADMIN_COOKIE,
  SESSION_SECONDS,
  adminConfigured,
  allowLoginAttempt,
  createAdminSession,
  verifyCredentials,
} from "@/server/admin-auth";
export const POST = (req: NextRequest) =>
  respond(
    req,
    async () => {
      if (!adminConfigured())
        throw new AppError(
          "NOT_CONFIGURED",
          "管理员尚未配置，请在服务器运行 npm run admin:setup",
          503,
        );
      if (!allowLoginAttempt())
        throw new AppError(
          "RATE_LIMIT",
          "登录尝试过于频繁，请一分钟后重试",
          429,
        );
      const { username, password } = z
        .object({
          username: z.string().trim().min(1).max(64),
          password: z.string().min(1).max(256),
        })
        .parse(await body(req));
      if (!(await verifyCredentials(username, password)))
        throw new AppError("INVALID_LOGIN", "账号或密码错误", 401);
      (await cookies()).set(ADMIN_COOKIE, createAdminSession(), {
        httpOnly: true,
        sameSite: "strict",
        secure: req.nextUrl.protocol === "https:",
        path: "/",
        maxAge: SESSION_SECONDS,
      });
      return { ok: true };
    },
    false,
  );
export const DELETE = (req: NextRequest) =>
  respond(
    req,
    async () => {
      (await cookies()).set(ADMIN_COOKIE, "", {
        httpOnly: true,
        sameSite: "strict",
        secure: req.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 0,
      });
      return { ok: true };
    },
    false,
  );
