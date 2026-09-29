import { z } from "zod";

export const sessionIdSchema = z.uuid("登录会话编号无效");
export const sessionPageSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "页码无效")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100000))
  .default(1);

export type UserSessionItem = {
  id: string;
  browser: string | null;
  os: string | null;
  createdAt: string | null;
  expiresAt: string;
  current: boolean;
};
export type UserSessionPage = {
  items: UserSessionItem[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
};

// Only fixed labels leave this function. Never retain the original header.
export function sessionDevice(userAgent?: string | null) {
  const ua = (userAgent ?? "").slice(0, 1024);
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua)
    ? "Edge"
    : /(?:OPR|Opera)\//i.test(ua)
      ? "Opera"
      : /(?:Firefox|FxiOS)\//i.test(ua)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//i.test(ua)
          ? "Chrome"
          : /Version\/[^ ]+.*Safari\//i.test(ua)
            ? "Safari"
            : null;
  const os = /(?:iPhone|iPad|iPod)/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
      ? "Android"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : null;
  return { browser, os };
}
