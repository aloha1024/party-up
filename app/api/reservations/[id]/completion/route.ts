import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { currentAdmin } from "@/server/admin";
import { setCompletion } from "@/server/reservation-attendance";
type Context = { params: Promise<{ id: string }> };
export const POST = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    setCompletion(
      (await context.params).id,
      await body(req),
      token,
      true,
      await currentAdmin(),
    ),
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    setCompletion(
      (await context.params).id,
      await body(req),
      token,
      false,
      await currentAdmin(),
    ),
  );
