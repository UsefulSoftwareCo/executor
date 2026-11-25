import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
import {
  packagedEngineSpecs,
  packagedEngineUnchanged,
  packagedEngineVariable,
} from "./packaged-engine.ts";

const longestFirst = [
  "docker-release-workflow-idle-window.spec.ts",
  "docker-release-workflow-stopped.spec.ts",
  "docker-release-workflow-restart.spec.ts",
  "workflow-engine.spec.ts",
  "docker-release-workflow-sleeping.spec.ts",
  "docker-release.spec.ts",
  "docker-release-workflow-memory.spec.ts",
];
const rank = (file: string) => {
  const index = longestFirst.findIndex((name) => file.endsWith(`/${name}`));
  return index === -1 ? longestFirst.length : index;
};

export default defineConfig({
  test: {
    update: snapshotUpdate(),
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
      "e2e/tests/docker-release-runtime-files.spec.ts",
      "e2e/tests/docker-release-stall.spec.ts",
      "e2e/tests/docker-release-stall-load.spec.ts",
      "e2e/tests/docker-release-workflow-memory.spec.ts",
      "e2e/tests/docker-release-workflow-idle-window.spec.ts",
      "e2e/tests/docker-release-workflow-restart.spec.ts",
      "e2e/tests/docker-release-workflow-sleeping.spec.ts",
      "e2e/tests/docker-release-workflow-stopped.spec.ts",
      "e2e/tests/docker-oauth-renewal.spec.ts",
      "e2e/tests/workflow-engine.spec.ts",
    ],
    exclude:
      process.env[packagedEngineVariable] === packagedEngineUnchanged
        ? [...packagedEngineSpecs]
        : [],
    testTimeout: 180_000,
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
