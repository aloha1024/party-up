import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { cancelReservation } from "@/server/reservations";
import { currentAdmin } from "@/server/admin";
export const POST = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(req, async (token) =>
    cancelReservation(
      (await context.params).id,
      await body(req),
      token,
      await currentAdmin(),
    ),
  );
