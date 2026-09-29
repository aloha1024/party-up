"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import {
  getClientIdentity,
  getClientIdentityRevision,
  notifyIdentityChanged,
} from "../lib/client-identity";

const sessionSchema = z.object({
  id: z.string().uuid(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
const pageSchema = z.object({
  items: z.array(sessionSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  pageSize: z.literal(20),
});
const revokedSchema = z.object({
  revoked: z.literal(true),
  current: z.boolean(),
});
type Session = z.infer<typeof sessionSchema>;
type SessionPage = z.infer<typeof pageSchema>;
type Pending = "load" | "revoke" | null;
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function UserSessions({
  scope,
  onPendingChange,
}: {
  scope: string;
  onPendingChange: (pending: boolean) => void;
}) {
  const [listing, setListing] = useState<SessionPage>();
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const busy = useRef(false);
  const generation = useRef(0);

  const perform = useCallback(
    async (
      kind: Exclude<Pending, null>,
      action: (isCurrent: () => boolean) => Promise<void>,
    ) => {
      if (!mounted.current || busy.current) return;
      const run = ++generation.current;
      const revision = getClientIdentityRevision();
      const isCurrent = () =>
        mounted.current &&
        generation.current === run &&
        getClientIdentity()?.scope === scope &&
        getClientIdentityRevision() === revision;
      if (!isCurrent()) return;
      busy.current = true;
      setPending(kind);
      onPendingChange(true);
      setError("");
      setMessage("");
      try {
        if (!navigator.onLine)
          throw new Error("当前离线，请联网后手动核对登录列表");
        await action(isCurrent);
      } catch (e) {
        if (isCurrent())
          setError(
            e instanceof Error ? e.message : "操作失败，请手动刷新登录列表",
          );
      } finally {
        if (isCurrent()) {
          busy.current = false;
          setPending(null);
          onPendingChange(false);
        }
      }
    },
    [scope, onPendingChange],
  );
  const readPage = useCallback(
    async (page: number, isCurrent: () => boolean) => {
      const next = await request(
        `/api/user/sessions?page=${page}`,
        "GET",
        undefined,
        {
          schema: pageSchema,
          isCurrent,
        },
      );
      if (isCurrent()) setListing(next);
    },
    [],
  );
  const load = useCallback(
    (page: number) => perform("load", (isCurrent) => readPage(page, isCurrent)),
    [perform, readPage],
  );

  useEffect(() => {
    mounted.current = true;
    setListing(undefined);
    setError("");
    setMessage("");
    void load(1);
    return () => {
      mounted.current = false;
      generation.current++;
      busy.current = false;
      onPendingChange(false);
    };
  }, [load, onPendingChange]);

  function revoke(session: Session) {
    if (busy.current) return;
    if (!navigator.onLine) {
      setError("当前离线，请联网后手动核对登录列表");
      return;
    }
    if (
      !window.confirm(
        [
          session.current ? "确认退出当前登录？" : "确认退出此登录？",
          `${session.browser || "未知浏览器"} · ${session.os || "未知系统"}${session.current ? "（当前登录）" : ""}`,
          session.createdAt
            ? `登录时间：${dateTime.format(new Date(session.createdAt))}（北京时间）`
            : "升级前登录，时间未知",
          session.current ? "退出后需要重新登录。" : "该登录将立即失效。",
        ].join("\n"),
      )
    )
      return;
    void perform("revoke", async (isCurrent) => {
      const result = await request(
        `/api/user/sessions/${encodeURIComponent(session.id)}`,
        "DELETE",
        undefined,
        { schema: revokedSchema, isCurrent },
      );
      if (!isCurrent()) return;
      if (result.current) {
        notifyIdentityChanged();
        window.location.assign("/account/login");
        return;
      }
      setMessage("已退出该登录。");
      await readPage(listing?.page ?? 1, isCurrent);
    });
  }

  return (
    <section
      className="panel space-y-4 p-6"
      aria-label="登录会话"
      aria-busy={!!pending}
    >
      <h2>登录会话</h2>
      <p className="text-sm text-zinc-400">
        显示尚未过期的登录。浏览器和系统名称仅供辨认；时间均为北京时间。
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={!!pending}
        onClick={() => void load(listing?.page ?? 1)}
      >
        刷新登录列表
      </Button>
      {pending && (
        <p role="status">
          {pending === "load" ? "正在加载登录信息…" : "正在退出登录…"}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      {listing && (
        <>
          <p className="text-sm text-zinc-400">共 {listing.total} 个登录</p>
          {!listing.items.length && <p>暂无登录记录，请刷新核对。</p>}
          <ul className="space-y-3">
            {listing.items.map((session) => (
              <li
                key={session.id}
                data-session-id={session.id}
                className="space-y-3 rounded-xl border border-white/10 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words">
                    {session.browser || "未知浏览器"} ·{" "}
                    {session.os || "未知系统"}
                  </span>
                  {session.current && (
                    <span className="rounded bg-lime-300/10 px-2 py-1 text-xs text-lime-300">
                      当前登录
                    </span>
                  )}
                </div>
                <div className="space-y-1 text-sm text-zinc-400">
                  <p>
                    {session.createdAt ? (
                      <>
                        登录时间：
                        <time dateTime={session.createdAt}>
                          {dateTime.format(new Date(session.createdAt))}
                        </time>
                      </>
                    ) : (
                      "升级前登录，时间未知"
                    )}
                  </p>
                  <p>
                    到期时间：
                    <time dateTime={session.expiresAt}>
                      {dateTime.format(new Date(session.expiresAt))}
                    </time>
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!!pending}
                  onClick={() => revoke(session)}
                >
                  {session.current ? "退出当前登录" : "退出此登录"}
                </Button>
              </li>
            ))}
          </ul>
          {listing.pageCount > 1 && (
            <nav
              aria-label="登录会话分页"
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!!pending || listing.page <= 1}
                onClick={() => void load(listing.page - 1)}
              >
                上一页
              </Button>
              <span>
                第 {listing.page} / {listing.pageCount} 页
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!!pending || listing.page >= listing.pageCount}
                onClick={() => void load(listing.page + 1)}
              >
                下一页
              </Button>
            </nav>
          )}
        </>
      )}
      <p className="text-sm text-zinc-400">
        操作失败或结果不明确时不会自动重发，请手动刷新核对。
      </p>
    </section>
  );
}
