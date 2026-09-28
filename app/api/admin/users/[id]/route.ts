import { NextRequest } from "next/server";
import { requireAdmin } from "@/server/admin";
import { body, respond } from "@/server/http";
import { manageUser } from "@/server/user-accounts";
import { limiter } from "@/server/rate-limit";
export const PATCH = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) =>
  respond(
    req,
    async () => {
      const admin = await requireAdmin();
      const id = (await context.params).id;
      const input = await body(req);
      if (
        input &&
        typeof input === "object" &&
        "action" in input &&
        input.action === "reset"
      ) {
        limiter.take("user-reset:global", 120);
        limiter.take(`user-reset:admin:${admin.id}`, 20);
        limiter.take(`user-reset:target:${id}`, 5);
      }
      return manageUser(id, input, admin);
    },
    false,
  );
