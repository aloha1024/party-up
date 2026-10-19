import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:net";

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function validateCpuSet(cpuSet, allowedList) {
  const ranges = allowedList
    .trim()
    .split(",")
    .map((part) => {
      if (!/^\d+(?:-\d+)?$/.test(part))
        throw new Error("无法验证可用 CPU 范围");
      const [start, end = start] = part.split("-").map(Number);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start
      )
        throw new Error("无法验证可用 CPU 范围");
      return [start, end];
    });
  for (const cpu of cpuSet.split(",").map(Number))
    if (!ranges.some(([start, end]) => cpu >= start && cpu <= end))
      throw new Error("PARTY_TEST_CPU_SET 包含当前进程不可用的 CPU 编号");
}

function safeEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (
      key.startsWith("TEST_") ||
      key.startsWith("PARTY_TEST_") ||
      [
        "NODE_OPTIONS",
        "NODE_TEST_CONTEXT",
        "DATABASE_URL",
        "ADMIN_USERNAME",
        "ADMIN_PASSWORD_HASH",
        "ADMIN_SESSION_SECRET",
      ].includes(key)
    )
      delete env[key];
  return env;
}

export function createTestRuntime(
  options,
  {
    env: parentEnv = process.env,
    platform = process.platform,
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    log = console.log,
    now = () => performance.now(),
    signal,
    readAllowedCpuSet = () => {
      const status = readFileSync("/proc/self/status", "utf8");
      const match = /^Cpus_allowed_list:\s*(.+)$/m.exec(status);
      if (!match) throw new Error("无法读取当前进程的可用 CPU 范围");
      return match[1];
    },
  } = {},
) {
  if (options.cpuSet) validateCpuSet(options.cpuSet, readAllowedCpuSet());
  const baseEnv = safeEnvironment(parentEnv);
  const contexts = new Map();
  const processes = new Set();
  const usedPorts = new Set();
  function checkInterrupted() {
    if (signal?.aborted) throw new Error("测试已中断");
  }
  function groupAlive(record) {
    if (!record.child.pid) return false;
    if (platform === "win32") return !record.done;
    try {
      process.kill(-record.child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
  function signalGroup(record, name) {
    if (!record.child.pid) return;
    try {
      process.kill(-record.child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  async function untilStopped(record, milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (!record.done || groupAlive(record)) {
      if (Date.now() >= deadline) return false;
      await delay(50);
    }
    return true;
  }
  function stop(record) {
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      if (platform === "win32") {
        // Preserve the existing Windows taskkill boundary. This confirms the
        // direct process exits; unlike POSIX groups it cannot prove that an
        // already-exited leader left no detached/orphaned grandchildren.
        if (!record.done && record.child.pid)
          spawnSyncImpl(
            "taskkill",
            ["/pid", String(record.child.pid), "/T", "/F"],
            {
              stdio: "ignore",
              windowsHide: true,
              timeout: 5000,
            },
          );
        if (!(await untilStopped(record, 5000)))
          throw new Error("测试子进程树未能退出，保留测试临时目录");
      } else {
        // Each direct child owns a process group. Include descendants whose
        // immediate parent has already exited or ignores termination.
        if (groupAlive(record)) signalGroup(record, "SIGTERM");
        if (!(await untilStopped(record, 5000))) {
          signalGroup(record, "SIGKILL");
          if (!(await untilStopped(record, 2000)))
            throw new Error("测试子进程树未能退出，保留测试临时目录");
        }
      }
      processes.delete(record);
      if (record.context)
        contexts.get(record.context)?.processes.delete(record);
    })();
    return record.stopping;
  }
  function launch(args, context, cpuSet, production = false) {
    checkInterrupted();
    const childEnv = {
      ...(context?.env ?? baseEnv),
      ...(production ? { NODE_ENV: "production" } : {}),
    };
    const command = cpuSet ? "taskset" : process.execPath;
    const commandArgs = cpuSet
      ? ["-c", cpuSet, process.execPath, ...args]
      : args;
    const child = spawnImpl(command, commandArgs, {
      env: childEnv,
      stdio: "inherit",
      windowsHide: true,
      detached: platform !== "win32",
    });
    const record = {
      child,
      context,
      done: false,
      stopping: undefined,
      completed: null,
    };
    record.completed = new Promise((resolve) => {
      let settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        record.done = true;
        resolve(result);
      }
      child.once("error", (error) => finish({ error }));
      child.once("exit", (code, exitSignal) => finish({ code, exitSignal }));
    });
    processes.add(record);
    if (context) contexts.get(context).processes.add(record);
    return record;
  }
  async function completion(record) {
    let onAbort;
    const interrupted = new Promise((resolve) => {
      onAbort = () => resolve({ interrupted: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      const result = await Promise.race([record.completed, interrupted]);
      if (result.interrupted) throw new Error("测试已中断");
      if (result.error)
        throw new Error(
          "无法启动测试子进程：" + (result.error.code ?? "UNKNOWN"),
        );
      if (result.code !== 0)
        throw new Error(
          "测试步骤失败，退出码 " +
            (result.code ?? result.exitSignal ?? "UNKNOWN"),
        );
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  const onAbort = () => {
    // Cleanup awaits these same promises and retains the directory on failure.
    for (const record of processes) void stop(record).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);

  async function removeOwnedDirectory(owner) {
    const actual = await realpath(owner.root);
    const stat = await lstat(owner.root);
    if (
      stat.isSymbolicLink() ||
      actual !== owner.realRoot ||
      dirname(actual) !== (await realpath(tmpdir())) ||
      !basename(actual).startsWith("party-up-tests-") ||
      stat.dev !== owner.dev ||
      stat.ino !== owner.ino
    )
      throw new Error("测试临时目录不再匹配创建时的目录，拒绝清理");
    await rm(owner.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  }
  async function createContext(stage) {
    checkInterrupted();
    const root = await mkdtemp(join(tmpdir(), "party-up-tests-"));
    const owner = {
      root,
      realRoot: null,
      dev: null,
      ino: null,
      processes: new Set(),
      password: null,
      marker: null,
    };
    try {
      const stat = await lstat(root);
      owner.realRoot = await realpath(root);
      owner.dev = stat.dev;
      owner.ino = stat.ino;
      owner.password = randomBytes(24).toString("hex");
      const databaseUrl =
        "file:" + join(root, "tests.db").replaceAll("\\", "/");
      const token = randomBytes(32).toString("hex");
      const salt = randomBytes(16).toString("hex");
      const context = {
        root,
        stage,
        env: {
          ...baseEnv,
          DATABASE_URL: databaseUrl,
          NODE_ENV: "test",
          TRUST_PROXY: "0",
          PARTY_TEST_ROOT: root,
          PARTY_TEST_TOKEN: token,
          ADMIN_USERNAME: "admin",
          ADMIN_PASSWORD_HASH:
            "scrypt:" +
            salt +
            ":" +
            scryptSync(owner.password, salt, 64).toString("hex"),
          ADMIN_SESSION_SECRET: randomBytes(48).toString("hex"),
        },
      };
      owner.marker = { token, databaseUrl };
      await writeFile(join(root, "tests.db"), "", { mode: 0o600 });
      await writeFile(
        join(root, "test-context.json"),
        JSON.stringify(owner.marker),
        { mode: 0o600 },
      );
      contexts.set(context, owner);
      log(`[tests] phase=${stage} 使用全新临时数据库与独立身份配置`);
      return context;
    } catch (error) {
      try {
        if (owner.realRoot === null || owner.dev === null || owner.ino === null)
          throw new Error("无法确认测试临时目录归属，拒绝清理");
        await removeOwnedDirectory(owner);
      } catch (cleanupError) {
        log(`[tests] 初始化失败，保留临时目录：${owner.root}`);
        throw cleanupError;
      }
      throw error;
    }
  }
  async function run(args, context, cpuSet) {
    const production =
      args[0] === "node_modules/next/dist/bin/next" && args[1] === "build";
    const record = launch(args, context, cpuSet, production);
    try {
      await completion(record);
    } finally {
      // Reap every command immediately, including lingering process groups.
      // Do not retain exited command IDs until the end of a long test stage.
      await stop(record);
    }
  }
  async function startService(context, cpuSet) {
    const owner = contexts.get(context);
    if (!owner) throw new Error("未知的测试环境");
    let port;
    for (let attempt = 0; attempt < 10; attempt++) {
      checkInterrupted();
      const candidate = await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const port = probe.address().port;
          probe.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
      if (!usedPorts.has(candidate)) {
        usedPorts.add(candidate);
        port = candidate;
        break;
      }
    }
    if (port === undefined) throw new Error("无法分配独立的测试端口");
    checkInterrupted();
    const baseUrl = "http://127.0.0.1:" + port;
    owner.marker.baseUrl = baseUrl;
    await writeFile(
      join(owner.root, "test-context.json"),
      JSON.stringify(owner.marker),
      { mode: 0o600 },
    );
    context.env.TEST_BASE_URL = baseUrl;
    context.env.TEST_ADMIN_PASSWORD = owner.password;
    const record = launch(
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      context,
      cpuSet,
      true,
    );
    for (let attempt = 0; attempt < 90; attempt++) {
      checkInterrupted();
      if (record.done) throw new Error("测试服务提前停止");
      try {
        const response = await fetch(baseUrl + "/api/health", {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {}
      await delay(500);
    }
    throw new Error("测试服务启动超时");
  }
  async function disposeContext(context) {
    const owner = contexts.get(context);
    if (!owner) throw new Error("拒绝清理未知的测试环境");
    try {
      const results = await Promise.allSettled([...owner.processes].map(stop));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw failures[0].reason;
      await removeOwnedDirectory(owner);
      contexts.delete(context);
    } catch (error) {
      log(`[tests] 清理失败，保留临时目录：${owner.root}`);
      throw error;
    }
  }
  async function close() {
    signal?.removeEventListener("abort", onAbort);
    const results = await Promise.allSettled([...processes].map(stop));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      // Failed termination must not keep the runner alive indefinitely. The
      // owned directory remains intact and inherited stdio has no owned pipes.
      for (const record of processes) record.child.unref();
      throw failure.reason;
    }
  }
  return {
    createContext,
    run,
    startService,
    disposeContext,
    discoverTests: async () =>
      (await readdir("tests"))
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => "tests/" + name),
    close,
    signal,
    log,
    now,
  };
}
