import { z } from "zod";
import { nickname } from "./validation";
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/, "账号需为 3–32 位字母、数字或下划线");
export const passwordSchema = z
  .string()
  .min(10, "密码至少 10 个字符")
  .max(128, "密码最多 128 个字符");
export const registrationSchema = z
  .object({ username: usernameSchema, password: passwordSchema, nickname })
  .strict();
export const loginSchema = z
  .object({ username: usernameSchema, password: z.string().min(1).max(128) })
  .strict();
export const publicIdentitySchema = z.object({
  ready: z.boolean(),
  mode: z.enum(["anonymous", "guest", "user", "invalid"]),
  scope: z.string(),
  storageKey: z.string(),
  user: z
    .object({
      username: z.string(),
      nickname: z.string(),
      mustChangePassword: z.boolean(),
    })
    .nullable(),
  capabilities: z.object({
    createInvitation: z.boolean(),
    copyReservation: z.boolean(),
    calendar: z.boolean(),
  }),
});
export type PublicIdentity = z.infer<typeof publicIdentitySchema>;
export function safeReturnPath(value: unknown) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\u0000-\u0020]/.test(value) &&
    !value.startsWith("/account")
    ? value
    : "/my-reservations";
}
