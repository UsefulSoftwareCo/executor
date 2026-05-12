import {
  buildUserAgent,
  type InstallationChannel,
  type SurfaceClient,
} from "@executor-js/integrations-registry";

const pkg = await import("../../package.json");
const LOCAL_VERSION: string = pkg.version;

// A `-` in semver indicates a prerelease (beta train).
// TODO: source channel from release infra once it lands; mirrors apps/cli.
const resolveChannel = (version: string): InstallationChannel => {
  if (version.includes("-")) return "beta";
  if (version === "0.0.0" || version === "local") return "dev";
  return "stable";
};

// The desktop main process sets `EXECUTOR_CLIENT=desktop` when it spawns the
// sidecar so PostHog can slice desktop installs from headless apps/local
// (CLI `executor web`, `daemon run --foreground`, etc.).
const resolveClient = (): SurfaceClient =>
  process.env.EXECUTOR_CLIENT === "desktop" ? "desktop" : "local";

export const CHANNEL: InstallationChannel = resolveChannel(LOCAL_VERSION);
export const VERSION: string = LOCAL_VERSION;
export const USER_AGENT: string = buildUserAgent({
  channel: CHANNEL,
  version: VERSION,
  client: resolveClient(),
});
