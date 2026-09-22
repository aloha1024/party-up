import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors";
import { limitWrite } from "./rate-limit";
import { withRequestBudget } from "./request-budget";
import { readJsonBody } from "./request-body";
const cookieName = "party_identity";
export async function identity() {
  const token = (await cookies()).get(cookieName)?.value;
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export async function respond(
  req: NextRequest,
  operation: (token: string) => Promise<unknown>,
  withIdentity = true,
) {
  return withRequestBudget(async () => {
    try {
      if (req.method !== "GET" && !isSameOrigin(req))
        throw new AppError("ORIGIN", "请求来源无效，请刷新页面重试", 403);
      const previous = await identity();
      if (req.method !== "GET")
        limitWrite(req.headers, req.nextUrl.pathname, previous);
      if (withIdentity && req.method !== "GET" && !previous)
        throw new AppError(
          "IDENTITY_REQUIRED",
          "请先建立浏览器报名身份后再提交",
          428,
        );
      const token = previous || "";
      const response = NextResponse.json(
        { data: await operation(token) },
        { headers: { "Cache-Control": "no-store" } },
      );
      return response;
    } catch (error) {
      if (error instanceof ZodError)
        return NextResponse.json(
          { error: error.issues[0]?.message ?? "输入无效" },
          { status: 400 },
        );
      if (error instanceof AppError)
        return NextResponse.json(
          { error: error.message, code: error.code },
          {
            status: error.status,
            headers: {
              "Cache-Control": "no-store",
              ...(error.retryAfter
                ? { "Retry-After": String(error.retryAfter) }
                : {}),
            },
          },
        );
      if (error instanceof SyntaxError)
        return NextResponse.json(
          { error: "请求内容格式无效" },
          { status: 400 },
        );
      console.error("Reservation request failed", error);
      return NextResponse.json(
        { error: "服务暂时不可用，请稍后重试" },
        { status: 503 },
      );
    }
  });
}
function isSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    // Next's internal URL may use the listening address (0.0.0.0).
    // Host is the actual browser destination; do not trust forwarded-host.
    return (
      parsed.host === req.headers.get("host") &&
      parsed.protocol === req.nextUrl.protocol
    );
  } catch {
    return false;
  }
}
export const body = readJsonBody;
