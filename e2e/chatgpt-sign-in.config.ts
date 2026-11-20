import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Exercises an explicitly configured ChatGPT preview without creating any accounts. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/chatgpt-sign-in.spec.ts"],
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
