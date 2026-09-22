import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { identity, respond } from "@/server/http";
export const GET = (req: NextRequest) =>
  respond(req, async () => ({ ready: !!(await identity()) }), false);
export const POST = (req: NextRequest) =>
  respond(
    req,
    async () => {
      if (!(await identity()))
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
      return { ready: true };
    },
    false,
  );
