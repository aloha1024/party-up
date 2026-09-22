import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { listAdminAudit } from "@/server/admin-audit-list";
export const GET = (req: NextRequest) =>
  respond(
    req,
    async () => {
      const input: Record<string, string | string[]> = {};
      for (const key of ["q", "action", "page"]) {
        const values = req.nextUrl.searchParams.getAll(key);
        if (values.length)
          input[key] = values.length === 1 ? values[0] : values;
      }
      return listAdminAudit(input);
    },
    false,
  );
