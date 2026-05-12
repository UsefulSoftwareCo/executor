import { buildUserAgent, type InstallationChannel } from "@executor-js/integrations-registry";

const pkg = await import("../package.json");
const CLI_VERSION: string = pkg.version;

// A `-` in semver indicates a prerelease, which we publish on the beta channel.
// TODO: source channel from release infra once it lands; for now this matches
// the heuristic in src/release.ts.
const resolveChannel = (version: string): InstallationChannel => {
  if (version.includes("-")) return "beta";
  if (version === "0.0.0" || version === "local") return "dev";
  return "stable";
};

export const CHANNEL: InstallationChannel = resolveChannel(CLI_VERSION);
export const VERSION: string = CLI_VERSION;
export const USER_AGENT: string = buildUserAgent({
  channel: CHANNEL,
  version: VERSION,
  client: "cli",
});
