import { Schema } from "effect";
import { CloudReleaseNotes } from "@executor-js/utils/release-notes";
import type { Plugin } from "vite-plus";

const id = "virtual:cloud-release-notes";
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(CloudReleaseNotes));

export const cloudReleaseNotes = (): Plugin => ({
  name: "executor-cloud-release-notes",
  resolveId: (source) => (source === id ? `\0${id}` : undefined),
  load: (resolved) => {
    if (resolved !== `\0${id}`) return undefined;
    const input = process.env.EXECUTOR_CLOUD_RELEASE_NOTES;
    return `export default ${input === undefined ? "null" : JSON.stringify(decode(input))};`;
  },
});
