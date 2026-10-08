import { NextRequest } from "next/server";
import { respond } from "./http";
import { AppError } from "./errors";
import { requireUser } from "./user-accounts";
import type { Viewer } from "./user-identity";

export function respondTemplates(
  req: NextRequest,
  run: (viewer: Viewer) => Promise<unknown>,
) {
  return respond(
    req,
    async (_token, viewer) => {
      requireUser(viewer);
      if (
        req.method !== "GET" &&
        req.headers.get("x-identity-scope") !== viewer.scope
      )
        throw new AppError("IDENTITY_CHANGED", "账号身份已变化，请刷新", 409);
      return run(viewer);
    },
    false,
  );
}
