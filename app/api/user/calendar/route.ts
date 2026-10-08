import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import {
  calendarSettings,
  rotateCalendar,
  revokeCalendar,
} from "@/server/calendar-subscription";
import { viewerContext } from "@/server/user-identity";
import { AppError } from "@/server/errors";

const route = (req: NextRequest) =>
  respond(
    req,
    async (_token, viewer) => {
      if (req.method === "GET") return calendarSettings(viewer);
      if (req.headers.get("x-identity-scope") !== viewer.scope)
        throw new AppError("IDENTITY_CHANGED", "账号身份已变化，请刷新", 409);
      const input = await body(req);
      return viewerContext.run(viewer, () =>
        req.method === "POST"
          ? rotateCalendar(viewer, input)
          : revokeCalendar(viewer, input),
      );
    },
    false,
  );
export const GET = route;
export const POST = route;
export const DELETE = route;
