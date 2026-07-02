import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {},
    "apps/cli": {},
    "apps/local": {
      entry: ["src/server.ts", "src/routes/**/*.tsx", "src/server/*.ts"],
    },
    "apps/cloud": {
      entry: ["src/server.ts", "src/routes/**/*.tsx", "src/server/*.ts"],
    },
    "apps/desktop": {
      entry: ["src/preload.ts"],
    },
    "apps/marketing": {
      entry: ["src/pages/**/*.astro", "src/pages/**/*.ts"],
    },
    "packages/react": {
      entry: [
        "src/api/*.tsx",
        "src/plugins/*.tsx",
        "src/pages/*.tsx",
        "src/components/*.tsx",
        "src/hooks/*.ts",
        "src/lib/*.ts",
      ],
    },
    "packages/core/*": {
      includeEntryExports: true,
    },
    "packages/kernel/*": {
      includeEntryExports: true,
    },
    "packages/hosts/*": {
      includeEntryExports: true,
    },
    "packages/plugins/keychain": {
      includeEntryExports: true,
    },
    "packages/plugins/file-secrets": {
      includeEntryExports: true,
    },
    "packages/plugins/google": {
      includeEntryExports: true,
    },
    "packages/plugins/onepassword": {
      includeEntryExports: true,
      ignoreDependencies: ["@executor-js/react"],
    },
    "packages/plugins/graphql": {
      includeEntryExports: true,
    },
    "packages/plugins/openapi": {
      includeEntryExports: true,
    },
    "packages/plugins/mcp": {
      includeEntryExports: true,
    },
  },
  ignore: [
    ".reference/**",
    "**/*.d.ts",
    "packages/kernel/runtime-deno-subprocess/src/deno-subprocess-worker.mjs",
  ],
  ignoreDependencies: ["bun-types"],
  ignoreBinaries: ["tar", "python3"],
};

export default config;
