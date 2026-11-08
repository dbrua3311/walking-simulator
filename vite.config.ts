import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
const storage =
  process.env.WALKING_STORAGE_ROOT ?? "/mnt/piper-usb/walking-simulator";
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: { host: "127.0.0.1", port: 5186, strictPort: true },
  cacheDir: path.join(storage, "cache/vite"),
  build: {
    target: "es2022",
    outDir: path.join(storage, "artifacts/dist"),
    emptyOutDir: true,
  },
  test: {
    setupFiles: ["src/tests/setup.ts"],
    include: ["src/tests/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
});
