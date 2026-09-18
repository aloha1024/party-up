import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { createAdministrator } from "@/server/admin";

export const POST = (req: NextRequest) =>
  respond(
    req,
    async () => {
      return createAdministrator(await body(req));
    },
    false,
  );
