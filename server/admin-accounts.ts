import { z } from "zod";
import { db } from "./db";
import { recordAdminAction } from "./admin-audit";
import { requireAccountOwner } from "./admin";
import { hashPassword } from "./admin-auth";
import { AppError } from "./reservations";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("disable") }).strict(),
  z.object({ action: z.literal("enable") }).strict(),
  z
    .object({
      action: z.literal("resetPassword"),
      password: z
        .string()
        .min(10, "临时密码至少 10 个字符")
        .max(128, "临时密码最多 128 个字符"),
    })
    .strict(),
]);

export async function manageAdministrator(id: number, input: unknown) {
  const actor = await requireAccountOwner();
  if (!Number.isSafeInteger(id) || id < 1)
    throw new AppError("INVALID_ID", "账号无效", 400);
  if (id === 1)
    throw new AppError(
      "OWNER_PROTECTED",
      "主管理员不能被禁用或通过此入口重置，请使用修改密码页面",
      403,
    );
  const action = actionSchema.parse(input);
  const data =
    action.action === "resetPassword"
      ? {
          passwordHash: await hashPassword(action.password),
          mustChangePassword: true,
        }
      : { isActive: action.action === "enable" };
  return db.$transaction(async (tx) => {
    const result = await tx.adminCredential.updateMany({
      where: { id },
      data: { ...data, sessionVersion: { increment: 1 } },
    });
    if (!result.count) throw new AppError("NOT_FOUND", "管理员账号不存在", 404);
    const target = await tx.adminCredential.findUniqueOrThrow({
      where: { id },
      select: { username: true },
    });
    const event =
      action.action === "resetPassword"
        ? "ADMIN_RESET_PASSWORD"
        : action.action === "enable"
          ? "ADMIN_ENABLE"
          : "ADMIN_DISABLE";
    await recordAdminAction(tx, actor, event, {
      id: String(id),
      label: target.username,
    });
    return { ok: true };
  });
}
