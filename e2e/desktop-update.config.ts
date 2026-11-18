import { defineConfig } from "vitest/config";

/**
 * The desktop update scenario, on a development build of the desktop on macOS: it stands in for
 * Squirrel.Mac, which installs macOS updates. Run it after `node apps/local/desktop/scripts/build.mjs`
 * (e2e/README.md, "Desktop update"). The scenario itself refuses another platform or a
 * packaged build; this file only names it, as the CI selection reads every config on Linux.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/desktop-update.spec.ts"],
    testTimeout: 240_000,
    // Prints each desktop close's duration.
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
