import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const appRoot = resolve(__dirname, "../..");

export default defineConfig({
  root: appRoot,
  test: {
    include: ["test-fixtures/test-globalsetup-exit/fixture.test.ts"],
    globalSetup: [resolve(appRoot, "scripts/test-globalsetup.ts")],
  },
});
