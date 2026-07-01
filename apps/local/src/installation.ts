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

// The desktop main process sets `EXECUTOR_CLIENT=desktop` when it spawns the
// sidecar. Otherwise this headless apps/local server was launched by the
// `executor` CLI (`executor mcp`, `web`, `daemon run --foreground`, or the
// installed background service), so it reports as `cli`. Surface is only ever
// `cli` or `desktop`; mirrors the owner.client resolution in apps/cli/src/main.ts.
const resolveClient = (): SurfaceClient =>
  process.env.EXECUTOR_CLIENT === "desktop" ? "desktop" : "cli";

export const CHANNEL: InstallationChannel = resolveChannel(LOCAL_VERSION);
export const VERSION: string = LOCAL_VERSION;
export const USER_AGENT: string = buildUserAgent({
  channel: CHANNEL,
  version: VERSION,
  client: resolveClient(),
});
