import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  executeTestPlan,
  parseTestOptions,
} from "../scripts/test-runner-plan.mjs";
import { validateCpuSet } from "../scripts/test-runner-runtime.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(repository, "scripts/run-tests.mjs");
const fixtureModule = pathToFileURL(
  join(repository, "tests/support/test-runner-child.mjs"),
).href;

test("test runner accepts only distinct supported modes and bounded Linux CPU lists", () => {
  for (const [args, mode] of [
    [[], "test"],
    [["--unit"], "unit"],
    [["--e2e"], "e2e"],
    [["--ci"], "ci"],
  ] as const) {
    assert.deepEqual(
      parseTestOptions([...args], {
        platform: "linux",
        env: { NODE_ENV: "test" },
      }),
      { mode, cpuSet: null },
    );
  }
  for (const args of [
    ["--unknown"],
    ["--ci", "--unit"],
    ["--ci", "--e2e"],
    ["--unit", "--e2e"],
    ["--ci", "--ci"],
  ]) {
    assert.throws(() =>
      parseTestOptions(args, { platform: "linux", env: { NODE_ENV: "test" } }),
    );
  }
  for (const cpuSet of ["0", "4,12"]) {
    assert.equal(
      parseTestOptions(["--ci"], {
        platform: "linux",
        env: { NODE_ENV: "test", PARTY_TEST_CPU_SET: cpuSet },
      }).cpuSet,
      cpuSet,
    );
  }
  for (const cpuSet of [
    "",
    "0,0",
    "0,1,2",
    "-1",
    "0-1",
    " 0",
    "0, 1",
    "1,",
    "00",
    "01",
    "9007199254740992",
    "NaN",
    "1;echo unsafe",
    "1.5",
  ]) {
    assert.throws(
      () =>
        parseTestOptions(["--ci"], {
          platform: "linux",
          env: { NODE_ENV: "test", PARTY_TEST_CPU_SET: cpuSet },
        }),
      cpuSet,
    );
  }
  assert.throws(() =>
    parseTestOptions(["--ci"], {
      platform: "win32",
      env: { NODE_ENV: "test", PARTY_TEST_CPU_SET: "0" },
    }),
  );
});

test("every selected CPU must be available rather than relying on taskset intersection", () => {
  for (const selected of ["2", "2,5", "7,12"])
    validateCpuSet(selected, "2-5,7,12-13");
  for (const selected of ["0", "2,6", "12,14"])
    assert.throws(() => validateCpuSet(selected, "2-5,7,12-13"), /不可用/);
  for (const allowed of ["", "3-1", "2,,4", "unknown", "0-9007199254740992"])
    assert.throws(() => validateCpuSet("2", allowed), /范围/);
});

type PlanContext = { stage: string; id: number };
function planHarness(fail?: string) {
  const events: string[] = [];
  const calls: { step: string; cpu: string | null }[] = [];
  let id = 0;
  const controller = new AbortController();
  const step = (name: string, cpu: string | null = null) => {
    events.push(name);
    calls.push({ step: name, cpu });
    if (fail === name) throw new Error("fixture failure: " + name);
  };
  const runtime = {
    signal: controller.signal,
    now: () => 0,
    log: () => {},
    async createContext(stage: string) {
      step("create:" + stage);
      return { stage, id: ++id };
    },
    async run(
      args: string[],
      context: PlanContext | undefined,
      cpu: string | null,
    ) {
      const command = args.includes("--test")
        ? "business"
        : args[0].includes("prisma")
          ? args[1]
          : args[0].includes("typescript")
            ? "typecheck"
            : args[0].includes("playwright")
              ? "browser"
              : args[1];
      step(command + ":" + (context?.stage ?? "none"), cpu);
    },
    async startService(context: PlanContext, cpu: string | null) {
      step("start:" + context.stage, cpu);
    },
    async disposeContext(context: PlanContext) {
      step("dispose:" + context.stage);
    },
    async discoverTests() {
      return ["tests/example.test.ts"];
    },
  };
  return { runtime, events, calls, controller };
}

test("CI plan builds once, finishes cleanup before typecheck, and applies affinity only to business", async () => {
  const { runtime, events, calls } = planHarness();
  await executeTestPlan({ mode: "ci", cpuSet: "2,4" }, runtime);
  assert.deepEqual(events, [
    "create:business",
    "generate:business",
    "migrate:business",
    "build:business",
    "start:business",
    "business:business",
    "dispose:business",
    "typecheck:none",
    "create:browser",
    "migrate:browser",
    "start:browser",
    "browser:browser",
    "dispose:browser",
  ]);
  assert.deepEqual(
    calls.filter((entry) => entry.cpu !== null).map((entry) => entry.step),
    [
      "generate:business",
      "migrate:business",
      "build:business",
      "start:business",
      "business:business",
    ],
  );
  for (const call of calls.filter((entry) => entry.cpu !== null))
    assert.equal(call.cpu, "2,4");
});

test("every failed CI step stops dependent work and disposes the current stage", async (t) => {
  const steps = [
    "generate:business",
    "migrate:business",
    "build:business",
    "start:business",
    "business:business",
    "dispose:business",
    "typecheck:none",
    "migrate:browser",
    "start:browser",
    "browser:browser",
    "dispose:browser",
  ];
  const successful = planHarness();
  await executeTestPlan({ mode: "ci", cpuSet: null }, successful.runtime);
  for (const failed of steps)
    await t.test(failed, async () => {
      const { runtime, events } = planHarness(failed);
      await assert.rejects(
        executeTestPlan({ mode: "ci", cpuSet: null }, runtime),
        /fixture failure/,
      );
      const stop = successful.events.indexOf(failed);
      const expected = successful.events.slice(0, stop + 1);
      if (!failed.startsWith("dispose:") && failed !== "typecheck:none")
        expected.push("dispose:" + failed.split(":")[1]);
      assert.deepEqual(events, expected);
    });
});

test("an interrupted plan still disposes its current context without starting another step", async () => {
  const { runtime, events, controller } = planHarness();
  runtime.startService = async (context) => {
    events.push("start:" + context.stage);
    controller.abort();
  };
  await assert.rejects(
    executeTestPlan({ mode: "ci", cpuSet: null }, runtime),
    /中断/,
  );
  assert.deepEqual(events, [
    "create:business",
    "generate:business",
    "migrate:business",
    "build:business",
    "start:business",
    "dispose:business",
  ]);
});

type FixtureEvent = {
  stage: string;
  pid: number;
  environment: Record<string, string | null>;
  marker: { token: string; databaseUrl: string; baseUrl?: string } | null;
};
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "party-up-runner-fixture-"));
  const log = join(directory, "commands.jsonl");
  const children = new Set<ChildProcess>();
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  };
  const wrapper = (kind: string) =>
    `import { runFixture } from ${JSON.stringify(fixtureModule)};\nawait runFixture(${JSON.stringify(kind)}, process.argv.slice(2));\n`;
  await write("package.json", JSON.stringify({ type: "module" }));
  await write("node_modules/package.json", JSON.stringify({ type: "module" }));
  for (const [path, kind] of [
    ["node_modules/prisma/build/index.js", "prisma"],
    ["node_modules/next/dist/bin/next", "next"],
    ["node_modules/typescript/bin/tsc", "typecheck"],
    ["node_modules/@playwright/test/cli.js", "browser"],
  ]) {
    const packageDirectory = path
      .split("/")
      .slice(0, path.startsWith("node_modules/@") ? 3 : 2)
      .join("/");
    await write(
      packageDirectory + "/package.json",
      JSON.stringify({ type: "module" }),
    );
    await write(path, wrapper(kind));
  }
  await write(
    "node_modules/tsx/package.json",
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  await write(
    "node_modules/tsx/index.mjs",
    `import ${JSON.stringify(pathToFileURL(join(repository, "node_modules/tsx/dist/loader.mjs")).href)};`,
  );
  await write(
    "scripts/test-preload.mjs",
    `import { assertIsolatedTestEnvironment } from ${JSON.stringify(pathToFileURL(join(repository, "scripts/test-isolation.mjs")).href)}; assertIsolatedTestEnvironment();`,
  );
  await write(
    "tests/fixture.test.ts",
    `import { runFixture } from ${JSON.stringify(fixtureModule)}; await runFixture(process.env.TEST_BASE_URL ? "business" : "unit");`,
  );
  // Windows terminate signals kill the process without invoking Node's handlers.
  // IPC emits the same event there; Linux exercises the real operating-system signal.
  await write(
    "signal-preload.mjs",
    `process.on("message", (signal) => { if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal); }); process.channel?.unref();`,
  );
  const readEvents = async (): Promise<FixtureEvent[]> => {
    if (!existsSync(log)) return [];
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  let stopping: Promise<void> | undefined;
  const stopChildren = () =>
    (stopping ??= (async () => {
      for (const child of children)
        await new Promise<void>((resolveStopped, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Fixture subprocess did not stop; temporary data preserved at " +
                    directory,
                ),
              ),
            10000,
          );
          child.once("close", () => {
            clearTimeout(timer);
            resolveStopped();
          });
          if (child.exitCode === null && child.signalCode === null) {
            if (process.platform === "win32" && child.connected)
              child.send("SIGTERM", () => {});
            else child.kill("SIGTERM");
          }
        });
    })());
  const abort = () => {
    void stopChildren().catch(() => {});
  };
  t.signal.addEventListener("abort", abort, { once: true });
  t.after(async () => {
    t.signal.removeEventListener("abort", abort);
    // Never remove a stage database before its owning runner has closed.
    // Failed termination deliberately leaves both directories for inspection.
    await stopChildren();
    const temp = await realpath(tmpdir());
    for (const event of await readEvents()) {
      const root = event.environment.PARTY_TEST_ROOT;
      if (!root || !existsSync(root)) continue;
      const actual = await realpath(root);
      assert.equal(dirname(actual), temp);
      assert.ok(basename(actual).startsWith("party-up-tests-"));
      await rm(actual, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const start = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RUNNER_FIXTURE_LOG: log,
      DATABASE_URL: "file:/ambient/never-use.db",
      PARTY_TEST_ROOT: "/ambient/never-use",
      PARTY_TEST_TOKEN: "ambient-token",
      TEST_BASE_URL: "http://ambient.invalid",
      TEST_ADMIN_PASSWORD: "ambient-password",
      ADMIN_SESSION_SECRET: "ambient-secret",
      NODE_OPTIONS: "--no-warnings",
      ...extra,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.PARTY_TEST_CPU_SET;
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(directory, "signal-preload.mjs")).href,
        runner,
        ...args,
      ],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.add(child);
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      output += chunk;
    });
    const done = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        resolveDone({ code, signal, output });
      });
    });
    return { child, done };
  };
  return { start, readEvents };
}

test(
  "real CI runner reuses one build with fresh databases, credentials, markers and services",
  { timeout: 30000 },
  async (t) => {
    const setup = await fixture(t);
    const result = await setup.start(["--ci"]).done;
    assert.equal(result.code, 0, result.output);
    const events = await setup.readEvents();
    assert.deepEqual(
      events.map((event) => event.stage),
      [
        "generate",
        "migrate-deploy",
        "build",
        "start",
        "business",
        "typecheck",
        "migrate-deploy",
        "start",
        "browser",
      ],
    );
    const phases = events.filter((event) => event.stage === "start");
    for (const key of [
      "DATABASE_URL",
      "PARTY_TEST_ROOT",
      "PARTY_TEST_TOKEN",
      "ADMIN_PASSWORD_HASH",
      "ADMIN_SESSION_SECRET",
      "TEST_BASE_URL",
      "TEST_ADMIN_PASSWORD",
    ])
      assert.ok(
        phases[0].environment[key] !== phases[1].environment[key],
        `${key} must differ across stages`,
      );
    for (const phase of phases) {
      assert.equal(existsSync(phase.environment.PARTY_TEST_ROOT!), false);
      for (const key of [
        "PARTY_TEST_TOKEN",
        "ADMIN_PASSWORD_HASH",
        "ADMIN_SESSION_SECRET",
        "TEST_ADMIN_PASSWORD",
      ])
        assert.ok(
          !result.output.includes(phase.environment[key]!),
          `${key} must not appear in runner logs`,
        );
      await assert.rejects(
        fetch(phase.environment.TEST_BASE_URL! + "/api/health", {
          signal: AbortSignal.timeout(500),
        }),
      );
    }
  },
);

test(
  "legacy default, unit and browser commands keep their standalone build behavior",
  { timeout: 60000 },
  async (t) => {
    for (const [args, expected] of [
      [[], ["generate", "migrate-deploy", "build", "start", "business"]],
      [["--unit"], ["generate", "migrate-deploy", "unit"]],
      [["--e2e"], ["generate", "migrate-deploy", "build", "start", "browser"]],
    ] as const)
      await t.test(args[0] ?? "default", async (subtest) => {
        const setup = await fixture(subtest);
        const result = await setup.start([...args]).done;
        assert.equal(result.code, 0, result.output);
        const events = await setup.readEvents();
        assert.deepEqual(
          events.map((event) => event.stage),
          [...expected],
        );
        for (const event of events)
          if (event.environment.PARTY_TEST_ROOT)
            assert.equal(existsSync(event.environment.PARTY_TEST_ROOT), false);
      });
  },
);

test(
  "real runner errors exit nonzero and do not enter later stages",
  { timeout: 60000 },
  async (t) => {
    for (const failed of [
      "migrate-deploy",
      "build",
      "start",
      "business",
      "typecheck",
      "browser",
    ])
      await t.test(failed, async (subtest) => {
        const setup = await fixture(subtest);
        const result = await setup.start(["--ci"], {
          RUNNER_FIXTURE_FAIL: failed,
        }).done;
        assert.notEqual(result.code, 0, result.output);
        const events = await setup.readEvents();
        assert.equal(events.at(-1)?.stage, failed);
        for (const event of events)
          if (event.environment.PARTY_TEST_ROOT)
            assert.equal(existsSync(event.environment.PARTY_TEST_ROOT), false);
      });
  },
);

test(
  "SIGINT and SIGTERM stop stage children, remove temporary data and prevent browser launch",
  { timeout: 60000 },
  async (t) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      await t.test(signal, async (subtest) => {
        const setup = await fixture(subtest);
        const running = setup.start(["--ci"], {
          RUNNER_FIXTURE_HOLD: "business",
        });
        const deadline = Date.now() + 15000;
        let events: FixtureEvent[] = [];
        while (Date.now() < deadline) {
          events = await setup.readEvents();
          if (events.some((event) => event.stage === "business")) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
        assert.ok(events.some((event) => event.stage === "business"));
        if (process.platform === "win32") running.child.send(signal);
        else running.child.kill(signal);
        const result = await running.done;
        assert.notEqual(result.code, 0, result.output);
        const final = await setup.readEvents();
        assert.equal(
          final.some(
            (event) => event.stage === "typecheck" || event.stage === "browser",
          ),
          false,
        );
        const service = final.find((event) => event.stage === "start")!;
        assert.equal(existsSync(service.environment.PARTY_TEST_ROOT!), false);
        await assert.rejects(
          fetch(service.environment.TEST_BASE_URL! + "/api/health", {
            signal: AbortSignal.timeout(500),
          }),
        );
      });
  },
);
