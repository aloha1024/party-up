import { defineConfig, devices } from "@playwright/test";
import { assertIsolatedTestEnvironment } from "./scripts/test-isolation.mjs";
assertIsolatedTestEnvironment();
if (!process.env.TEST_BASE_URL)
  throw new Error("Browser tests require the isolated runner");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.TEST_BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "webkit", use: { ...devices["iPhone 13"] } },
    {
      name: "http-fallback",
      testMatch: /identity\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.TEST_BASE_URL.replace(
          "127.0.0.1",
          "party-http.test",
        ),
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP party-http.test 127.0.0.1",
            "--no-proxy-server",
          ],
        },
      },
    },
  ],
});
