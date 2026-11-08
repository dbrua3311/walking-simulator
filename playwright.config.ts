import { defineConfig } from "@playwright/test";
import path from "node:path";
const storage =
  process.env.WALKING_STORAGE_ROOT ?? "/mnt/piper-usb/walking-simulator";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  outputDir: path.join(storage, "artifacts/test-results"),
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.join(storage, "artifacts/playwright-report"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:5187",
    headless: true,
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
    viewport: { width: 1536, height: 980 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "bash scripts/run.sh exec -- vite preview --host 127.0.0.1 --port 5187 --strictPort",
    url: "http://127.0.0.1:5187",
    reuseExistingServer: false,
  },
});
