import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { requireAdmin, revokeAdminSessions } from "@/server/admin";
import { ADMIN_COOKIE } from "@/server/admin-auth";
export const DELETE = (req: NextRequest) =>
  respond(
    req,
    async () => {
      await revokeAdminSessions(await requireAdmin());
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
