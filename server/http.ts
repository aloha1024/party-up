import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./reservations";
const cookieName = "party_identity";
export async function identity() {
  return (await cookies()).get(cookieName)?.value;
}
export async function respond(
  req: NextRequest,
  operation: (token: string) => Promise<unknown>,
  withIdentity = true,
) {
  try {
    if (req.method !== "GET" && !isSameOrigin(req))
      throw new AppError("ORIGIN", "请求来源无效，请刷新页面重试", 403);
    const previous = await identity();
    const token = previous || randomBytes(32).toString("hex");
    const response = NextResponse.json(
      { data: await operation(token) },
      { headers: { "Cache-Control": "no-store" } },
    );
    if (withIdentity && !previous && req.method !== "GET")
      response.cookies.set(cookieName, token, {
        httpOnly: true,
        secure: req.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
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
        { status: error.status },
      );
    if (error instanceof SyntaxError)
      return NextResponse.json({ error: "请求内容格式无效" }, { status: 400 });
    console.error("Reservation request failed", error);
    return NextResponse.json(
      { error: "服务暂时不可用，请稍后重试" },
      { status: 503 },
    );
  }
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
export async function body(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 16000) throw new AppError("TOO_LARGE", "请求内容过长", 413);
  return JSON.parse(raw);
}
