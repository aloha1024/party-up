import { z } from "zod";
import { NextRequest } from "next/server";
import { body, respond } from "@/server/http";
import { createReservation } from "@/server/reservations";
import { listReservations } from "@/server/reservation-list";
import { listSearchParams } from "@/lib/reservation-list";
export const runtime = "nodejs";
export const GET = (req: NextRequest) =>
  respond(
    req,
    () => listReservations(listSearchParams(req.nextUrl.searchParams)),
    false,
  );
export const POST = (req: NextRequest) =>
  respond(req, async (token) => {
    const key = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{16,100}$/, "缺少有效的提交编号，请刷新页面")
      .parse(req.headers.get("idempotency-key"));
    return createReservation(await body(req), token, key);
  });
