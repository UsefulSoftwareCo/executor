import { Schema } from "effect";
import { CloudReleaseNotes } from "@executor-js/utils/release-notes";
import type { Plugin } from "vite-plus";

const id = "virtual:cloud-release-notes";
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(CloudReleaseNotes));

/**
 * Cloud's "what's new" for this build: the notes JSON in `EXECUTOR_CLOUD_RELEASE_NOTES`, bundled as
 * `virtual:cloud-release-notes`. The build reads no history and fetches nothing; writing the notes
 * is a step of its own (`scripts/releases/release-notes.ts --cloud`).
 *
 * Two modes, by whether the input is given:
 * - With it, the dashboard shows these notes. Notes that do not decode fail the build. The Cloud
 *   stack sets it from the file the deploy names (src/infrastructure/release-notes.ts), and a
 *   production deploy refuses to build without one. The scenarios' local Cloud sets fixed notes
 *   (e2e/support/cloud-environment.ts).
 * - Without it, the build holds no notes and the dashboard shows no "What's new": development, a
 *   checkout's own builds, the site and Worker size checks, and any stage but production.
 */
export const cloudReleaseNotes = (): Plugin => ({
  name: "executor-cloud-release-notes",
  resolveId: (source) => (source === id ? `\0${id}` : undefined),
  load: (resolved) => {
    if (resolved !== `\0${id}`) return undefined;
    const input = process.env.EXECUTOR_CLOUD_RELEASE_NOTES;
    return `export default ${input === undefined ? "null" : JSON.stringify(decode(input))};`;
  },
});
