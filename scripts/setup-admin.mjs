import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
const file = ".env";
let env = existsSync(file)
  ? readFileSync(file, "utf8")
  : 'DATABASE_URL="file:./dev.db"\n';
if (
  /^ADMIN_PASSWORD_HASH=["']?scrypt:/m.test(env) &&
  !process.argv.includes("--reset")
)
  throw new Error(
    "管理员已存在。如需重置请运行 npm run admin:setup -- --reset",
  );
const password = randomBytes(18).toString("base64url");
const salt = randomBytes(16).toString("hex");
const values = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD_HASH: `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`,
  ADMIN_SESSION_SECRET: randomBytes(32).toString("hex"),
};
for (const [key, value] of Object.entries(values)) {
  env = env.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, "gm"), "");
  if (!env.endsWith("\n")) env += "\n";
  env += `${key}="${value}"\n`;
}
writeFileSync(file, env, { mode: 0o600 });
console.log(
  `管理员已初始化。账号：admin\n临时密码：${password}\n首次登录必须设置新密码；.env 只保存临时密码哈希。重启网站或重新创建 Docker 容器后生效。`,
);
