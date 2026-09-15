import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminSession } from "./admin-auth";
import { AppError } from "./reservations";
export async function isAdmin() {
  return verifyAdminSession((await cookies()).get(ADMIN_COOKIE)?.value);
}
export async function requireAdmin() {
  if (!(await isAdmin()))
    throw new AppError("UNAUTHORIZED", "请先登录管理员账号", 401);
}
