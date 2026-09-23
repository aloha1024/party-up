import { z } from "zod";
export const auditActions = [
  "RESERVATION_EDIT",
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
  RESERVATION_EDIT: "编辑预约",
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
