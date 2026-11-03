import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is src/client.
export default defineConfig({ test: { root: ".", include: ["test/**/*.test.ts"] } });
