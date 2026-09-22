import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export function assertIsolatedTestEnvironment(env = process.env) {
  const root = env.PARTY_TEST_ROOT;
  const fail = () => {
    throw new Error(
      "测试仅允许通过 npm test 或 npm run test:unit 在自动创建的临时数据库上运行",
    );
  };
  if (!root || !env.PARTY_TEST_TOKEN || env.PARTY_TEST_TOKEN.length < 32)
    return fail();
  try {
    const actual = realpathSync(root);
    if (
      dirname(actual) !== realpathSync(tmpdir()) ||
      !basename(actual).startsWith("party-up-tests-")
    )
      return fail();
    const marker = JSON.parse(
      readFileSync(join(root, "test-context.json"), "utf8"),
    );
    const database = join(actual, "tests.db");
    const url = "file:" + database.replaceAll("\\", "/");
    if (
      marker.token !== env.PARTY_TEST_TOKEN ||
      marker.databaseUrl !== url ||
      env.DATABASE_URL !== url ||
      realpathSync(database) !== database ||
      (env.TEST_BASE_URL && marker.baseUrl !== env.TEST_BASE_URL)
    )
      return fail();
    return actual;
  } catch {
    return fail();
  }
}
