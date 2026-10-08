import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import {
  listNotifications,
  markNotificationsRead,
  notificationSearchParams,
} from "@/server/notifications";

export const runtime = "nodejs";
export const GET = (req: NextRequest) =>
  respond(req, (token) =>
    listNotifications(
      token,
      notificationSearchParams(req.nextUrl.searchParams),
    ),
  );
export const PATCH = (req: NextRequest) =>
  respond(req, async (token) => markNotificationsRead(token, await body(req)));
