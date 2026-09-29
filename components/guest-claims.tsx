import { useRef, useState } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import { request } from "../lib/client-request";
import {
  notifyIdentityChanged,
  newClaimKey,
  bindLegacyGuest,
} from "../lib/client-identity";
import { readSubmission } from "../lib/creation-submission";

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
export function GuestClaims() {
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
