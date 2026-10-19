import { executeTestPlan, parseTestOptions } from "./test-runner-plan.mjs";
import { createTestRuntime } from "./test-runner-runtime.mjs";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
let runtime;
try {
  const options = parseTestOptions(process.argv.slice(2));
  runtime = createTestRuntime(options, { signal: controller.signal });
  await executeTestPlan(options, runtime);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await runtime?.close();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
