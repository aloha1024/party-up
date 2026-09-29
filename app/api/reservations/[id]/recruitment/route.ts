import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { currentAdmin } from "@/server/admin";
import { setRecruitment } from "@/server/reservations";

type Context = { params: Promise<{ id: string }> };
export const PATCH = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    setRecruitment(
      (await context.params).id,
      await body(req),
      token,
      await currentAdmin(),
    ),
  );
