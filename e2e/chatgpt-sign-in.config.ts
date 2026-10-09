import { defineConfig } from "vitest/config";

/** Exercises an explicitly configured ChatGPT preview without creating any accounts. */
export default defineConfig({
  test: {
    include: ["e2e/tests/chatgpt-sign-in.spec.ts"],
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
