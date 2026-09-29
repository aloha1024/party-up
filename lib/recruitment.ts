type Recruitment = {
  scheduledAt: string | Date;
  status: string;
  registrationDeadline?: string | Date | null;
  recruitmentPaused?: boolean;
};

export function recruitmentClosure(r: Recruitment, now = new Date()) {
  if (
    ["CANCELLED", "ENDED"].includes(r.status) ||
    new Date(r.scheduledAt) <= now
  )
    return null;
  if (r.registrationDeadline && new Date(r.registrationDeadline) <= now)
    return "报名已截止";
  return r.recruitmentPaused ? "暂停招募" : null;
}

export function recruitmentWakeups(r: Recruitment) {
  return [
    new Date(r.scheduledAt).toISOString(),
    ...(r.registrationDeadline
      ? [new Date(r.registrationDeadline).toISOString()]
      : []),
  ];
}

export function deadlineError(
  scheduledAt: string,
  deadline?: string | null,
  previous?: string | null,
  now = new Date(),
) {
  if (!deadline) return null;
  if (Date.parse(deadline) > Date.parse(scheduledAt))
    return "报名截止时间不能晚于开玩时间";
  if (
    Date.parse(deadline) <= now.getTime() &&
    Date.parse(deadline) !== (previous ? Date.parse(previous) : NaN)
  )
    return "报名截止时间必须是未来时间";
  return null;
}
