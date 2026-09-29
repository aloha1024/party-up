import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { body, respond } from "@/server/http";
import {
  USER_COOKIE,
  USER_SECONDS,
  publicViewer,
  digest,
  resolveViewer,
} from "@/server/user-identity";
import { db } from "@/server/db";
import {
  registerUser,
  loginUser,
  updateProfile,
  changeUserPassword,
  rotateRecovery,
  recoverUser,
  revokeUserSessions,
} from "@/server/user-accounts";
import { previewGuestClaim, claimGuestRecords } from "@/server/guest-claims";
import { limiter, requestSource } from "@/server/rate-limit";
import { AppError } from "@/server/errors";
import { listUserSessions, revokeUserSession } from "@/server/user-sessions";
type Context = { params: Promise<{ action: string[] }> };
async function route(req: NextRequest, context: Context) {
  return respond(
    req,
    async (_token, viewer) => {
      const segments = (await context.params).action;
      const action = segments.join("/"),
        method = req.method;
      const singleSession =
        method === "DELETE" &&
        segments.length === 2 &&
        segments[0] === "sessions" &&
        segments[1] !== "all";
      const rateAction = singleSession ? "sessions/revoke" : action;
      const jar = await cookies();
      if (method === "GET") {
        if (action === "session") return publicViewer(viewer);
        if (action === "guest-claims") return previewGuestClaim(viewer);
        if (action === "sessions") {
          const pages = req.nextUrl.searchParams.getAll("page");
          return listUserSessions(viewer, pages.length > 1 ? pages : pages[0]);
        }
        throw new AppError("NOT_FOUND", "接口不存在", 404);
      }
      if (
        !singleSession &&
        ![
          "POST register",
          "POST session",
          "DELETE session",
          "PATCH profile",
          "POST password",
          "POST recovery",
          "POST recovery/reset",
          "DELETE sessions/all",
          "POST guest-claims",
        ].includes(`${method} ${action}`)
      )
        throw new AppError("NOT_FOUND", "接口不存在", 404);
      const input = method === "DELETE" ? {} : await body(req);
      const source = requestSource(req.headers);
      limiter.take(`user:${rateAction}:global`, 120);
      if (source)
        limiter.take(`user:${rateAction}:source:${digest(source)}`, 20);
      const username =
        input &&
        typeof input === "object" &&
        "username" in input &&
        typeof input.username === "string"
          ? input.username.trim().toLowerCase()
          : viewer.user?.username;
      if (username)
        limiter.take(
          `user:${rateAction}:account:${digest(username)}`,
          action === "session" ? 20 : 5,
        );
      const publicAction =
        method === "POST" &&
        ["register", "session", "recovery/reset"].includes(action);
      if (!publicAction && req.headers.get("x-identity-scope") !== viewer.scope)
        throw new AppError("IDENTITY_CHANGED", "账号身份已变化，请刷新", 409);
      const setSession = (token: string) =>
        jar.set(USER_COOKIE, token, {
          httpOnly: true,
          secure: req.nextUrl.protocol === "https:",
          sameSite: "lax",
          path: "/",
          maxAge: USER_SECONDS,
        });
      if (action === "register" && method === "POST") {
        if (viewer.mode === "user")
          throw new AppError(
            "ALREADY_LOGGED_IN",
            "请先退出当前账号再注册",
            409,
          );
        const { token, recoveryCode } = await registerUser(
          input,
          req.headers.get("user-agent"),
        );
        setSession(token);
        return {
          recoveryCode,
          identity: publicViewer(await resolveViewer(token, viewer.guestToken)),
        };
      }
      if (action === "session" && method === "POST") {
        const { token, mustChangePassword } = await loginUser(
          input,
          req.headers.get("user-agent"),
        );
        if (viewer.sessionHash)
          await db.userSession.deleteMany({
            where: { id: viewer.sessionHash },
          });
        setSession(token);
        return {
          mustChangePassword,
          identity: publicViewer(await resolveViewer(token, viewer.guestToken)),
        };
      }
      if (action === "session" && method === "DELETE") {
        if (viewer.sessionHash)
          await db.userSession.deleteMany({
            where: { id: viewer.sessionHash },
          });
        jar.delete(USER_COOKIE);
        return { loggedOut: true };
      }
      if (action === "profile" && method === "PATCH")
        return updateProfile(viewer, input);
      if (action === "password" && method === "POST") {
        const result = await changeUserPassword(viewer, input);
        jar.delete(USER_COOKIE);
        return result;
      }
      if (action === "recovery" && method === "POST")
        return rotateRecovery(viewer, input);
      if (action === "recovery/reset" && method === "POST") {
        const result = await recoverUser(input);
        jar.delete(USER_COOKIE);
        return {
          ...result,
          identity: publicViewer(
            await resolveViewer(undefined, viewer.guestToken),
          ),
        };
      }
      if (action === "sessions/all" && method === "DELETE") {
        const result = await revokeUserSessions(viewer);
        jar.delete(USER_COOKIE);
        return result;
      }
      if (singleSession) {
        const result = await revokeUserSession(viewer, segments[1]);
        if (result.current) jar.delete(USER_COOKIE);
        return result;
      }
      if (action === "guest-claims" && method === "POST")
        return claimGuestRecords(viewer, input);
      throw new AppError("NOT_FOUND", "接口不存在", 404);
    },
    false,
  );
}
export const GET = route;
export const POST = route;
export const PATCH = route;
export const DELETE = route;
