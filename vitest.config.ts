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
      "@caphtech/casegraph-core/experimental": fileURLToPath(
        new URL("./packages/core/src/experimental.ts", import.meta.url)
      ),
      "@caphtech/casegraph-core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url)
      ),
      "@caphtech/casegraph-cli/app": fileURLToPath(
        new URL("./packages/cli/src/app.ts", import.meta.url)
      )
    }
  },
  root: rootDir
});
