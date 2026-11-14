import { defineConfig } from "vitest/config";

/**
 * Starts `bun run e2e:*` and `bun run release:*` against a free-space floor no disk meets, and
 * `scripts/releases/prune-builds.ts` in a fake workspace holding old release builds.
 */
export default defineConfig({
  test: { include: ["e2e/tests/local-disk.spec.ts"], testTimeout: 60_000 },
});
