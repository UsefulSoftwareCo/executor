import {
  buildUserAgent,
  type InstallationChannel,
  type SurfaceClient,
} from "@executor-js/integrations-registry";

const pkg = await import("../package.json");
const LOCAL_VERSION: string = pkg.version;

// A `-` in semver indicates a prerelease (beta train).
// TODO: source channel from release infra once it lands; mirrors apps/cli.
const resolveChannel = (version: string): InstallationChannel => {
  if (version.includes("-")) return "beta";
  if (version === "0.0.0" || version === "local") return "dev";
  return "stable";
};

// The surface is cli|desktop — never a "local" catch-all: the desktop main
// process marks its sidecar via EXECUTOR_CLIENT=desktop; everything else
// hosting apps/local (`executor web`, `daemon run --foreground`, stdio MCP)
// is the CLI. Mirrors resolveSurface in ./analytics.ts.
const resolveClient = (): SurfaceClient =>
  process.env.EXECUTOR_CLIENT === "desktop" ? "desktop" : "cli";

export const CHANNEL: InstallationChannel = resolveChannel(LOCAL_VERSION);
export const VERSION: string = LOCAL_VERSION;
export const USER_AGENT: string = buildUserAgent({
  channel: CHANNEL,
  version: VERSION,
  client: resolveClient(),
});
