import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { currentViewer, respond } from "@/server/http";
import { publicViewer } from "@/server/user-identity";
import { AppError } from "@/server/errors";
export const GET = (req: NextRequest) =>
  respond(req, async () => publicViewer(await currentViewer()), false);
export const POST = (req: NextRequest) =>
  respond(
    req,
    async () => {
      const viewer = await currentViewer();
      if (viewer.mode === "invalid" || viewer.user?.mustChangePassword)
        throw new AppError(
          "USER_SESSION",
          "请登录或退出账号后使用游客模式",
          401,
        );
      if (!viewer.token)
        (await cookies()).set(
          "party_identity",
          randomBytes(32).toString("hex"),
          {
            httpOnly: true,
            secure: req.nextUrl.protocol === "https:",
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24 * 365,
          },
        );
      return publicViewer(await currentViewer());
    },
    false,
  );
