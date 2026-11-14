import { defineConfig } from "vitest/config";

/** Runs the macOS staple repeat and the patched @electron/notarize against a stub xcrun. */
export default defineConfig({
  test: { include: ["e2e/tests/macos-staple.spec.ts"], testTimeout: 60_000 },
});
