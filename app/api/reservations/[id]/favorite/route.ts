import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { requireUser } from "@/server/user-accounts";
import { setFavorite } from "@/server/reservation-favorites";

type Context = { params: Promise<{ id: string }> };
export const POST = (req: NextRequest, context: Context) =>
  respond(
    req,
    async (_token, viewer) => {
      requireUser(viewer);
      return setFavorite(viewer, (await context.params).id, true);
    },
    false,
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respond(
    req,
    async (_token, viewer) => {
      requireUser(viewer);
      return setFavorite(viewer, (await context.params).id, false);
    },
    false,
  );
