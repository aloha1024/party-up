import { NextRequest } from "next/server";
import { requireAdmin } from "@/server/admin";
import { respond } from "@/server/http";
import { listUsers } from "@/server/user-accounts";
import { AppError } from "@/server/errors";
export const GET = (req: NextRequest) =>
  respond(
    req,
    async () => {
      await requireAdmin();
      if (
        ["q", "page"].some((k) => req.nextUrl.searchParams.getAll(k).length > 1)
      )
        throw new AppError("VALIDATION", "查询参数重复", 400);
      return listUsers(Object.fromEntries(req.nextUrl.searchParams));
    },
    false,
  );
