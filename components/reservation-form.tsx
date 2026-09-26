"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Reservation, ReservationTemplate } from "@/types/reservation";
import { Loader2, Zap } from "lucide-react";

import { Back, Field } from "./reservation-ui";
import { useReservationForm } from "./use-reservation-form";
export function CreateForm({
  reservation: initialReservation,
  template,
}: {
  reservation?: Reservation;
  template?: ReservationTemplate;
}) {
  const {
    reservation,
    conflict,
    pending,
    error,
    field,
    recoverable,
    draftReady,
    draftSaved,
    submission,
    lookupMessage,
    currentDraft,
    restoredDraft,
    checkCreation,
    submit,
    abandonSubmission,
    restoreDraft,
    discardDraft,
    reloadEditor,
  } = useReservationForm(initialReservation, template);
  return (
    <div className="mx-auto max-w-2xl">
      <Back />
      <p className="eyebrow mt-8">
        {reservation ? "EDIT YOUR PARTY" : "CREATE A PARTY"}
      </p>
      <h1 className="mb-3 mt-3 text-3xl font-bold">
        {reservation ? "编辑预约" : template ? "再开一局" : "下一局，你来发起"}
        <span className="text-lime-300">.</span>
      </h1>
      <p className="mb-8 text-sm text-zinc-400">
        {reservation
          ? "修改后分享链接保持不变，已报名的队友会保留。"
          : template
            ? "已复制旧预约配置，请重新选择日期和时间。报名名单不会复制，新预约将使用新的分享链接。"
            : "填好开局信息，分享链接就能召集队友。"}
      </p>
      <form className="panel space-y-6 p-6 sm:p-8" onSubmit={submit}>
        {template && restoredDraft && (
          <p role="status" className="text-sm text-lime-300">
            已恢复旧草稿，当前内容以草稿为准，请核对日期和时间。
          </p>
        )}
        {submission && !reservation && (
          <section
            aria-label="上次创建结果"
            className="space-y-3 rounded-xl border border-amber-300/30 bg-amber-300/5 p-4"
          >
            <p className="text-sm text-zinc-300">
              上次创建结果尚未确认。预约即使已经开始，也可以在这里查看结果。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={checkCreation}
              >
                查看上次创建结果
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={abandonSubmission}
              >
                放弃上次提交记录
              </Button>
            </div>
            {lookupMessage && (
              <p role="status" className="text-sm text-zinc-300">
                {lookupMessage}
              </p>
            )}
          </section>
        )}
        {recoverable && (
          <section
            aria-label="恢复预约草稿"
            className="space-y-3 rounded-xl border border-lime-300/30 bg-lime-300/5 p-4"
          >
            <p className="text-sm text-zinc-300">
              {currentDraft
                ? "发现此标签页保存的草稿。恢复后继续编辑，或丢弃草稿使用当前信息。"
                : "预约已更新，草稿基于旧版本。请先查看并复制需要的内容，再使用最新信息编辑；旧草稿不会自动覆盖新版本。"}
            </p>
            {!currentDraft && (
              <textarea
                aria-label="旧版本草稿内容"
                readOnly
                className="field min-h-48"
                value={[
                  `游戏名称：${recoverable.fields.gameName}`,
                  `开玩时间：${recoverable.fields.date} ${recoverable.fields.time}`,
                  `发起人昵称：${recoverable.fields.hostName}`,
                  `最大参与人数：${recoverable.fields.maxPlayers}`,
                  `备注：${recoverable.fields.description}`,
                ].join("\n")}
              />
            )}
            <div className="flex flex-wrap gap-2">
              {currentDraft && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={restoreDraft}
                >
                  恢复草稿
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={discardDraft}
              >
                {currentDraft
                  ? template
                    ? "丢弃草稿并使用本次配置"
                    : "丢弃草稿"
                  : "使用最新信息继续"}
              </Button>
            </div>
          </section>
        )}
        <fieldset
          className="min-w-0 space-y-6"
          disabled={!draftReady || pending || !!recoverable}
        >
          {!reservation && (
            <Field title="预约可见性">
              <select
                className="field"
                {...field("visibility")}
                value={field("visibility").value ?? "PUBLIC"}
              >
                <option value="PUBLIC">公开预约</option>
                <option value="INVITE">邀请制预约</option>
              </select>
              <p className="mt-2 text-xs text-zinc-400">
                创建后不可切换。邀请制预约不在公共大厅显示。
              </p>
            </Field>
          )}
          <Field title="游戏名称">
            <Input
              {...field("gameName")}
              placeholder="例如：Valorant / 无畏契约"
              maxLength={80}
              required
            />
          </Field>
          {reservation?.participants.some((p) => p.checkedInAt) && (
            <p className="text-sm text-amber-300">
              修改开玩时间将清空已有到场确认，参与者需要重新确认；仅修改其他内容不会清空。
            </p>
          )}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field title="预约日期">
              <Input type="date" {...field("date")} required />
            </Field>
            <Field title="开玩时间 · 北京时间">
              <Input type="time" {...field("time")} required />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field title="发起人昵称">
              <Input
                {...field("hostName")}
                placeholder="队友怎么称呼你？"
                maxLength={24}
                required
              />
            </Field>
            <Field title="最大参与人数 · 含发起人">
              <Input
                {...field("maxPlayers")}
                type="number"
                min={Math.max(2, reservation?.participants.length ?? 0)}
                max={100}
                required
              />
            </Field>
          </div>
          <Field title="备注（选填）">
            <textarea
              {...field("description")}
              className="field min-h-28 resize-y"
              maxLength={1000}
              placeholder="游戏模式、语音方式，或想对队友说的话…"
            />
          </Field>
        </fieldset>
        <p className="text-xs text-zinc-500">
          {reservation
            ? "人数上限不能小于当前报名人数。"
            : "发起人将自动占用一个名额。"}
          昵称最多 24 字，备注最多 1000 字。
        </p>
        <p
          className={`text-xs ${draftSaved ? "text-zinc-500" : "text-amber-300"}`}
        >
          {!draftReady
            ? "正在读取此标签页的草稿…"
            : draftSaved
              ? "草稿仅保存在此浏览器标签页，刷新后可选择恢复；成功保存后自动清除。"
              : "浏览器未能保存草稿，刷新或离开前请复制需要保留的内容。"}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {conflict && reservation && (
          <div className="space-y-3 rounded-xl border border-amber-300/30 bg-amber-300/5 p-4">
            <p className="text-sm text-zinc-300">
              输入尚未提交。可先在新窗口查看最新预约；重新加载后，已保存的旧版本草稿可供查看和复制。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <a
                  href={`/reservation/${reservation.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看最新预约（新窗口）
                </a>
              </Button>
              <Button type="button" variant="outline" onClick={reloadEditor}>
                重新加载编辑表单
              </Button>
            </div>
          </div>
        )}
        <Button
          className="w-full"
          disabled={!draftReady || pending || conflict || !!recoverable}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Zap />}
          {pending
            ? "正在保存…"
            : reservation
              ? "保存修改"
              : "创建预约，召集队友"}
        </Button>
      </form>
    </div>
  );
}
