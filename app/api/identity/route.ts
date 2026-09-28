import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import {
  GUEST_COOKIE,
  publicViewer,
  resolveViewer,
} from "@/server/user-identity";
import { AppError } from "@/server/errors";
export const GET = (req: NextRequest) =>
  respond(req, async (_token, viewer) => publicViewer(viewer), false);
export const POST = (req: NextRequest) =>
  respond(
    req,
    async (_token, viewer) => {
      if (viewer.mode === "invalid" || viewer.user?.mustChangePassword)
        throw new AppError(
          "USER_SESSION",
          "请登录或退出账号后使用游客模式",
          401,
        );
      if (viewer.token) return publicViewer(viewer);
      const guestToken = randomBytes(32).toString("hex");
      (await cookies()).set(GUEST_COOKIE, guestToken, {
        httpOnly: true,
        secure: req.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      // Resolve the new credential, rather than reusing the incoming identity.
      return publicViewer(await resolveViewer(undefined, guestToken));
    },
    false,
  );
