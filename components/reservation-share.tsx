"use client";
import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText, selectTextareaText } from "@/lib/copy-text";
import { reservationShareText } from "@/lib/reservation-share";
import type { Reservation } from "@/types/reservation";

export function ReservationShare({
  reservation,
}: {
  reservation: Reservation;
}) {
  const [pending, setPending] = useState(false);
  const [manualText, setManualText] = useState("");
  async function share() {
    setPending(true);
    const url = new URL(
      "/reservation/" + encodeURIComponent(reservation.id),
      window.location.origin,
    ).href;
    const text = reservationShareText(reservation, url);
    try {
      if (!(await copyText(text))) throw new Error("Clipboard unavailable");
      setManualText("");
      toast.success("接龙信息已复制，可以粘贴分享给队友");
    } catch {
      setManualText(text);
      toast.error("浏览器未允许自动复制，请在下方选择并复制分享内容");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="w-full space-y-3 sm:w-auto sm:max-w-md">
      <Button variant="outline" onClick={share} disabled={pending}>
        <Copy />
        {pending ? "正在复制…" : "分享接龙"}
      </Button>
      {manualText && (
        <div className="panel space-y-3 p-4">
          <label className="block space-y-2 text-sm">
            <span>分享内容（点击文本框全选后复制）</span>
            <textarea
              className="field min-h-60"
              readOnly
              value={manualText}
              onFocus={(event) => selectTextareaText(event.currentTarget)}
              onClick={(event) => selectTextareaText(event.currentTarget)}
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
