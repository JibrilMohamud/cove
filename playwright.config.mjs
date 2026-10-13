import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "scripts/browser-qa",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  retries: process.env.CI ? 1 : 0,
  maxFailures: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "artifacts/browser-qa/report" }],
    ["json", { outputFile: "artifacts/browser-qa/results.json" }],
  ],
  outputDir: "artifacts/browser-qa/runs",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/browser-qa-server.mjs",
    url: "http://127.0.0.1:4173/__qa/health",
    reuseExistingServer: false,
    timeout: 180000,
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
    { name: "android-chrome", use: { ...devices["Pixel 5"] } },
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
    { name: "ipad-safari", use: { ...devices["iPad (gen 7)"] } },
  ],
});
