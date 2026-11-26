import { homedir } from "node:os";
import { join } from "node:path";
import type { StandaloneRelease } from "./runtime-bundle.ts";

declare const __executorRoot: string;
declare const executorRelease: StandaloneRelease;

process.env.EXECUTOR_GIT_DIRECTORY = join(__executorRoot, "runtime", "git");
process.env.EXECUTOR_DATA_DIR ??= join(homedir(), ".executor", "v2", "cli");
process.env.EXECUTOR_BUILD_VERSION = executorRelease.version;
process.env.EXECUTOR_LAUNCHER ??= process.execPath;
if (executorRelease.analytics !== undefined) {
  process.env.EXECUTOR_POSTHOG_PUBLIC_KEY = executorRelease.analytics.key;
  process.env.EXECUTOR_POSTHOG_HOST = executorRelease.analytics.host;
}
await import("../../apps/local/server/src/bin.ts");
