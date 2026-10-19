// Keep the execution plan independent of OS processes so orchestration failures
// and isolation boundaries can be tested without building or running the app.
export function parseTestOptions(
  argv,
  { platform = process.platform, env = process.env } = {},
) {
  const modes = new Map([
    ["--unit", "unit"],
    ["--e2e", "e2e"],
    ["--ci", "ci"],
  ]);
  if (argv.length > 1 || argv.some((argument) => !modes.has(argument)))
    throw new Error("测试参数无效；仅支持无参数、--unit、--e2e 或 --ci");
  const mode = modes.get(argv[0]) ?? "test";
  let cpuSet = null;
  if (env.PARTY_TEST_CPU_SET !== undefined) {
    const value = env.PARTY_TEST_CPU_SET;
    const cpus = typeof value === "string" ? value.split(",") : [];
    if (
      platform !== "linux" ||
      !/^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))?$/.test(value) ||
      cpus.some((cpu) => !Number.isSafeInteger(Number(cpu))) ||
      new Set(cpus).size !== cpus.length
    )
      throw new Error(
        "PARTY_TEST_CPU_SET 仅支持 Linux 上一至两个不重复的非负 CPU 编号，例如 0,1",
      );
    cpuSet = value;
  }
  return { mode, cpuSet };
}

export async function executeTestPlan(options, runtime) {
  const now = runtime.now ?? (() => performance.now());
  const log = runtime.log ?? console.log;
  const started = now();
  let generated = 0;
  let builds = 0;
  let passed = false;
  function checkInterrupted() {
    if (runtime.signal?.aborted) throw new Error("测试已中断");
  }
  async function step(name, phase, operation, cleanup = false) {
    if (!cleanup) checkInterrupted();
    const start = now();
    log(`[tests] phase=${phase} step=${name} start`);
    try {
      await operation();
      if (!cleanup) checkInterrupted();
      log(
        `[tests] phase=${phase} step=${name} passed durationMs=${Math.max(0, Math.round(now() - start))}`,
      );
    } catch (error) {
      log(
        `[tests] phase=${phase} step=${name} failed durationMs=${Math.max(0, Math.round(now() - start))}`,
      );
      throw error;
    }
  }
  async function stage(phase, generate, build) {
    checkInterrupted();
    const context = await runtime.createContext(phase);
    const cpuSet =
      options.mode === "ci" && phase === "business" ? options.cpuSet : null;
    try {
      if (generate)
        await step("generate", phase, () => {
          generated++;
          return runtime.run(
            ["node_modules/prisma/build/index.js", "generate"],
            context,
            cpuSet,
          );
        });
      await step("migrate", phase, () =>
        runtime.run(
          ["node_modules/prisma/build/index.js", "migrate", "deploy"],
          context,
          cpuSet,
        ),
      );
      if (build)
        await step("build", phase, () => {
          builds++;
          return runtime.run(
            ["node_modules/next/dist/bin/next", "build"],
            context,
            cpuSet,
          );
        });
      if (options.mode !== "unit")
        await step("service", phase, () =>
          runtime.startService(context, cpuSet),
        );
      if (phase === "browser")
        await step("browser-tests", phase, () =>
          runtime.run(
            ["node_modules/@playwright/test/cli.js", "test"],
            context,
            null,
          ),
        );
      else
        await step("business-tests", phase, async () => {
          const tests = await runtime.discoverTests();
          await runtime.run(
            [
              "--import",
              "./scripts/test-preload.mjs",
              "--import",
              "tsx",
              "--test",
              "--test-concurrency=1",
              ...tests,
            ],
            context,
            cpuSet,
          );
        });
    } finally {
      // No type check or next stage may begin until the complete previous
      // environment has stopped and its owned temporary directory is removed.
      await step("cleanup", phase, () => runtime.disposeContext(context), true);
    }
  }
  try {
    if (options.mode === "e2e") await stage("browser", true, true);
    else {
      await stage("business", true, options.mode !== "unit");
      if (options.mode === "ci") {
        await step("typecheck", "typecheck", () =>
          runtime.run(
            ["node_modules/typescript/bin/tsc", "--noEmit"],
            undefined,
            null,
          ),
        );
        await stage("browser", false, false);
      }
    }
    checkInterrupted();
    passed = true;
  } finally {
    log(
      `[tests] summary mode=${options.mode} generate=${generated} build=${builds} result=${passed ? "passed" : "failed"} durationMs=${Math.max(0, Math.round(now() - started))}`,
    );
  }
}
