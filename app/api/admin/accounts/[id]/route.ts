import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { manageAdministrator } from "@/server/admin-accounts";
export const PATCH = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(
    req,
    async () =>
      manageAdministrator(Number((await context.params).id), await body(req)),
    false,
  );
