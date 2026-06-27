/**
 * One registry for every Vitest project. A project names both the deployed
 * target and the execution policy used for that run. Keeping those separate
 * lets CI run a hermetic subset without inventing a second target factory.
 */

export type E2eCapability =
  | "api"
  | "billing"
  | "browser"
  | "claude-code"
  | "desktop-gui"
  | "mcp-oauth"
  | "opencode"
  | "restart"
  | "telemetry"
  | "ttl-control";

export type CapabilityRequirementMode = "allow-skips" | "required";
export type VisualDataClassification = "synthetic-only" | "potentially-sensitive";

interface E2eProjectDefinition {
  readonly name: string;
  readonly target: string;
  readonly include: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
  readonly globalSetup: ReadonlyArray<string>;
  readonly requiredCapabilities: ReadonlyArray<E2eCapability>;
  readonly fileParallelism: boolean;
  readonly testTimeout: number;
  readonly hookTimeout: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly tier: "portable" | "native-desktop" | "heavy-vm" | "manual";
  readonly hermetic: boolean;
}

const SHARED_SCENARIOS = "scenarios/**/*.test.ts";

/**
 * These scenarios intentionally verify public-service compatibility. They are
 * useful drift signals, but are not deterministic enough to gate pull requests.
 */
export const LIVE_DRIFT_SCENARIOS = [
  "scenarios/microsoft-graph-default.test.ts",
  "scenarios/microsoft-graph-full.test.ts",
  "scenarios/oauth-client-handoff.test.ts",
] as const;

const cloudCapabilities = [
  "api",
  "billing",
  "browser",
  "claude-code",
  "mcp-oauth",
  "opencode",
  "telemetry",
  "ttl-control",
] as const satisfies ReadonlyArray<E2eCapability>;
const selfhostCapabilities = [
  "api",
  "browser",
  "claude-code",
  "mcp-oauth",
  "opencode",
] as const satisfies ReadonlyArray<E2eCapability>;
const selfhostDockerCapabilities = [
  "api",
  "browser",
  "claude-code",
  "mcp-oauth",
  "opencode",
  "restart",
] as const satisfies ReadonlyArray<E2eCapability>;
const cloudflareCapabilities = [
  "api",
  "browser",
  "mcp-oauth",
] as const satisfies ReadonlyArray<E2eCapability>;

export const E2E_PROJECTS = [
  {
    name: "harness",
    target: "harness",
    include: ["harness/**/*.test.ts"],
    globalSetup: [],
    requiredCapabilities: [],
    fileParallelism: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    tier: "portable",
    hermetic: true,
  },
  {
    name: "clients",
    target: "clients",
    include: ["src/clients/**/*.test.ts"],
    globalSetup: [],
    requiredCapabilities: ["claude-code"],
    fileParallelism: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { E2E_CLAUDE_CODE_VERSION: "2.1.195" },
    tier: "portable",
    hermetic: true,
  },
  {
    name: "cloud",
    target: "cloud",
    include: [SHARED_SCENARIOS, "cloud/**/*.test.ts"],
    globalSetup: ["./setup/cloud.globalsetup.ts"],
    requiredCapabilities: cloudCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "manual",
    hermetic: false,
  },
  {
    name: "cloud-hermetic",
    target: "cloud",
    include: [SHARED_SCENARIOS, "cloud/**/*.test.ts"],
    exclude: LIVE_DRIFT_SCENARIOS,
    globalSetup: ["./setup/cloud.globalsetup.ts"],
    requiredCapabilities: cloudCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "portable",
    hermetic: true,
  },
  {
    name: "selfhost",
    target: "selfhost",
    include: [SHARED_SCENARIOS, "selfhost/**/*.test.ts"],
    globalSetup: ["./setup/selfhost.globalsetup.ts"],
    requiredCapabilities: selfhostCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "manual",
    hermetic: false,
  },
  {
    name: "selfhost-hermetic",
    target: "selfhost",
    include: [SHARED_SCENARIOS, "selfhost/**/*.test.ts"],
    exclude: LIVE_DRIFT_SCENARIOS,
    globalSetup: ["./setup/selfhost.globalsetup.ts"],
    requiredCapabilities: selfhostCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "portable",
    hermetic: true,
  },
  {
    name: "selfhost-docker",
    target: "selfhost-docker",
    include: [SHARED_SCENARIOS, "selfhost/**/*.test.ts"],
    globalSetup: ["./setup/selfhost-docker.globalsetup.ts"],
    requiredCapabilities: selfhostDockerCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "manual",
    hermetic: false,
  },
  {
    name: "selfhost-docker-hermetic",
    target: "selfhost-docker",
    include: [SHARED_SCENARIOS, "selfhost/**/*.test.ts"],
    exclude: LIVE_DRIFT_SCENARIOS,
    globalSetup: ["./setup/selfhost-docker.globalsetup.ts"],
    requiredCapabilities: selfhostDockerCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "portable",
    hermetic: true,
  },
  {
    name: "cloudflare",
    target: "cloudflare",
    include: [
      "scenarios/browser-approval.test.ts",
      "scenarios/microsoft-graph-full.test.ts",
      "scenarios/toolkits-mcp.test.ts",
      "cloudflare/**/*.test.ts",
    ],
    globalSetup: ["./setup/cloudflare.globalsetup.ts"],
    requiredCapabilities: cloudflareCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "manual",
    hermetic: false,
  },
  {
    name: "cloudflare-hermetic",
    target: "cloudflare",
    include: [
      "scenarios/browser-approval.test.ts",
      "scenarios/toolkits-mcp.test.ts",
      "cloudflare/**/*.test.ts",
    ],
    globalSetup: ["./setup/cloudflare.globalsetup.ts"],
    requiredCapabilities: cloudflareCapabilities,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "portable",
    hermetic: true,
  },
  {
    name: "desktop",
    target: "desktop",
    include: ["desktop/**/*.test.ts"],
    globalSetup: ["./setup/desktop.globalsetup.ts"],
    requiredCapabilities: [],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    tier: "native-desktop",
    hermetic: true,
  },
  {
    name: "desktop-packaged",
    target: "desktop-packaged",
    include: ["desktop-packaged/**/*.test.ts"],
    globalSetup: ["./setup/desktop-packaged.globalsetup.ts"],
    requiredCapabilities: [],
    fileParallelism: false,
    testTimeout: 360_000,
    hookTimeout: 600_000,
    tier: "native-desktop",
    hermetic: true,
  },
  {
    name: "desktop-kvm",
    target: "desktop-kvm",
    include: ["desktop-kvm/**/*.test.ts"],
    globalSetup: ["./setup/desktop-kvm.globalsetup.ts"],
    requiredCapabilities: ["desktop-gui"],
    fileParallelism: false,
    testTimeout: 360_000,
    hookTimeout: 900_000,
    env: { E2E_DESKTOP_GUI_REQUIRED: "1" },
    tier: "heavy-vm",
    hermetic: true,
  },
  {
    name: "local",
    target: "local",
    include: ["local/**/*.test.ts"],
    globalSetup: [],
    requiredCapabilities: ["browser"],
    fileParallelism: true,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    tier: "portable",
    hermetic: true,
  },
  {
    name: "cli-macos",
    target: "cli-macos",
    include: ["scenarios/restart-persistence.test.ts", "cli/**/*.test.ts"],
    globalSetup: ["./setup/cli-macos.globalsetup.ts"],
    requiredCapabilities: ["api", "restart"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 900_000,
    env: { E2E_VM_OS: "macos" },
    tier: "heavy-vm",
    hermetic: true,
  },
  {
    name: "cli-linux",
    target: "cli-linux",
    include: ["scenarios/restart-persistence.test.ts", "cli/**/*.test.ts"],
    globalSetup: ["./setup/cli-linux.globalsetup.ts"],
    requiredCapabilities: ["api", "restart"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 900_000,
    env: { E2E_VM_OS: "linux" },
    tier: "heavy-vm",
    hermetic: true,
  },
  {
    name: "cli-windows",
    target: "cli-windows",
    include: ["scenarios/restart-persistence.test.ts", "cli/**/*.test.ts"],
    globalSetup: ["./setup/cli-windows.globalsetup.ts"],
    requiredCapabilities: ["api", "restart"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 900_000,
    env: { E2E_VM_OS: "windows" },
    tier: "heavy-vm",
    hermetic: true,
  },
] as const satisfies ReadonlyArray<E2eProjectDefinition>;

export type E2eProjectName = (typeof E2E_PROJECTS)[number]["name"];

export const capabilityRequirementMode = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): CapabilityRequirementMode =>
  env.E2E_REQUIRED_CAPABILITY_MODE === "required" ? "required" : "allow-skips";

export const projectDefinition = (projectName: string) =>
  E2E_PROJECTS.find((project) => project.name === projectName);

/**
 * Visual publication policy belongs to the lane, not an individual test.
 * Hermetic lanes use controlled fixtures; live/manual lanes may touch data
 * whose provenance the evidence sanitizer cannot establish.
 */
export const visualDataClassificationForProject = (
  projectName: string,
): VisualDataClassification | undefined => {
  const project = projectDefinition(projectName);
  if (!project) return undefined;
  return project.hermetic ? "synthetic-only" : "potentially-sensitive";
};

export const requiredCapabilitiesFor = (projectName: string): ReadonlyArray<E2eCapability> =>
  projectDefinition(projectName)?.requiredCapabilities ?? [];

/**
 * Required mode is fail-closed for an unknown project. A typo in CI must not
 * turn a missing capability back into a green skip.
 */
export const isCapabilityRequired = (
  projectName: string,
  capability: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  if (capabilityRequirementMode(env) !== "required") return false;
  const project = projectDefinition(projectName);
  return project === undefined || project.requiredCapabilities.some((item) => item === capability);
};

export const currentProjectPolicy = (
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const projectName = env.E2E_PROJECT ?? env.E2E_TARGET ?? "";
  return {
    projectName,
    mode: capabilityRequirementMode(env),
    requiredCapabilities: requiredCapabilitiesFor(projectName),
  };
};
