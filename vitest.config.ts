import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: { alias: [{ find: /^\.\.\/dist\/(.+)\.js$/, replacement: fileURLToPath(new URL("./src/", import.meta.url)) + "$1.ts" }] },
  test: { maxWorkers: 4, exclude: [...configDefaults.exclude, "community/**", "artifacts/**", "release/**"] }
});
