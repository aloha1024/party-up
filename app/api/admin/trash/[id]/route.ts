import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { requireAdmin } from "@/server/admin";
import { restoreReservation, purgeReservation } from "@/server/reservations";
type Context = { params: Promise<{ id: string }> };
export const POST = (req: NextRequest, context: Context) =>
  respond(
    req,
    async () => {
      await requireAdmin();
      await restoreReservation((await context.params).id);
      return { ok: true };
    },
    false,
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respond(
    req,
    async () => {
      await requireAdmin();
      await purgeReservation((await context.params).id);
      return { ok: true };
    },
    false,
  );
