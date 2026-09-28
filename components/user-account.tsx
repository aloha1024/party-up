"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import { useIdentity } from "./identity-provider";
import { request } from "../lib/client-request";
import {
  notifyIdentityChanged,
  setClientIdentity,
  newClaimKey,
  bindLegacyGuest,
} from "../lib/client-identity";
import { safeReturnPath, type PublicIdentity } from "../lib/user-account";
import { readSubmission } from "../lib/creation-submission";

function Password({
  name = "password",
  label = "密码",
}: {
  name?: string;
  label?: string;
}) {
  return (
    <label className="block space-y-2">
      <span>{label}</span>
      <input
        className="field"
        name={name}
        type="password"
        autoComplete={
          name === "currentPassword" ? "current-password" : "new-password"
        }
        required
        minLength={10}
        maxLength={128}
      />
    </label>
  );
}
export function UserAccount({
  mode = "account",
  returnTo,
}: {
  mode?: "account" | "login" | "register" | "recover";
  returnTo?: string;
}) {
  const viewer = useIdentity();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [code, setCode] = useState("");
  const navigate = (path = "/account", broadcast = true) => {
    if (broadcast) notifyIdentityChanged();
    window.location.assign(path);
  };
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      if (!navigator.onLine) throw new Error("当前离线，请联网后再操作");
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  function submit(
    e: FormEvent<HTMLFormElement>,
    url: string,
    method = "POST",
    after?: (data: Record<string, unknown>) => void,
  ) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if ("confirmation" in data && data.password !== data.confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    delete data.confirmation;
    void run(async () => {
      const result = await request<Record<string, unknown>>(url, method, data);
      if (result.identity) setClientIdentity(result.identity as PublicIdentity);
      form.reset();
      if (after) after(result);
      else setMessage("已保存");
    });
  }
  const title =
    mode === "register"
      ? "注册账号"
      : mode === "login"
        ? "登录账号"
        : mode === "recover"
          ? "找回密码"
          : "个人账号";
  return (
    <section className="mx-auto max-w-xl">
      <fieldset disabled={!hydrated || pending} className="min-w-0 space-y-6">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="text-sm text-zinc-400">
          游客可公开组局、报名和候补。注册后可跨设备使用、创建邀请预约、再开一局和下载日历。
        </p>
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {code ? (
          <div className="panel space-y-4 p-6">
            <h2>请保存你的恢复码</h2>
            <p className="text-sm text-zinc-400">
              仅展示一次，用于找回账号。请保存在安全位置，不要分享给他人。
            </p>
            <output
              className="block break-all rounded border border-white/20 p-3"
              aria-label="恢复码"
            >
              {code}
            </output>
            <Button onClick={() => navigate("/account", false)}>
              我已保存，进入账号
            </Button>
          </div>
        ) : mode !== "account" ? (
          <form
            method="post"
            className="panel space-y-4 p-6"
            onSubmit={(e) =>
              submit(
                e,
                `/api/user/${mode === "register" ? "register" : mode === "recover" ? "recovery/reset" : "session"}`,
                "POST",
                (data) => {
                  if (mode === "register") {
                    setCode(String(data.recoveryCode));
                    notifyIdentityChanged();
                  } else if (mode === "recover") {
                    setMessage(
                      "密码已重置，旧登录和恢复码已失效。请登录后生成新恢复码。",
                    );
                    notifyIdentityChanged();
                  } else
                    navigate(
                      data.mustChangePassword
                        ? "/account"
                        : returnTo
                          ? safeReturnPath(returnTo)
                          : "/account",
                    );
                },
              )
            }
          >
            <label className="block space-y-2">
              <span>用户名</span>
              <input
                className="field"
                name="username"
                autoComplete="username"
                required
                pattern="[a-zA-Z0-9_]{3,32}"
                maxLength={32}
              />
            </label>
            {mode === "register" && (
              <label className="block space-y-2">
                <span>默认昵称</span>
                <input
                  className="field"
                  name="nickname"
                  required
                  maxLength={24}
                />
              </label>
            )}
            {mode === "recover" && (
              <label className="block space-y-2">
                <span>恢复码</span>
                <input
                  className="field"
                  name="recoveryCode"
                  required
                  autoComplete="off"
                  pattern="[a-f0-9]{64}"
                  maxLength={64}
                />
              </label>
            )}
            <Password label={mode === "recover" ? "新密码" : "密码"} />
            {mode !== "login" && (
              <Password name="confirmation" label="确认密码" />
            )}
            <Button disabled={pending}>{pending ? "正在处理…" : title}</Button>
            <p className="text-sm text-zinc-400">
              操作失败或结果不明确时不会自动重发。忘记恢复码可联系管理员核实后重置。
            </p>
          </form>
        ) : viewer?.mode === "user" ? (
          <>
            <div className="panel space-y-3 p-6">
              <p>账号：{viewer.user?.username}</p>
              <p>默认昵称：{viewer.user?.nickname}</p>
              <p className="text-sm text-zinc-400">
                账号登录与管理员登录相互独立。
              </p>
            </div>
            {viewer.user?.mustChangePassword ? (
              <p role="alert">管理员已重置密码，请先设置正式密码。</p>
            ) : (
              <form
                method="post"
                className="panel space-y-4 p-6"
                onSubmit={(e) =>
                  submit(e, "/api/user/profile", "PATCH", () =>
                    navigate("/account", false),
                  )
                }
              >
                <h2>默认昵称</h2>
                <input
                  className="field"
                  name="nickname"
                  aria-label="默认昵称"
                  defaultValue={viewer.user?.nickname}
                  required
                  maxLength={24}
                />
                <Button disabled={pending}>保存昵称</Button>
                <p className="text-sm text-zinc-400">
                  不会修改已有预约或报名的昵称。
                </p>
              </form>
            )}
            <form
              method="post"
              className="panel space-y-4 p-6"
              onSubmit={(e) =>
                submit(e, "/api/user/password", "POST", () =>
                  navigate("/account/login"),
                )
              }
            >
              <h2>修改密码</h2>
              <Password name="currentPassword" label="当前密码" />
              <Password label="新密码" />
              <Password name="confirmation" label="确认新密码" />
              <Button disabled={pending}>修改密码并重新登录</Button>
            </form>
            {!viewer.user?.mustChangePassword && (
              <>
                <form
                  method="post"
                  className="panel space-y-4 p-6"
                  onSubmit={(e) =>
                    submit(e, "/api/user/recovery", "POST", (data) =>
                      setCode(String(data.recoveryCode)),
                    )
                  }
                >
                  <h2>生成新的恢复码</h2>
                  <p className="text-sm text-zinc-400">
                    旧恢复码立即失效，新码仅展示一次。
                  </p>
                  <Password label="当前密码" />
                  <Button disabled={pending}>生成恢复码</Button>
                </form>
                <GuestClaims />
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm("退出账号的所有设备？"))
                      void run(async () => {
                        await request("/api/user/sessions/all", "DELETE");
                        navigate("/account/login");
                      });
                  }}
                >
                  退出所有设备
                </Button>
              </>
            )}
          </>
        ) : (
          <p>
            当前未登录或登录已失效。登录后可管理账号；退出后可继续使用游客功能。
          </p>
        )}
        {!code && (
          <div className="flex flex-wrap gap-4 text-sm text-lime-300">
            <Link href="/account/login">登录</Link>
            <Link href="/account/register">注册</Link>
            <Link href="/account/recover">找回密码</Link>
            <Link href="/">返回大厅</Link>
          </div>
        )}
        {mode === "account" && (
          <Button
            disabled={pending}
            variant="outline"
            onClick={() =>
              void run(async () => {
                await request("/api/user/session", "DELETE");
                navigate("/");
              })
            }
          >
            退出账号，使用游客模式
          </Button>
        )}
      </fieldset>
    </section>
  );
}
type Preview = {
  items: {
    id: string;
    label: string;
    conflict: string | null;
    canOpen: boolean;
    historical: boolean;
  }[];
  fingerprint: string;
  guestStorageKey: string;
};
function GuestClaims() {
  const [preview, setPreview] = useState<Preview>(),
    [selected, setSelected] = useState<string[]>([]),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const submission = useRef<
    { key: string; fingerprint: string; ids: string[] } | undefined
  >(undefined);
  async function load() {
    setPending(true);
    setError("");
    try {
      const data = await request<Preview>("/api/user/guest-claims");
      if (data.guestStorageKey) bindLegacyGuest(data.guestStorageKey);
      setPreview(data);
      setSelected(data.items.filter((i) => !i.conflict).map((i) => i.id));
      submission.current = undefined;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="panel space-y-4 p-6" aria-label="关联游客记录">
      <h2>关联当前浏览器的游客记录</h2>
      <p className="text-sm text-zinc-400">
        仅关联你明确选择的场次。冲突场次保留原身份，退出账号后仍可按原规则管理。
      </p>
      <Button variant="outline" disabled={pending} onClick={load}>
        预览游客记录
      </Button>
      {preview && (
        <>
          <p>
            找到 {preview.items.length}{" "}
            场。可处理的冲突请先退出其中一份；历史冲突可保持不勾选。
          </p>
          {preview.items.map((item) => (
            <label
              key={item.id}
              className="block rounded border border-white/10 p-3"
            >
              <input
                type="checkbox"
                disabled={pending || !!item.conflict || !!submission.current}
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked
                      ? [...ids, item.id]
                      : ids.filter((id) => id !== item.id),
                  )
                }
              />{" "}
              {item.canOpen ? (
                <Link
                  className="text-lime-300"
                  href={`/reservation/${item.id}`}
                  target="_blank"
                >
                  {item.label}
                </Link>
              ) : (
                item.label
              )}
              {item.conflict && (
                <p className="text-sm text-amber-300">
                  不能关联：{item.conflict}
                </p>
              )}
            </label>
          ))}
          {!!preview.items.length && (
            <Button
              disabled={pending || !selected.length}
              onClick={async () => {
                if (!navigator.onLine) {
                  setError("当前离线，请联网后核对");
                  return;
                }
                try {
                  const stored =
                    sessionStorage.getItem(
                      `party-creation:identity:${preview.guestStorageKey}`,
                    ) ||
                    (bindLegacyGuest(preview.guestStorageKey) &&
                      sessionStorage.getItem("party-creation"));
                  if (stored || readSubmission()) {
                    setError(
                      "有未确认创建。请使用对应账号或退出后的原游客身份，在创建页面查询结果或明确放弃后再关联。",
                    );
                    return;
                  }
                } catch {
                  setError(
                    "无法读取本机提交记录，请允许会话存储后再关联，避免重复创建。",
                  );
                  return;
                }
                if (
                  !window.confirm(
                    `确认关联 ${selected.length} 场？未选场次仍保留原游客身份，已关联场次以后须登录管理。`,
                  )
                )
                  return;
                submission.current ??= {
                  key: newClaimKey(),
                  fingerprint: preview.fingerprint,
                  ids: selected,
                };
                setPending(true);
                setError("");
                try {
                  const result = await request<{
                    ids: string[];
                    retired: boolean;
                    fromStorage: string;
                    toStorage: string;
                  }>("/api/user/guest-claims", "POST", submission.current);
                  try {
                    const bases = result.ids.map(
                      (id) => `party-reservation-draft:edit:${id}`,
                    );
                    if (result.retired)
                      bases.push("party-reservation-draft:new");
                    for (const base of bases) {
                      const from = `${base}:identity:${result.fromStorage}`,
                        to = `${base}:identity:${result.toStorage}`;
                      const draft =
                        sessionStorage.getItem(from) ||
                        (bindLegacyGuest(result.fromStorage) &&
                          sessionStorage.getItem(base));
                      if (draft && !sessionStorage.getItem(to)) {
                        sessionStorage.setItem(to, draft);
                        sessionStorage.removeItem(from);
                        sessionStorage.removeItem(base);
                      }
                    }
                  } catch {
                    /* Server ownership is authoritative even when local storage is unavailable. */
                  }
                  notifyIdentityChanged();
                  window.location.assign("/my-reservations");
                } catch (e) {
                  setError(
                    (e as Error).message +
                      " 可手动重试同一关联，或重新预览核对结果。",
                  );
                } finally {
                  setPending(false);
                }
              }}
            >
              确认关联所选记录
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
