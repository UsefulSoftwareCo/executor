import { defineConfig } from "vitest/config";

/** Runs Cloud's outbound routes and relay objects on the workerd local Cloud uses, against a service it holds. */
export default defineConfig({
  test: { include: ["e2e/tests/outbound-routes.spec.ts"], testTimeout: 120_000 },
});
