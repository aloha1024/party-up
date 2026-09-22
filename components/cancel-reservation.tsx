"use client";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
export function CancelReservation({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get("reason");
    if (
      !window.confirm(
        "确定取消这场预约？取消后无法继续报名或编辑，原链接仍可查看取消原因。",
      )
    )
      return;
    setError("");
    start(async () => {
      try {
        const response = await fetch("/api/reservations/" + id + "/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "取消失败");
        setOpen(false);
        toast.success("预约已取消");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "请求失败");
      }
    });
  }
  return (
    <div className="w-full space-y-3 sm:w-auto sm:max-w-md">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => setOpen(!open)}
      >
        取消预约
      </Button>
      {open && (
        <form onSubmit={submit} className="panel space-y-3 p-4">
          <label className="block space-y-2 text-sm">
            <span>取消原因</span>
            <textarea
              name="reason"
              className="field min-h-24"
              required
              maxLength={300}
              placeholder="向队友说明取消原因（最多 300 字）"
              disabled={pending}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          <Button disabled={pending}>
            {pending ? "正在取消…" : "确认取消"}
          </Button>
        </form>
      )}
    </div>
  );
}
