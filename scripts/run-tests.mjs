import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const root = await mkdtemp(join(tmpdir(), "party-up-tests-"));
const databaseUrl = "file:" + join(root, "tests.db").replaceAll("\\", "/");
const token = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("hex");
const salt = randomBytes(16).toString("hex");
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  TRUST_PROXY: "0",
  PARTY_TEST_ROOT: root,
  PARTY_TEST_TOKEN: token,
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD_HASH:
    "scrypt:" + salt + ":" + scryptSync(password, salt, 64).toString("hex"),
  ADMIN_SESSION_SECRET: randomBytes(48).toString("hex"),
};
for (const key of [
  "TEST_BASE_URL",
  "TEST_ADMIN_PASSWORD",
  "NODE_OPTIONS",
  "NODE_TEST_CONTEXT",
])
  delete env[key];
const children = new Set();
function child(args, overrides = {}) {
  const p = spawn(process.execPath, args, {
    env: { ...env, ...overrides },
    stdio: "inherit",
  });
  children.add(p);
  p.once("exit", () => children.delete(p));
  return p;
}
function run(args, overrides) {
  return new Promise((resolve, reject) => {
    const p = child(args, overrides);
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("测试步骤失败，退出码 " + code)),
    );
  });
}
async function stop(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else p.kill("SIGTERM");
  for (let i = 0; i < 50 && p.exitCode === null && p.signalCode === null; i++)
    await new Promise((r) => setTimeout(r, 100));
  if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    for (const p of children) void stop(p);
  });
let service;
try {
  await writeFile(join(root, "tests.db"), "");
  const marker = { token, databaseUrl };
  const saveMarker = () =>
    writeFile(join(root, "test-context.json"), JSON.stringify(marker), {
      mode: 0o600,
    });
  await saveMarker();
  console.log("测试使用临时数据库，完成后自动清理。");
  await run(["node_modules/prisma/build/index.js", "generate"]);
  await run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  if (!process.argv.includes("--unit")) {
    await run(["node_modules/next/dist/bin/next", "build"], {
      NODE_ENV: "production",
    });
    const port = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
    const baseUrl = "http://127.0.0.1:" + port;
    marker.baseUrl = baseUrl;
    await saveMarker();
    env.TEST_BASE_URL = baseUrl;
    env.TEST_ADMIN_PASSWORD = password;
    service = child(
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { NODE_ENV: "production" },
    );
    service.on("error", (error) => console.error(error.message));
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (
        interrupted ||
        service.exitCode !== null ||
        service.signalCode !== null
      )
        throw new Error("测试服务提前停止");
      try {
        const response = await fetch(baseUrl + "/api/health", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error("测试服务启动超时");
  }
  if (interrupted) throw new Error("测试已中断");
  if (process.argv.includes("--e2e")) {
    await run(["node_modules/@playwright/test/cli.js", "test"]);
  } else {
    const tests = (await readdir("tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => "tests/" + name);
    await run([
      "--import",
      "./scripts/test-preload.mjs",
      "--import",
      "tsx",
      "--test",
      ...tests,
    ]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop(service);
  for (const p of children) await stop(p);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
}
