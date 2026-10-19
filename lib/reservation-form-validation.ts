import {
  creationInputFromFields,
  type ReservationFields,
} from "./reservation-draft";
import { createSchema } from "./validation";
import { deadlineError } from "./recruitment";

export const reservationFieldLabels = {
  visibility: "预约可见性",
  gameName: "游戏名称",
  platform: "游戏平台（选填）",
  gameServer: "区服（选填）",
  date: "预约日期",
  time: "开玩时间 · 北京时间",
  deadline: "报名截止时间 · 北京时间（选填）",
  hostName: "发起人昵称",
  maxPlayers: "最大参与人数 · 含发起人",
  description: "备注（选填）",
} satisfies Record<keyof ReservationFields, string>;
export type ReservationFieldErrors = Partial<
  Record<keyof ReservationFields, string>
>;

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000"))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const deadlinePattern =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const numberPattern = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/;

// Reuse the request schema and payload conversion; presentation errors never
// change submitted values, draft storage or the creation fingerprint.
export function validateReservationForm(
  fields: ReservationFields,
  original?: {
    scheduledAt: string;
    registrationDeadline?: string | null;
    participants: readonly unknown[];
  },
) {
  const input = creationInputFromFields(fields, original);
  const parsed = createSchema.safeParse(input);
  const fieldErrors: ReservationFieldErrors = {};
  // noValidate allows one accessible summary. Keep native controls' text
  // constraints too: Date/Number otherwise normalize malformed stored drafts.
  if (!fields.date) fieldErrors.date = "请选择预约日期";
  else if (!validDate(fields.date)) fieldErrors.date = "请选择有效的预约日期";
  if (!fields.time) fieldErrors.time = "请选择开玩时间";
  else if (!timePattern.test(fields.time))
    fieldErrors.time = "请选择有效的开玩时间";
  if (
    fields.deadline &&
    (!deadlinePattern.test(fields.deadline) ||
      !validDate(fields.deadline.slice(0, 10)))
  )
    fieldErrors.deadline = "请选择有效的报名截止时间";
  if (!fields.maxPlayers.trim()) fieldErrors.maxPlayers = "请填写最大参与人数";
  else if (
    !numberPattern.test(fields.maxPlayers) ||
    !Number.isInteger(input.maxPlayers)
  )
    fieldErrors.maxPlayers = "请输入有效的整数人数";
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path[0];
      if (name === "scheduledAt") {
        if (!fieldErrors.date && !fieldErrors.time) {
          fieldErrors.date = issue.message;
          fieldErrors.time = issue.message;
        }
      } else if (name === "registrationDeadline") {
        fieldErrors.deadline ??= issue.message;
      } else if (
        typeof name === "string" &&
        Object.hasOwn(reservationFieldLabels, name)
      ) {
        fieldErrors[name as keyof ReservationFields] ??= issue.message;
      }
    }
  }
  if (
    !fieldErrors.maxPlayers &&
    Number.isInteger(input.maxPlayers) &&
    original &&
    input.maxPlayers < original.participants.length
  )
    fieldErrors.maxPlayers = "人数上限不能小于当前报名人数";
  if (!fieldErrors.deadline && Number.isFinite(Date.parse(input.scheduledAt))) {
    const message = deadlineError(
      input.scheduledAt,
      input.registrationDeadline,
      original?.registrationDeadline,
    );
    if (message) fieldErrors.deadline = message;
  }
  return { parsed, fieldErrors };
}
