import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors";
import { limitWrite } from "./rate-limit";
import { withRequestBudget } from "./request-budget";
import { errorCategory, requestContext } from "./request-log";
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
  const context = requestContext(req.method, req.nextUrl.pathname);
  return withRequestBudget(async () => {
    const send = (
      payload: unknown,
      status = 200,
      code?: string,
      retryAfter?: number,
      errorType?: string,
    ) => {
      context.finish(status, code, errorType);
      return NextResponse.json(payload, {
        status,
        headers: {
          "Cache-Control": "no-store",
          "X-Request-ID": context.requestId,
          ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
        },
      });
    };
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
      return send({ data: await operation(previous || "") });
    } catch (error) {
      let message = "服务暂时不可用，请稍后重试";
      let status = 503;
      let code = "INTERNAL";
      let retryAfter: number | undefined;
      if (error instanceof ZodError) {
        message = error.issues[0]?.message ?? "输入无效";
        status = 400;
        code = "VALIDATION";
      } else if (error instanceof AppError) {
        message = error.message;
        status = error.status;
        code = error.code;
        retryAfter = error.retryAfter;
      } else if (error instanceof SyntaxError) {
        message = "请求内容格式无效";
        status = 400;
        code = "INVALID_JSON";
      }
      return send(
        { error: message, code, requestId: context.requestId },
        status,
        code,
        retryAfter,
        code === "INTERNAL" ? errorCategory(error) : undefined,
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
