import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const keys = ["ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "ADMIN_SESSION_SECRET"];
function valid(config) {
  return (
    typeof config.ADMIN_USERNAME === "string" &&
    config.ADMIN_USERNAME.trim().length > 0 &&
    config.ADMIN_USERNAME.length <= 64 &&
    /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(
      config.ADMIN_PASSWORD_HASH || "",
    ) &&
    typeof config.ADMIN_SESSION_SECRET === "string" &&
    config.ADMIN_SESSION_SECRET.length >= 32
  );
}

/**
 * @param {{ db: import("@prisma/client").PrismaClient, configPath: string,
 * env?: Record<string, string | undefined>, log?: (message: string) => void }} options
 */
export async function initializeDockerAdmin({
  db,
  configPath,
  env = process.env,
  log = console.log,
}) {
  const existing = await db.adminCredential.findUnique({ where: { id: 1 } });
  const supplied = keys.some((key) => !!env[key]);
  let config;
  let temporaryPassword;
  if (supplied) {
    config = Object.fromEntries(keys.map((key) => [key, env[key]]));
    if (!valid(config))
      throw new Error(
        "管理员环境变量不完整或格式错误，请完整配置三项 ADMIN_* 变量，或全部留空以自动初始化。",
      );
  } else if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!valid(config))
      throw new Error(
        "持久化的管理员初始化配置无效，请恢复配置或通过 ADMIN_* 环境变量重置。",
      );
  } else {
    if (existing)
      throw new Error(
        "数据库中已有管理员，但缺少初始化配置。请恢复原有 ADMIN_* 环境变量或持久化配置，避免覆盖已有密码。",
      );
    temporaryPassword = randomBytes(18).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    config = {
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: `scrypt:${salt}:${scryptSync(temporaryPassword, salt, 64).toString("hex")}`,
      ADMIN_SESSION_SECRET: randomBytes(32).toString("hex"),
    };
  }
  const fingerprint = createHash("sha256")
    .update(`${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD_HASH}`)
    .digest("hex");
  // Persist only the password hash and signing secret in the mounted data volume.
  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(config) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporaryPath, configPath);
  const data = {
    username: config.ADMIN_USERNAME,
    passwordHash: config.ADMIN_PASSWORD_HASH,
    bootstrapFingerprint: fingerprint,
    mustChangePassword: true,
  };
  if (!existing) {
    await db.adminCredential.create({ data: { id: 1, ...data } });
  } else if (existing.bootstrapFingerprint !== fingerprint) {
    await db.adminCredential.update({
      where: { id: 1 },
      data: { ...data, sessionVersion: { increment: 1 } },
    });
  }
  Object.assign(env, config);
  if (temporaryPassword) {
    log(
      `管理员已自动初始化。\n账号：admin\n临时密码：${temporaryPassword}\n请保存临时密码，访问 /admin 完成首次改密。密码仅在此次初始化日志中输出。`,
    );
  } else {
    log(
      `管理员已就绪：${config.ADMIN_USERNAME}。保留已有密码；初始化配置已持久化。`,
    );
  }
}
