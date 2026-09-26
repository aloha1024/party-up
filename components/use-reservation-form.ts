"use client";
import {
  clearSubmission,
  ensureBrowserIdentity,
  submissionKey,
} from "@/lib/browser-identity";
import { ClientRequestError, request } from "@/lib/client-request";
import { creationResultSchema } from "@/lib/creation-result";
import {
  readSubmission,
  type CreationSubmission,
} from "@/lib/creation-submission";
import {
  clearDraft,
  creationInputFromFields,
  draftMatchesSubmission,
  draftMatchesVersion,
  readDraft,
  saveDraft,
  type ReservationDraft,
  type ReservationFields,
} from "@/lib/reservation-draft";
import { createSchema, creationFingerprint } from "@/lib/validation";
import type { Reservation, ReservationTemplate } from "@/types/reservation";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { toast } from "sonner";
import { z } from "zod";

export function useReservationForm(
  initialReservation?: Reservation,
  template?: ReservationTemplate,
) {
  // A recovered draft must keep the server version it was originally based on.
  const [reservation] = useState(initialReservation);
  const [conflict, setConflict] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [fields, setFields] = useState<ReservationFields>(() => {
    const localTime = reservation
      ? new Date(
          Date.parse(reservation.scheduledAt) + 8 * 3600000,
        ).toISOString()
      : "";
    return {
      visibility: reservation?.visibility ?? template?.visibility ?? "PUBLIC",
      gameName: reservation?.gameName ?? template?.gameName ?? "",
      hostName: reservation?.hostName ?? template?.hostName ?? "",
      date: localTime.slice(0, 10),
      time: localTime.slice(11, 16),
      maxPlayers: String(reservation?.maxPlayers ?? template?.maxPlayers ?? 5),
      description: reservation?.description ?? template?.description ?? "",
    };
  });
  const [recoverable, setRecoverable] = useState<ReservationDraft>();
  // Server-rendered inputs stay disabled until hydration has read the pre-existing draft.
  // Otherwise early typing can be mistaken for an old draft or bypass its change handler.
  const [draftReady, setDraftReady] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const [submission, setSubmission] = useState<CreationSubmission>();
  const [lookupMessage, setLookupMessage] = useState("");
  useEffect(() => {
    setRecoverable(readDraft(reservation?.id));
    if (!reservation) setSubmission(readSubmission());
    setDraftReady(true);
  }, [reservation]);
  const field = (name: keyof ReservationFields) => ({
    name,
    value: fields[name],
    onChange: (
      event: ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => {
      const next = { ...fields, [name]: event.target.value };
      setFields(next);
      setDraftSaved(saveDraft(next, reservation?.id, reservation?.editVersion));
    },
  });
  const finishCreation = (id: string) => {
    const draft = readDraft();
    // Keep any newer local edits when confirming an earlier creation request.
    if (
      !draft ||
      (submission && draftMatchesSubmission(draft.fields, submission.payload))
    )
      clearDraft();
    clearSubmission();
    setSubmission(undefined);
    setRecoverable(undefined);
    router.push(`/reservation/${id}`);
    router.refresh();
  };
  const checkCreation = () => {
    if (!submission) return;
    setLookupMessage("");
    startTransition(async () => {
      try {
        const result = await request(
          "/api/reservations/submission",
          "GET",
          undefined,
          {
            idempotencyKey: submission.key,
            schema: creationResultSchema,
          },
        );
        if (result.state === "found") {
          toast.success("已找到上次创建的预约");
          finishCreation(result.reservation.id);
        } else {
          setLookupMessage(
            result.state === "removed"
              ? "上次创建的预约已被移除。确认后可放弃这次提交记录，再创建新的预约。"
              : "暂未查到创建结果。请稍后再查，或恢复原内容后重新提交；使用原提交编号不会重复创建。若清除了 Cookie，请使用原浏览器身份核对。",
          );
        }
      } catch (e) {
        setLookupMessage((e as Error).message);
      }
    });
  };
  const currentDraft =
    !!recoverable && draftMatchesVersion(recoverable, reservation?.editVersion);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftReady || recoverable || pending || conflict) return;
    setError("");
    const parsed = createSchema.safeParse(creationInputFromFields(fields));
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    startTransition(async () => {
      try {
        await ensureBrowserIdentity();
        const key = reservation
          ? undefined
          : submissionKey(JSON.parse(creationFingerprint(parsed.data)));
        if (!reservation) setSubmission(readSubmission());
        const r = await request(
          reservation
            ? `/api/reservations/${reservation.id}`
            : "/api/reservations",
          reservation ? "PATCH" : "POST",
          reservation
            ? {
                ...JSON.parse(
                  creationFingerprint({ ...parsed.data, visibility: "PUBLIC" }),
                ),
                editVersion: reservation.editVersion,
              }
            : parsed.data,
          {
            schema: z.object({ id: z.string().min(1) }),
            ...(key ? { idempotencyKey: key } : {}),
          },
        );
        clearDraft(reservation?.id);
        if (!reservation) clearSubmission();
        toast.success(reservation ? "预约已更新" : "预约已创建，你已加入接龙");
        router.push(`/reservation/${r.id}`);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
        if (e instanceof ClientRequestError && e.serverCode === "EDIT_CONFLICT")
          setConflict(true);
      }
    });
  }
  function abandonSubmission() {
    if (
      !window.confirm(
        "上次创建可能已经成功。放弃记录后再次创建可能生成另一场预约，建议先查看结果。确定放弃？",
      )
    )
      return;
    clearSubmission();
    setSubmission(undefined);
    setLookupMessage("");
    setError("");
  }
  function restoreDraft() {
    if (!recoverable || !currentDraft) return;

    setFields(recoverable.fields);
    setRestoredDraft(true);
    setRecoverable(undefined);
  }
  function discardDraft() {
    if (
      !currentDraft &&
      !window.confirm(
        "已复制需要保留的内容吗？继续后将清除旧版本草稿，使用最新预约信息。",
      )
    )
      return;
    clearDraft(reservation?.id);
    setRecoverable(undefined);
  }
  function reloadEditor() {
    if (
      draftSaved ||
      window.confirm("草稿未能保存。请先复制当前输入，确定重新加载？")
    )
      window.location.reload();
  }
  return {
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
  };
}
