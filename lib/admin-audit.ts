import { z } from "zod";
export const auditActions = [
  "RESERVATION_MEETING",
  "USER_ENABLE",
  "USER_DISABLE",
  "USER_REVOKE_SESSIONS",
  "USER_RESET_PASSWORD",
  "RESERVATION_EDIT",
  "RESERVATION_PAUSE",
  "RESERVATION_RESUME",
  "RESERVATION_END",
  "RESERVATION_REOPEN",
  "RESERVATION_INVITE_ROTATE",
  "RESERVATION_ROSTER_REMOVE",
  "RESERVATION_CANCEL",
  "RESERVATION_TRASH",
  "RESERVATION_RESTORE",
  "RESERVATION_PURGE",
  "ADMIN_CREATE",
  "ADMIN_DISABLE",
  "ADMIN_ENABLE",
  "ADMIN_RESET_PASSWORD",
  "ADMIN_CHANGE_PASSWORD",
  "ADMIN_REVOKE_SESSIONS",
] as const;
export type AuditAction = (typeof auditActions)[number];
export const auditLabels: Record<AuditAction, string> = {
  RESERVATION_MEETING: "修改集合信息",
  USER_ENABLE: "启用普通账号",
  USER_DISABLE: "停用普通账号",
  USER_REVOKE_SESSIONS: "撤销普通账号登录",
  USER_RESET_PASSWORD: "重置普通账号密码",
  RESERVATION_INVITE_ROTATE: "更换邀请链接",
  RESERVATION_END: "结束预约",
  RESERVATION_REOPEN: "撤销结束",
  RESERVATION_EDIT: "编辑预约",
  RESERVATION_PAUSE: "暂停招募",
  RESERVATION_RESUME: "恢复招募",
  RESERVATION_ROSTER_REMOVE: "移除报名或候补",
  RESERVATION_CANCEL: "取消预约",
  RESERVATION_TRASH: "移入回收站",
  RESERVATION_RESTORE: "恢复预约",
  RESERVATION_PURGE: "永久删除预约",
  ADMIN_CREATE: "创建管理员",
  ADMIN_DISABLE: "停用管理员",
  ADMIN_ENABLE: "启用管理员",
  ADMIN_RESET_PASSWORD: "重置临时密码",
  ADMIN_CHANGE_PASSWORD: "修改本人密码",
  ADMIN_REVOKE_SESSIONS: "退出所有设备",
};
export const auditQuerySchema = z.object({
  q: z.string().trim().max(80, "搜索内容最多 80 字").default(""),
  action: z.enum(["all", ...auditActions]).default("all"),
  page: z
    .union([z.string().regex(/^[1-9]\d*$/), z.number()])
    .transform(Number)
    .pipe(z.number().int().min(1).max(100000))
    .default(1),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export function auditUrl(query: AuditQuery, page: number) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.action !== "all") params.set("action", query.action);
  if (page > 1) params.set("page", String(page));
  return "/admin/audit" + (params.size ? "?" + params : "");
}
