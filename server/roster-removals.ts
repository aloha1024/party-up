import { requireReservationAccess } from "./reservation-access";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { db } from "./db";
import { AppError } from "./errors";
import { historyCursor } from "./reservation-history";
import { remainingBudget } from "./request-budget";
import { measureTransaction } from "./request-metrics";
import { removalItemSchema } from "../lib/roster-management";

type ViewerAdmin = { id: number; sessionVersion: number } | null;
const state = globalThis as typeof globalThis & { removalScopeSecret?: string };
const fallbackSecret = (state.removalScopeSecret ??=
  randomBytes(32).toString("hex"));

export function removalQuery(params: URLSearchParams) {
  const scopes = params.getAll("scope");
  if (
    scopes.length > 1 ||
    (scopes.length === 1 && !/^[a-f0-9]{64}$/.test(scopes[0]))
  )
    throw new AppError("VALIDATION", "查看范围参数无效", 400);
  return { before: historyCursor(params), expectedScope: scopes[0] };
}

// Scope tokens are keyed, reservation-specific render keys, never identities or
// authorization credentials. Every read independently verifies its viewer.
export async function rosterRemovals(
  id: string,
  token?: string,
  admin: ViewerAdmin = null,
  before?: number,
  expectedScope?: string,
) {
  const validToken = token && /^[a-f0-9]{64}$/.test(token) ? token : "";
  const hash = validToken
    ? createHash("sha256").update(validToken).digest("hex")
    : "";
  const budget = Math.floor(remainingBudget());
  if (budget < 2) throw new AppError("BUSY", "服务繁忙，请稍后重试", 503);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const r = await tx.gameReservation.findUnique({
          where: { id, deletedAt: null },
        });
        if (!r) throw new AppError("NOT_FOUND", "预约不存在或已被移除", 404);
        await requireReservationAccess(tx, r, token, !!admin);
        const all = !!admin || (!!hash && hash === r.hostTokenHash);
        const scope = createHmac(
          "sha256",
          process.env.ADMIN_SESSION_SECRET || fallbackSecret,
        )
          .update(
            JSON.stringify([
              "roster-removals",
              id,
              validToken,
              all,
              admin?.id,
              admin?.sessionVersion,
            ]),
          )
          .digest("hex");
        if (expectedScope && expectedScope !== scope)
          throw new AppError(
            "VIEWER_CHANGED",
            "查看权限已变化，请刷新页面",
            409,
          );
        const rows =
          !all && !hash
            ? []
            : await tx.rosterRemoval.findMany({
                where: {
                  reservationId: id,
                  ...(!all ? { targetTokenHash: hash } : {}),
                  ...(before === undefined ? {} : { id: { lt: before } }),
                },
                select: {
                  id: true,
                  kind: true,
                  targetName: true,
                  reason: true,
                  actorRole: true,
                  createdAt: true,
                },
                orderBy: { id: "desc" },
                take: 11,
              });
        const items = rows.slice(0, 10).map((r) =>
          removalItemSchema.parse({
            ...r,
            createdAt: r.createdAt.toISOString(),
          }),
        );
        return {
          items,
          nextBefore: rows.length > 10 ? items.at(-1)!.id : null,
          scope,
        };
      },
      {
        maxWait: Math.max(1, Math.min(1000, Math.floor(budget / 4))),
        timeout: Math.max(1, Math.min(3000, Math.floor(budget * 0.7))),
      },
    ),
  );
}
