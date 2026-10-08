import { NextRequest, NextResponse } from "next/server";
import { calendarFeed } from "@/server/calendar-subscription";
import { subscriptionCalendar } from "@/lib/reservation-calendar";
import { withRequestBudget } from "@/server/request-budget";
import { withRequestMetrics } from "@/server/request-metrics";
import { errorDiagnostics, requestContext } from "@/server/request-log";
import { limiter, requestSource } from "@/server/rate-limit";
import { digest } from "@/server/user-identity";
import { AppError } from "@/server/errors";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const log = requestContext("GET", "/api/calendar");
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Request-ID": log.requestId,
  };
  return withRequestMetrics(() =>
    withRequestBudget(async () => {
      try {
        limiter.take("calendar:global", 300);
        const source = requestSource(req.headers);
        if (source) limiter.take("calendar:source:" + digest(source), 60);
        const params = req.nextUrl.searchParams;
        if (
          [...params.keys()].some((key) => key !== "token") ||
          params.getAll("token").length !== 1
        )
          throw new AppError("VALIDATION", "订阅参数无效", 400);
        const token = params.get("token")!;
        if (/^[a-f0-9]{64}$/.test(token))
          limiter.take("calendar:token:" + digest(token), 30);
        const data = await calendarFeed(token);
        // Use the requested host, never forwarded-host or a submitted URL.
        const origin = new URL(
          req.nextUrl.protocol +
            "//" +
            (req.headers.get("host") || req.nextUrl.host),
        ).origin;
        const content = subscriptionCalendar(data, origin);
        log.finish(200);
        return new NextResponse(content, {
          headers: {
            ...headers,
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'inline; filename="party-up.ics"',
          },
        });
      } catch (error) {
        const known = error instanceof AppError;
        const status = known ? error.status : 503;
        log.finish(
          status,
          known ? error.code : "INTERNAL",
          known ? undefined : errorDiagnostics(error),
        );
        return NextResponse.json(
          {
            error: known ? error.message : "服务暂时不可用，请稍后重试",
            code: known ? error.code : "INTERNAL",
            requestId: log.requestId,
          },
          {
            status,
            headers: {
              ...headers,
              ...(known && error.retryAfter
                ? { "Retry-After": String(error.retryAfter) }
                : {}),
            },
          },
        );
      }
    }),
  );
}
