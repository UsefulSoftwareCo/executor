import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "schema/index": "src/schema/index.ts",
    "query/index": "src/query/index.ts",
    "adapters/index": "src/adapters/index.ts",
    "adapters/drizzle/index": "src/adapters/drizzle/index.ts",
    "adapters/kysely/index": "src/adapters/kysely/index.ts",
    "adapters/memory/index": "src/adapters/memory/index.ts",
    "cli/index": "src/cli/index.ts",
    cuid: "src/cuid.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: false,
  clean: true,
  external: [
    "@clack/prompts",
    "@paralleldrive/cuid2",
    "commander",
    "drizzle-orm",
    "kysely",
    "kysely-typeorm",
    "semver",
    "zod",
  ],
});
