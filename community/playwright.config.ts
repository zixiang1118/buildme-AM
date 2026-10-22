import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"]
  .filter(Boolean)
  .join(",");
process.env.no_proxy = process.env.NO_PROXY;
process.env.COMMUNITY_BROWSER_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), "buildme-browser-"),
);
export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: {
    baseURL: "http://localhost:3198",
    viewport: { width: 1440, height: 1000 },
    launchOptions: { channel: "chrome" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "output/playwright/results",
  reporter: "list",
  webServer: {
    command: "node --import tsx scripts/browser-server.ts",
    url: "http://127.0.0.1:3198/healthz",
    reuseExistingServer: false,
    timeout: 30000,
  },
  globalTeardown: "./test/browser/teardown.ts",
});
