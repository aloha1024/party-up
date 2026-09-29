import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { legacyIndexBenchmark } from "./benchmark-legacy-index.mjs";

export function benchmarkOptions(args) {
  if (args.length > 1 || args.some((arg) => arg !== "--large"))
    throw new Error("Usage: npm run benchmark:queries [-- --large]");
  return {
    rows: args.includes("--large") ? 50000 : 5000,
    warmups: 5,
    samples: 30,
  };
}

// Every worker gets its own checked temporary database. No caller database URL,
// HTTP endpoint, Node preload or administrator credential is inherited.
export async function isolatedBenchmark(phase, options) {
  const root = await mkdtemp(join(tmpdir(), "party-up-tests-"));
  const checkedRoot = await realpath(root);
  assert.equal(dirname(checkedRoot), await realpath(tmpdir()));
  assert.ok(basename(checkedRoot).startsWith("party-up-tests-"));
  const databaseUrl = "file:" + join(root, "tests.db").replaceAll("\\", "/");
  const token = randomBytes(32).toString("hex");
  let child;
  const stop = () => child?.kill("SIGTERM");
  try {
    await writeFile(join(root, "tests.db"), "");
    await writeFile(
      join(root, "test-context.json"),
      JSON.stringify({ token, databaseUrl }),
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      PARTY_TEST_ROOT: root,
      PARTY_TEST_TOKEN: token,
      ADMIN_SESSION_SECRET: "synthetic-benchmark-secret-not-for-deployment",
      TRUST_PROXY: "0",
    };
    for (const key of [
      "TEST_BASE_URL",
      "TEST_ADMIN_PASSWORD",
      "NODE_OPTIONS",
      "NODE_TEST_CONTEXT",
      "ADMIN_USERNAME",
      "ADMIN_PASSWORD_HASH",
    ])
      delete env[key];
    return await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [
          "--import",
          "./scripts/test-preload.mjs",
          "--import",
          "tsx",
          "scripts/benchmark-real-queries.mjs",
          phase,
          String(options.rows),
          String(options.warmups),
          String(options.samples),
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0)
          return reject(
            new Error(
              `Benchmark ${phase} failed (${signal ?? code}): ${stderr}`,
            ),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`Invalid benchmark worker output: ${stderr}`));
        }
      });
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await rm(checkedRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  }
}

async function main() {
  const options = benchmarkOptions(process.argv.slice(2));
  const timing = await isolatedBenchmark("timing", options);
  const diagnostic = await isolatedBenchmark("diagnostic", options);
  for (const [name, result] of Object.entries(timing.scenarios)) {
    if (result.resultDigest !== diagnostic.scenarios[name]?.resultDigest)
      throw new Error(`Timing/diagnostic fixture results differ: ${name}`);
  }
  const scenarios = Object.fromEntries(
    Object.entries(timing.scenarios).map(([name, value]) => [
      name,
      { ...value, ...diagnostic.scenarios[name] },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        options,
        limitations: [
          "Synthetic SQLite fixtures, sequential calls and one Prisma connection; not production load or HTTP latency.",
          "Warmup and fixture setup/verification are excluded; timing has no SQL logging or EXPLAIN.",
          "Prisma delegate calls and SQL statements are different measures. Transaction-control SQL is separate.",
          "Every claim warmup/sample uses a fresh fixture and key; cleanup happens outside measurement.",
          "The legacy section uses handwritten SQL and a separate in-memory SQLite engine, not application timings.",
          "Elapsed time is descriptive only; correctness and query-shape checks determine success.",
        ],
        actualQueries: {
          metadata: timing.metadata,
          diagnosticMetadata: diagnostic.metadata,
          scenarios,
        },
        legacyIndexComparison: legacyIndexBenchmark(options),
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
