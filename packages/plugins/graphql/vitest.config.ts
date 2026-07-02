import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    server: {
      deps: {
        inline: ["graphql", "graphql-yoga", "@graphql-tools", "@envelop", "@whatwg-node"],
      },
    },
  },
});
