import { defineConfig } from "vitest/config";

/** Runs the Worker upload size check as a process on uploads written beforehand, without building. */
export default defineConfig({
  test: { include: ["e2e/tests/worker-sizes.spec.ts"], testTimeout: 30_000 },
});
