import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { AppError } from "./errors";
function key() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError(
      "INVITATION_CONFIG",
      "服务器尚未配置有效的邀请加密密钥",
      503,
    );
  return createHash("sha256")
    .update("party-invitation-v1\0" + secret)
    .digest();
}
export function newInvitation() {
  const token = randomBytes(32).toString("hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return {
    inviteHash: createHash("sha256").update(token).digest("hex"),
    inviteCipher: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    ),
  };
}
export function decryptInvitation(value: string) {
  try {
    const bytes = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(
      "INVITATION_KEY",
      "无法读取邀请，请检查备份配套的服务器密钥",
      503,
    );
  }
}
