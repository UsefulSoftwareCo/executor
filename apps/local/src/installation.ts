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

// EXECUTOR_CLIENT identifies which product launched this headless apps/local
// server: the desktop app sets `desktop` before spawning it, and the executor
// CLI sets `cli` (apps/cli stamps it at startup, see src/client-env.ts). It is
// therefore always set to a valid surface in a real launch, so we pass it
// through rather than guess. The `cli` floor only covers direct library/test
// imports that boot the server without going through a launcher.
const SURFACE_CLIENTS = ["cli", "desktop"] as const;
const resolveClient = (): SurfaceClient => {
  const client = process.env.EXECUTOR_CLIENT;
  return (SURFACE_CLIENTS as readonly string[]).includes(client ?? "")
    ? (client as SurfaceClient)
    : "cli";
};

export const CHANNEL: InstallationChannel = resolveChannel(LOCAL_VERSION);
export const VERSION: string = LOCAL_VERSION;
export const USER_AGENT: string = buildUserAgent({
  channel: CHANNEL,
  version: VERSION,
  client: resolveClient(),
});
