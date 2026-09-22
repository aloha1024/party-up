import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { requireAdmin } from "@/server/admin";
import { deleteReservation } from "@/server/reservations";
export const DELETE = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(
    req,
    async () => {
      const actor = await requireAdmin();
      await deleteReservation((await context.params).id, actor);
      return { ok: true };
    },
    false,
  );
