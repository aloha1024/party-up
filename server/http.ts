import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors";
import { limitWrite } from "./rate-limit";
import { withRequestBudget } from "./request-budget";
import { errorDiagnostics, requestContext } from "./request-log";
import { withRequestMetrics } from "./request-metrics";
import { readJsonBody } from "./request-body";
import {
  resolveViewer,
  viewerContext,
  USER_COOKIE,
  GUEST_COOKIE,
  type Viewer,
} from "./user-identity";
export async function identity() {
  const v = await currentViewer();
  return v.mode === "user" && v.user?.mustChangePassword ? undefined : v.token;
}
export async function currentViewer() {
  const jar = await cookies();
  return resolveViewer(
    jar.get(USER_COOKIE)?.value,
    jar.get(GUEST_COOKIE)?.value,
  );
}
export async function respond(
  req: NextRequest,
  operation: (token: string, viewer: Viewer) => Promise<unknown>,
  withIdentity = true,
) {
  const context = requestContext(req.method, req.nextUrl.pathname);
  return withRequestMetrics(() =>
    withRequestBudget(async () => {
      const send = (
        payload: unknown,
        status = 200,
        code?: string,
        retryAfter?: number,
        diagnostic?: ReturnType<typeof errorDiagnostics>,
      ) => {
        context.finish(status, code, diagnostic);
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
        const viewer = await currentViewer();
        const previous = viewer.user?.mustChangePassword
          ? undefined
          : viewer.token;
        const businessWrite =
          req.method !== "GET" &&
          (req.nextUrl.pathname.startsWith("/api/reservations") ||
            req.nextUrl.pathname === "/api/notifications");
        if (businessWrite) {
          if (viewer.mode === "invalid" || viewer.user?.mustChangePassword)
            throw new AppError(
              "USER_SESSION",
              "请重新登录并完成改密，或退出后使用游客模式",
              401,
            );
          if (req.headers.get("x-identity-scope") !== viewer.scope)
            throw new AppError(
              "IDENTITY_CHANGED",
              "页面身份已变化，请刷新后重新确认操作",
              409,
            );
        }
        if (req.method !== "GET")
          limitWrite(req.headers, req.nextUrl.pathname, previous);
        if (withIdentity && req.method !== "GET" && !previous)
          throw new AppError(
            "IDENTITY_REQUIRED",
            "请先建立浏览器报名身份后再提交",
            428,
          );
        return send({
          data: await (businessWrite
            ? viewerContext.run(viewer, () => operation(previous || "", viewer))
            : operation(previous || "", viewer)),
        });
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
          code === "INTERNAL" ? errorDiagnostics(error) : undefined,
        );
      }
    }),
  );
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
