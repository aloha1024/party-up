import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { acceptInvitation } from "@/server/reservation-invitations";
export const POST = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(req, async (token) =>
    acceptInvitation((await context.params).id, await body(req), token),
  );
