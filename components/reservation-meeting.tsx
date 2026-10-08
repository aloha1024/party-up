"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { request } from "../lib/client-request";
import { ensureBrowserIdentity } from "../lib/browser-identity";
import type { Reservation } from "../types/reservation";

export function ReservationMeeting({
  reservation: r,
  admin,
  onPendingChange,
}: {
  reservation: Reservation;
  admin: boolean;
  onPendingChange: (value: boolean) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState(r.meeting);
  useEffect(() => {
    if (!r.meeting) {
      setEditing(false);
      setFields(null);
      setError("");
    } else if (!editing) setFields(r.meeting);
  }, [r.meeting, editing]);
  const editable =
    (r.isHost || admin) && !["ENDED", "CANCELLED"].includes(r.status);
  return (
    <section aria-label="开局集合信息" className="panel mb-6 space-y-3 p-5">
      <h2 className="text-lg font-semibold">开局集合信息</h2>
      <p className="text-sm text-zinc-400">
        平台：{r.platform || "未填写"} · 区服：{r.gameServer || "未填写"}
      </p>
      {!r.meeting ? (
        <p className="text-sm text-zinc-400">
          房间号、密码及语音入口仅当前正式参与者、发起人和管理员可见。
        </p>
      ) : (
        <>
          {editing && fields ? (
            <form
              className="space-y-3"
              onSubmit={async (event) => {
                event.preventDefault();
                if (pending) return;
                if (!navigator.onLine) {
                  setError("当前离线，请联网后重新确认操作");
                  return;
                }
                setPending(true);
                onPendingChange(true);
                setError("");
                try {
                  await ensureBrowserIdentity();
                  await request(
                    `/api/reservations/${r.id}/meeting`,
                    "PATCH",
                    fields,
                  );
                  setEditing(false);
                  if (navigator.onLine) router.refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setPending(false);
                  onPendingChange(false);
                }
              }}
            >
              <fieldset disabled={pending || !editable} className="space-y-3">
                {(
                  [
                    ["roomName", "房间号", 100],
                    ["roomPassword", "房间密码", 100],
                    ["voice", "语音入口", 1000],
                  ] as const
                ).map(([key, label, max]) => (
                  <label key={key} className="block space-y-2 text-sm">
                    <span>{label}</span>
                    <Input
                      autoComplete="off"
                      maxLength={max}
                      value={fields[key]}
                      onChange={(e) =>
                        setFields({ ...fields, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <p className="text-xs text-zinc-400">
                  不保存到浏览器草稿，不包含在分享、日历或公开历史中。清空字段可撤下信息。
                </p>
                <div className="flex gap-3">
                  <Button type="submit">
                    {pending ? "正在保存…" : "保存集合信息"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditing(false)}
                  >
                    放弃修改
                  </Button>
                </div>
              </fieldset>
            </form>
          ) : (
            <>
              <p className="break-words">
                房间号：{r.meeting.roomName || "未填写"}
              </p>
              <p className="break-words">
                房间密码：{r.meeting.roomPassword || "未填写"}
              </p>
              <p className="whitespace-pre-wrap break-words">
                语音入口：{r.meeting.voice || "未填写"}
              </p>
              {editable && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setFields(r.meeting);
                    setError("");
                    setEditing(true);
                  }}
                >
                  编辑集合信息
                </Button>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error} 输入已保留，不会自动重发。请先刷新核对结果。
        </p>
      )}
    </section>
  );
}
