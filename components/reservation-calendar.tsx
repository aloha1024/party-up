"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { Button } from "./ui/button";
import { request } from "@/lib/client-request";
import {
  calendarReservationSchema,
  reservationCalendar,
} from "@/lib/reservation-calendar";

export function ReservationCalendar({
  id,
  disabled = false,
}: {
  id: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [download, setDownload] = useState<{
    url: string;
    filename: string;
  } | null>(null);
  const resource = useRef<string | null>(null);
  const mounted = useRef(true);
  const router = useRouter();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resource.current) URL.revokeObjectURL(resource.current);
    };
  }, []);
  async function prepare() {
    setError("");
    setPending(true);
    if (resource.current) URL.revokeObjectURL(resource.current);
    resource.current = null;
    setDownload(null);
    try {
      const data = await request(
        `/api/reservations/${encodeURIComponent(id)}/calendar`,
        "GET",
        undefined,
        { schema: calendarReservationSchema },
      );
      if (!mounted.current) return;
      const url = URL.createObjectURL(
        new Blob([reservationCalendar(data, window.location.origin)], {
          type: "text/calendar;charset=utf-8",
        }),
      );
      resource.current = url;
      setDownload({
        url,
        filename: `party-up-${encodeURIComponent(data.id)}.ics`,
      });
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      if (navigator.onLine) router.refresh();
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="mt-5 border-t border-white/10 pt-5">
      <Button
        variant="outline"
        className="w-full"
        disabled={disabled || pending}
        onClick={prepare}
      >
        <CalendarPlus size={16} />
        {pending ? "正在准备…" : "添加到日历"}
      </Button>
      <p className="mt-3 text-xs leading-6 text-zinc-500">
        仅记录开玩时间，默认提前 15
        分钟提醒，实际提醒由日历应用控制。副本不会自动同步，修改、取消或退出后请手动调整日历。
      </p>
      {download && (
        <div className="mt-3 space-y-2">
          <Button asChild variant="outline" className="w-full">
            <a href={download.url} download={download.filename}>
              下载日历文件
            </a>
          </Button>
          <p className="text-xs leading-6 text-zinc-400">
            下载后用日历应用导入。重复导入可能产生重复事件，请检查已有记录。
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
