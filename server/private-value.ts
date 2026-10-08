import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { AppError } from "./errors";

function key(purpose: string) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError("PRIVATE_CONFIG", "服务器尚未配置有效的加密密钥", 503);
  return createHash("sha256")
    .update(`party-private-${purpose}-v1\0${secret}`)
    .digest();
}
export function encryptPrivate(value: string, purpose: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decryptPrivate(value: string, purpose: string) {
  try {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key(purpose),
      bytes.subarray(0, 12),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(
      "PRIVATE_KEY",
      "无法读取私密信息，请检查备份配套的服务器密钥",
      503,
    );
  }
}
