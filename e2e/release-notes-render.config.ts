import { defineConfig } from "vitest/config";

/** Sends the notes `scripts/releases/release-notes.ts` writes to GitHub's Markdown API and reads the HTML. Needs GH_TOKEN. */
export default defineConfig({
  test: { include: ["e2e/tests/release-notes-render.spec.ts"], testTimeout: 60_000 },
});
