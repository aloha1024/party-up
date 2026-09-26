import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { currentAdmin } from "@/server/admin";
import { removeRosterEntry } from "@/server/reservations";
import { removalQuery, rosterRemovals } from "@/server/roster-removals";
type Context = { params: Promise<{ id: string }> };
export const POST = (req: NextRequest, context: Context) =>
  respond(req, async (token) =>
    removeRosterEntry(
      (await context.params).id,
      await body(req),
      token,
      await currentAdmin(),
    ),
  );
export const GET = (req: NextRequest, context: Context) =>
  respond(
    req,
    async (token) => {
      const query = removalQuery(req.nextUrl.searchParams);
      const { items, nextBefore } = await rosterRemovals(
        (await context.params).id,
        token,
        await currentAdmin(),
        query.before,
        query.expectedScope,
      );
      return { items, nextBefore };
    },
    false,
  );
