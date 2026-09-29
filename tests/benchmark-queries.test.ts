import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { benchmarkOptions } from "../scripts/benchmark-queries.mjs";

test("benchmark accepts only bounded synthetic sizes and no caller database", () => {
  assert.deepEqual(benchmarkOptions([]), {
    rows: 5000,
    warmups: 5,
    samples: 30,
  });
  assert.deepEqual(benchmarkOptions(["--large"]), {
    rows: 50000,
    warmups: 5,
    samples: 30,
  });
  for (const args of [
    ["--rows", "10000000"],
    ["--database", "file:./data/reservations.db"],
    ["--large", "--large"],
  ]) {
    assert.throws(() => benchmarkOptions(args), /Usage:/);
  }
});

test("direct benchmark worker rejects an unmarked database before opening it", async () => {
  const root = await mkdtemp(join(tmpdir(), "benchmark-guard-check-"));
  const path = join(root, "existing.db");
  const sentinel = Buffer.from(
    "This is an existing file that must never be opened as a benchmark database.",
  );
  try {
    await writeFile(path, sentinel);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: "file:" + path.replaceAll("\\", "/"),
    };
    delete env.PARTY_TEST_ROOT;
    delete env.PARTY_TEST_TOKEN;
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/benchmark-real-queries.mjs",
          "timing",
          "5000",
          "5",
          "30",
        ],
        { env, timeout: 10000 },
      ),
      (error: unknown) =>
        error instanceof Error && /测试仅允许/.test(error.message),
    );
    assert.deepEqual(await readFile(path), sentinel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
