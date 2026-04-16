import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@casegraph/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url)
      ),
      "@casegraph/cli/app": fileURLToPath(
        new URL("./packages/cli/src/app.ts", import.meta.url)
      )
    }
  },
  root: rootDir
});

