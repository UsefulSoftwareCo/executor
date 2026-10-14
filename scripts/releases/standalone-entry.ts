/**
 * The release executable's entry. `bun build --compile` embeds this bundle; see
 * `bundleStandaloneRuntime` in runtime-bundle.ts for how modules find files on disk.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { packagedRuntimeEnvironment } from "./runtime-env.mjs";
import type { StandaloneRelease } from "./runtime-bundle.ts";

/** The install directory, from the bundle's banner. */
declare const __executorRoot: string;
/** The release identity, defined at build time. */
declare const executorRelease: StandaloneRelease;

Object.assign(
  process.env,
  packagedRuntimeEnvironment(process.env, join(__executorRoot, "runtime", "git")),
);
process.env.EXECUTOR_DATA_DIR ??= join(homedir(), ".executor", "v2", "cli");
process.env.EXECUTOR_BUILD_VERSION = executorRelease.version;
// The npm launcher names itself; started directly, the executable's own location shows how it
// was installed.
process.env.EXECUTOR_LAUNCHER ??= process.execPath;
if (executorRelease.analytics !== undefined) {
  process.env.EXECUTOR_POSTHOG_PUBLIC_KEY = executorRelease.analytics.key;
  process.env.EXECUTOR_POSTHOG_HOST = executorRelease.analytics.host;
}
await import("../../apps/local/server/src/bin.ts");
