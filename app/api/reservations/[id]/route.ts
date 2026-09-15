import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { detail, editReservation } from "@/server/reservations";
import { isAdmin } from "@/server/admin";
export const GET = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) => respond(req, async (token) => detail((await context.params).id, token));
export const PATCH = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(req, async (token) =>
    editReservation(
      (await context.params).id,
      await body(req),
      token,
      await isAdmin(),
    ),
  );
