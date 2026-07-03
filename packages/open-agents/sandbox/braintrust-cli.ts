import type { Sandbox } from "./interface";

export type BraintrustCliCredentials = {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly appUrl?: string;
  readonly org?: string;
  readonly project?: string;
};

const BRAINTRUST_CLI_SECRET_ENV = "OPEN_AGENTS_BRAINTRUST_CLI_SECRET";
const HOME_DIRECTORY_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;
const OPEN_AGENTS_DIRECTORY_NAME = ".open-agents";
const BRAINTRUST_ENV_FILE_NAME = "braintrust.env";
const BRAINTRUST_WRAPPER_PATH = "/usr/local/bin/bt";
const LOCAL_BIN_DIRECTORY_NAME = ".local/bin";
const BRAINTRUST_LOCAL_WRAPPER_NAME = "bt";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(
  value: Record<string, unknown>,
  key: keyof BraintrustCliCredentials,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${BRAINTRUST_CLI_SECRET_ENV}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: keyof BraintrustCliCredentials) {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

export function readBraintrustCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): BraintrustCliCredentials | undefined {
  const raw = env[BRAINTRUST_CLI_SECRET_ENV];
  if (!raw?.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${BRAINTRUST_CLI_SECRET_ENV} must be a JSON object`);
  }

  return {
    apiKey: requiredString(parsed, "apiKey"),
    ...(optionalString(parsed, "apiUrl") ? { apiUrl: optionalString(parsed, "apiUrl") } : {}),
    ...(optionalString(parsed, "appUrl") ? { appUrl: optionalString(parsed, "appUrl") } : {}),
    ...(optionalString(parsed, "org") ? { org: optionalString(parsed, "org") } : {}),
    ...(optionalString(parsed, "project") ? { project: optionalString(parsed, "project") } : {}),
  };
}

export function hasConfiguredBraintrustCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env[BRAINTRUST_CLI_SECRET_ENV]?.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderEnvFile(credentials: BraintrustCliCredentials) {
  const entries: Array<readonly [string, string]> = [
    ["BRAINTRUST_API_KEY", credentials.apiKey],
  ];

  if (credentials.apiUrl) {
    entries.push(["BRAINTRUST_API_URL", credentials.apiUrl]);
  }
  if (credentials.appUrl) {
    entries.push(["BRAINTRUST_APP_URL", credentials.appUrl]);
  }
  if (credentials.org) {
    entries.push(["BRAINTRUST_ORG_NAME", credentials.org]);
  }
  if (credentials.project) {
    entries.push(["BRAINTRUST_DEFAULT_PROJECT", credentials.project]);
  }

  return `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`;
}

function renderBraintrustWrapper(envFilePath: string) {
  return `#!/usr/bin/env bash
set -euo pipefail

BT_HOME="$HOME/${OPEN_AGENTS_DIRECTORY_NAME}/braintrust-home"
BT_BIN="$BT_HOME/.local/bin/bt"
ENV_FILE=${shellQuote(envFilePath)}

install_bt() {
  mkdir -p "$BT_HOME"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bt.dev/cli/install.sh | HOME="$BT_HOME" bash >/dev/null
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- https://bt.dev/cli/install.sh | HOME="$BT_HOME" bash >/dev/null
    return
  fi

  return 1
}

if [ ! -x "$BT_BIN" ]; then
  install_bt
fi

if [ ! -x "$BT_BIN" ]; then
  echo "Braintrust CLI requires curl or wget to install bt." >&2
  exit 127
fi

set -a
. "$ENV_FILE"
set +a

exec "$BT_BIN" "$@"
`;
}

async function resolveHomeDirectory(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.exec(
    'printf %s "$HOME"',
    sandbox.workingDirectory,
    HOME_DIRECTORY_TIMEOUT_MS,
  );
  if (!result.success || result.stdout.trim().length === 0) {
    throw new Error("Failed to resolve sandbox home directory");
  }
  return result.stdout.trim();
}

export async function installBraintrustCli(
  sandbox: Sandbox,
  credentials: BraintrustCliCredentials,
): Promise<void> {
  const homeDirectory = await resolveHomeDirectory(sandbox);
  const openAgentsDirectory = `${homeDirectory}/${OPEN_AGENTS_DIRECTORY_NAME}`;
  const localBinDirectory = `${homeDirectory}/${LOCAL_BIN_DIRECTORY_NAME}`;
  const envFilePath = `${openAgentsDirectory}/${BRAINTRUST_ENV_FILE_NAME}`;
  const localWrapperPath = `${localBinDirectory}/${BRAINTRUST_LOCAL_WRAPPER_NAME}`;
  const wrapper = renderBraintrustWrapper(envFilePath);

  await sandbox.mkdir(openAgentsDirectory, { recursive: true });
  await sandbox.mkdir(localBinDirectory, { recursive: true });
  await sandbox.writeFile(envFilePath, renderEnvFile(credentials), "utf-8");
  await sandbox.writeFile(BRAINTRUST_WRAPPER_PATH, wrapper, "utf-8");
  await sandbox.writeFile(localWrapperPath, wrapper, "utf-8");

  const permissionResult = await sandbox.exec(
    [
      `chmod 700 ${shellQuote(openAgentsDirectory)}`,
      `chmod 600 ${shellQuote(envFilePath)}`,
      `chmod 755 ${shellQuote(BRAINTRUST_WRAPPER_PATH)} ${shellQuote(localWrapperPath)}`,
    ].join(" && "),
    sandbox.workingDirectory,
    INSTALL_TIMEOUT_MS,
  );

  if (!permissionResult.success) {
    throw new Error(
      permissionResult.stderr.trim() ||
        permissionResult.stdout.trim() ||
        "Failed to configure Braintrust CLI permissions",
    );
  }
}

export async function installConfiguredBraintrustCli(sandbox: Sandbox): Promise<void> {
  const credentials = readBraintrustCliCredentials();
  if (!credentials) {
    return;
  }

  await installBraintrustCli(sandbox, credentials);
}
