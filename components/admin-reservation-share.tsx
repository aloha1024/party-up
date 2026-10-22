"use client";

import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { request } from "@/lib/client-request";
import { copyText } from "@/lib/copy-text";
import {
  adminReservationShareSchema,
  adminReservationShareText,
} from "@/lib/admin-reservation-share";

export function AdminReservationShare({
  disabled,
  onPendingChange,
}: {
  disabled: boolean;
  onPendingChange: (value: boolean) => void;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [manualText, setManualText] = useState("");
  useEffect(() => {
    onPendingChange(pending || !!manualText);
    return () => onPendingChange(false);
  }, [pending, manualText, onPendingChange]);

  async function copy() {
    setPending(true);
    setManualText("");
    try {
      const { items } = await request(
        "/api/admin/reservations/share",
        "GET",
        undefined,
        {
          schema: adminReservationShareSchema,
          isCurrent: () => active.current,
        },
      );
      if (!items.length) {
        toast.info("暂无未满员且未开始的可报名接龙");
        return;
      }
      const text = adminReservationShareText(items, window.location.origin);
      const copied = await copyText(text);
      if (!active.current) return;
      if (copied) {
        toast.success(`已复制 ${items.length} 场可报名接龙`);
      } else {
        setManualText(text);
        toast.info("浏览器未允许自动复制，请选择下方内容复制");
      }
    } catch (error) {
      if (!active.current) return;
      toast.error(error instanceof Error ? error.message : "复制失败，请重试");
    } finally {
      if (active.current) setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">汇总全部可报名接龙，含邀请链接</p>
        <Button variant="outline" disabled={disabled || pending} onClick={copy}>
          <Copy aria-hidden="true" />
          {pending ? "正在复制…" : "复制可报名接龙"}
        </Button>
      </div>
      {manualText && (
        <div className="panel min-w-0 space-y-3 p-4">
          <label className="block min-w-0 space-y-2 text-sm">
            <span>接龙汇总（点击全选后复制）</span>
            <textarea
              className="field min-w-0 resize-y text-sm"
              rows={7}
              readOnly
              value={manualText}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </label>
          <Button variant="ghost" onClick={() => setManualText("")}>
            关闭
          </Button>
        </div>
      )}
    </div>
  );
}
