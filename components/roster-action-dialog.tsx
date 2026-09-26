"use client";
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ensureBrowserIdentity } from "../lib/browser-identity";
import { request } from "../lib/client-request";
import {
  renameSchema,
  removalSchema,
  type RosterKind,
} from "../lib/roster-management";

export type RosterAction = {
  kind: RosterKind;
  entryId: string;
  expectedName: string;
  mode: "rename" | "remove";
};
export function RosterActionDialog({
  id,
  action,
  disabled,
  onClose,
  onPendingChange,
}: {
  id: string;
  action: RosterAction;
  disabled: boolean;
  onClose: () => void;
  onPendingChange: (value: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(action.expectedName);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const rename = action.mode === "rename";
    const parsed = rename
      ? renameSchema.safeParse({
          entryId: action.entryId,
          expectedName: action.expectedName,
          name,
        })
      : removalSchema.safeParse({
          kind: action.kind,
          entryId: action.entryId,
          expectedName: action.expectedName,
          reason,
        });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (!navigator.onLine) {
      setError("当前离线，请恢复网络后重试");
      return;
    }
    if (
      !rename &&
      !window.confirm(
        `确定移除“${action.expectedName}”的${action.kind === "participants" ? "正式报名" : "候补"}？对方仍可重新加入。`,
      )
    )
      return;
    setError("");
    start(async () => {
      try {
        await ensureBrowserIdentity();
        await request(
          `/api/reservations/${id}/${rename ? action.kind : "roster-removals"}`,
          rename ? "PATCH" : "POST",
          parsed.data,
        );
        toast.success(rename ? "昵称已更新" : "已移除");
        onClose();
        if (navigator.onLine) router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败，请刷新确认后重试");
      }
    });
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="roster-action-title"
      className="panel fixed m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto p-6 text-zinc-100 backdrop:bg-black/70"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <h2 id="roster-action-title" className="text-lg font-semibold">
        {action.mode === "rename" ? "修改昵称" : "移除报名"}
      </h2>
      <p className="my-4 break-words text-sm text-zinc-400">
        {action.expectedName} ·{" "}
        {action.kind === "participants" ? "正式参与者" : "候补"}
      </p>
      <form onSubmit={submit} className="space-y-4">
        {action.mode === "rename" ? (
          <label className="block space-y-2">
            <span>新昵称</span>
            <Input
              value={name}
              maxLength={24}
              disabled={pending}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="block space-y-2">
              <span>移除原因</span>
              <textarea
                className="field min-h-24"
                value={reason}
                maxLength={300}
                disabled={pending}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <p className="text-xs leading-6 text-zinc-400">
              原因仅本人、发起人及管理员可见。对方可以重新报名或候补，原位置不保留。
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button disabled={pending || disabled}>
            {pending
              ? "正在提交…"
              : action.mode === "rename"
                ? "保存昵称"
                : "确认移除"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            关闭
          </Button>
        </div>
      </form>
    </dialog>
  );
}
