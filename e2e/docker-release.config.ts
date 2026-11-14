import { defineConfig } from "vitest/config";
import {
  packagedEngineSpecs,
  packagedEngineUnchanged,
  packagedEngineVariable,
} from "./packaged-engine.ts";

/**
 * The suite runs its files side by side and lasts as long as its longest file, the workflow idle
 * window's, about five minutes, when that file starts at once. Without timings from an earlier
 * run, which CI does not keep, Vitest starts the largest files first, and these small ones would
 * wait for a free worker. Longest first, from the release-docker lane's timings (seconds, median
 * of ten runs); the rest keep Vitest's order.
 */
const longestFirst = [
  "docker-release-workflow-idle-window.spec.ts", // 307
  "docker-release-workflow-stopped.spec.ts", // 275
  "docker-release-workflow-restart.spec.ts", // 242
  "workflow-engine.spec.ts", // 186
  "docker-release-workflow-sleeping.spec.ts", // 171
  "docker-release.spec.ts", // 146
  "docker-release-workflow-memory.spec.ts", // 146
];
const rank = (file: string) => {
  const index = longestFirst.findIndex((name) => file.endsWith(`/${name}`));
  return index === -1 ? longestFirst.length : index;
};

export default defineConfig({
  test: {
    include: [
      "e2e/tests/docker-release.spec.ts",
      "e2e/tests/docker-release-catalog.spec.ts",
      "e2e/tests/docker-release-app-memory.spec.ts",
      "e2e/tests/docker-release-collector-memory.spec.ts",
      "e2e/tests/docker-release-connections.spec.ts",
      "e2e/tests/docker-release-credential-handles.spec.ts",
      "e2e/tests/docker-release-executor-api.spec.ts",
      "e2e/tests/docker-release-trusted-proxies.spec.ts",
      "e2e/tests/docker-release-live-query.spec.ts",
      "e2e/tests/docker-release-mcp-session-release.spec.ts",
      "e2e/tests/docker-release-workflow-memory.spec.ts",
      "e2e/tests/docker-release-workflow-idle-window.spec.ts",
      "e2e/tests/docker-release-workflow-restart.spec.ts",
      "e2e/tests/docker-release-workflow-sleeping.spec.ts",
      "e2e/tests/docker-release-workflow-stopped.spec.ts",
      "e2e/tests/docker-oauth-renewal.spec.ts",
      "e2e/tests/workflow-engine.spec.ts",
    ],
    // CI's release-docker lane leaves out the packaged engine's scenarios on a pull request that
    // changes none of their inputs (e2e/packaged-engine.ts); every other run includes them.
    exclude:
      process.env[packagedEngineVariable] === packagedEngineUnchanged
        ? [...packagedEngineSpecs]
        : [],
    testTimeout: 180_000,
    // Every Docker network the scenarios use exists before the first starts; see
    // e2e/support/release-networks.ts.
    globalSetup: ["e2e/docker-release-networks.ts"],
    sequence: {
      sequencer: class {
        shard = <File>(files: Array<File>) => files;
        sort = <File extends { readonly moduleId: string }>(files: Array<File>) =>
          files
            .map((file, index) => ({ file, index }))
            .sort((a, b) => rank(a.file.moduleId) - rank(b.file.moduleId) || a.index - b.index)
            .map(({ file }) => file);
      },
    },
  },
});
