import { RegisteredFeature } from "./identity-provider";
import { ReservationCalendar } from "./reservation-calendar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field } from "./reservation-ui";
import type { Reservation } from "@/types/reservation";
import { statusLabels, type Status } from "@/lib/status";
import type { recruitmentClosure } from "@/lib/recruitment";
import { formatTime } from "@/lib/utils";
import { Check, Clock3, Loader2, Plus } from "lucide-react";

export function ReservationParticipation({
  reservation: r,
  me,
  waitingIndex,
  state,
  closed,
  canWait,
  name,
  error,
  hydrated,
  pending,
  cancelling,
  recruiting,
  onNameChange,
  onMutate,
}: {
  reservation: Reservation;
  me: Reservation["participants"][number] | undefined;
  waitingIndex: number;
  state: Status;
  closed: ReturnType<typeof recruitmentClosure>;
  canWait: boolean;
  name: string;
  error: string;
  hydrated: boolean;
  pending: boolean;
  cancelling: boolean;
  recruiting: boolean;
  onNameChange: (name: string) => void;
  onMutate: (method: "POST" | "DELETE", queue?: boolean) => void;
}) {
  return (
    <aside className="panel order-first p-6 lg:order-last">
      <div className="mb-6">
        <p className="mb-3 flex items-center gap-2 text-sm text-zinc-400">
          <Clock3 size={16} />
          开玩时间
        </p>
        <p className="text-xl font-semibold">{formatTime(r.scheduledAt)}</p>
        <p className="mt-2 text-xs text-zinc-500">北京时间 UTC+8</p>
      </div>
      <div className="border-y border-white/10 py-6">
        <div className="flex items-end justify-between">
          <span className="text-sm text-zinc-400">参与人数</span>
          <span>
            <strong className="text-3xl text-lime-300">
              {r.participants.length}
            </strong>
            <span className="text-zinc-500"> / {r.maxPlayers} 人</span>
          </span>
        </div>
        <div className="mt-4 h-1.5 rounded-full bg-white/5">
          <div
            className="h-full rounded-full bg-lime-300"
            style={{
              width: `${(r.participants.length / r.maxPlayers) * 100}%`,
            }}
          />
        </div>
      </div>
      <div className="pt-6">
        {me ? (
          <>
            <p className="mb-4 flex items-center gap-2 text-sm text-lime-300">
              <Check size={16} />
              你已在接龙名单中
            </p>
            <Button
              variant="outline"
              className="w-full"
              disabled={
                pending || ["STARTED", "CANCELLED", "ENDED"].includes(state)
              }
              onClick={() => onMutate("DELETE")}
            >
              {pending ? "正在退出…" : "退出接龙"}
            </Button>
          </>
        ) : waitingIndex >= 0 ? (
          <>
            <p role="status" className="mb-4 text-sm text-lime-300">
              {state === "CANCELLED"
                ? "预约已取消"
                : ["STARTED", "ENDED"].includes(state)
                  ? "未递补"
                  : `你在候补第 ${waitingIndex + 1} 位`}
            </p>
            <Button
              variant="outline"
              className="w-full"
              disabled={pending}
              onClick={() => onMutate("DELETE", true)}
            >
              {pending ? "正在退出…" : "退出候补"}
            </Button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onMutate("POST", state === "FULL");
            }}
          >
            <Field title="你的昵称">
              <Input
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                maxLength={24}
                placeholder="输入昵称，加入这一局"
                required
                disabled={
                  !hydrated ||
                  !!closed ||
                  (state !== "OPEN" && !canWait) ||
                  pending ||
                  recruiting
                }
              />
            </Field>
            <Button
              className="mt-4 w-full"
              disabled={
                !hydrated ||
                !!closed ||
                (state !== "OPEN" && !canWait) ||
                pending ||
                recruiting
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : <Plus />}
              {pending
                ? "正在加入…"
                : closed ||
                  (state === "OPEN"
                    ? "加入接龙"
                    : state === "FULL"
                      ? canWait
                        ? "加入候补"
                        : "候补已满（最多 100 人）"
                      : statusLabels[state])}
            </Button>
            {state === "FULL" && !closed && (
              <p className="mt-3 text-xs leading-6 text-zinc-400">
                有空位时将按顺序自动转为正式报名。候补不是正式报名，不发送外部通知。
              </p>
            )}
          </form>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}
        {me && !["STARTED", "CANCELLED", "ENDED"].includes(state) && (
          <RegisteredFeature label="添加到日历">
            <ReservationCalendar
              key={`${r.id}:${r.editVersion}`}
              id={r.id}
              disabled={pending || cancelling}
            />
          </RegisteredFeature>
        )}
        <p className="mt-4 text-xs leading-6 text-zinc-500">
          无需注册。本浏览器会记住你的报名身份；请用同一浏览器退出接龙。
        </p>
      </div>
    </aside>
  );
}
