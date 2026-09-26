import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { currentAdmin } from "@/server/admin";
import {
  currentInvitation,
  rotateInvitation,
} from "@/server/reservation-invitations";
type Context = { params: Promise<{ id: string }> };
export const GET = (req: NextRequest, context: Context) =>
  respond(
    req,
    async (token) =>
      currentInvitation((await context.params).id, token, await currentAdmin()),
    false,
  );
export const POST = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    rotateInvitation(
      (await context.params).id,
      await body(req),
      token,
      await currentAdmin(),
    ),
  );
