"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import {
  calendarSettingsSchema,
  calendarRotationResultSchema,
  type CalendarSettings,
} from "../lib/calendar-subscription";

export function CalendarSubscription({
  initial,
}: {
  initial: CalendarSettings;
}) {
  const [settings, setSettings] = useState(initial);
  const [includeInvites, setIncludeInvites] = useState(initial.includeInvites);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  async function run(action: "read" | "rotate" | "revoke") {
    if (pending) return;
    if (
      action !== "read" &&
      !window.confirm(
        action === "revoke"
          ? "停用后当前订阅链接立即失效，日历软件中的副本需自行核对。确定停用？"
          : `${settings.active ? "旧链接将立即失效。" : ""}${includeInvites ? "订阅将包含本人正式参加的邀请预约，链接持有者可读取这些预约的标题和时间。" : "订阅仅包含本人正式参加的公开预约。"}确定生成链接？`,
      )
    )
      return;
    setPending(true);
    setError("");
    if (action !== "read") setLink("");
    try {
      if (!navigator.onLine)
        throw new Error(
          "当前离线，请联网后操作。操作结果不明确时请先重新读取状态，不会自动重发。",
        );
      if (action === "rotate") {
        const result = await request(
          "/api/user/calendar",
          "POST",
          { version: settings.version, includeInvites },
          { schema: calendarRotationResultSchema },
        );
        const { token, ...configuration } = result;
        setSettings(configuration);
        setLink(
          new URL(`/api/calendar?token=${token}`, window.location.origin).href,
        );
      } else {
        const result = await request(
          "/api/user/calendar",
          action === "read" ? "GET" : "DELETE",
          action === "read" ? undefined : { version: settings.version },
          { schema: calendarSettingsSchema },
        );
        setSettings(result);
        setIncludeInvites(result.includeInvites);
        setLink("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <Link href="/account" className="text-sm text-zinc-400">
        返回个人账号
      </Link>
      <h1 className="text-3xl font-bold">日历订阅</h1>
      <p className="text-sm text-zinc-400">
        订阅本人正式参加的预约，范围为过去 30 天至未来 365
        天。候补、仅发起但已退出的预约不包含在内。同步频率由日历软件决定，请以站内状态为准。
      </p>
      <p className="text-sm text-zinc-400">
        链接相当于读取日程的密码，只展示一次，请妥善保管。修改密码、找回或重置密码、退出所有设备及管理员撤销会话后需重新生成。停用账号期间无法读取。
      </p>
      <fieldset disabled={!ready || pending} className="panel space-y-5 p-6">
        <p role="status">
          {settings.active ? "订阅已启用" : "订阅未启用或已失效"}
        </p>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={includeInvites}
            onChange={(e) => setIncludeInvites(e.target.checked)}
          />
          包含本人正式参加的邀请预约
        </label>
        <p className="text-sm text-zinc-400">
          修改范围需生成新链接；不包含名单、备注、房间密码或邀请凭据。取消会同步取消状态，退出或删除后不再出现在完整订阅中，日历软件可能延迟更新。
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void run("rotate")}>
            {settings.active ? "更换订阅链接" : "生成订阅链接"}
          </Button>
          <Button variant="outline" onClick={() => void run("read")}>
            重新读取状态
          </Button>
          {settings.active && (
            <Button variant="outline" onClick={() => void run("revoke")}>
              停用订阅
            </Button>
          )}
        </div>
        {link && (
          <div className="space-y-3">
            <p>
              请复制到日历软件的“通过网址订阅”入口。关闭或离开本页后无法再次显示原链接。
            </p>
            <textarea
              aria-label="日历订阅链接"
              readOnly
              className="field break-all"
              rows={4}
              value={link}
              onFocus={(e) => e.target.select()}
            />
            <Button variant="ghost" onClick={() => setLink("")}>
              关闭链接
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
      </fieldset>
    </section>
  );
}
