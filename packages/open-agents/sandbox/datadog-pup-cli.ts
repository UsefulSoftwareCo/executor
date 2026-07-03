import type { Sandbox } from "./interface";

export type DatadogPupCliCredentials = {
  readonly apiKey: string;
  readonly appKey: string;
  readonly site?: string;
};

const DATADOG_PUP_CLI_SECRET_ENV = "OPEN_AGENTS_DATADOG_PUP_CLI_SECRET";
const HOME_DIRECTORY_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;
const OPEN_AGENTS_DIRECTORY_NAME = ".open-agents";
const DATADOG_ENV_FILE_NAME = "datadog.env";
const DATADOG_WRAPPER_PATH = "/usr/local/bin/pup";
const LOCAL_BIN_DIRECTORY_NAME = ".local/bin";
const DATADOG_LOCAL_WRAPPER_NAME = "pup";
const DEFAULT_DATADOG_SITE = "datadoghq.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(
  value: Record<string, unknown>,
  key: keyof DatadogPupCliCredentials,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${DATADOG_PUP_CLI_SECRET_ENV}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: keyof DatadogPupCliCredentials) {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

export function readDatadogPupCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): DatadogPupCliCredentials | undefined {
  const raw = env[DATADOG_PUP_CLI_SECRET_ENV];
  if (!raw?.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${DATADOG_PUP_CLI_SECRET_ENV} must be a JSON object`);
  }

  return {
    apiKey: requiredString(parsed, "apiKey"),
    appKey: requiredString(parsed, "appKey"),
    ...(optionalString(parsed, "site") ? { site: optionalString(parsed, "site") } : {}),
  };
}

export function hasConfiguredDatadogPupCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env[DATADOG_PUP_CLI_SECRET_ENV]?.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderEnvFile(credentials: DatadogPupCliCredentials) {
  const entries: Array<readonly [string, string]> = [
    ["DD_API_KEY", credentials.apiKey],
    ["DD_APP_KEY", credentials.appKey],
    ["DD_SITE", credentials.site ?? DEFAULT_DATADOG_SITE],
    ["FORCE_AGENT_MODE", "1"],
  ];

  return `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`;
}

function renderDatadogWrapper(envFilePath: string) {
  return `#!/usr/bin/env bash
set -euo pipefail

PUP_BIN="$HOME/${OPEN_AGENTS_DIRECTORY_NAME}/bin/pup"
ENV_FILE=${shellQuote(envFilePath)}

install_pup() {
  local tmp_dir
  local tag
  local version
  tmp_dir="$(mktemp -d)"

  tag="$(curl -fsSL https://api.github.com/repos/DataDog/pup/releases/latest | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -n 1)"
  version="\${tag#v}"

  if [ -z "$version" ]; then
    echo "Failed to resolve latest Datadog Pup release." >&2
    return 1
  fi

  curl -fsSL "https://github.com/DataDog/pup/releases/download/$tag/pup_\${version}_Linux_x86_64.tar.gz" | tar -xz -C "$tmp_dir"
  mkdir -p "$(dirname "$PUP_BIN")"
  install -m 755 "$tmp_dir/pup" "$PUP_BIN"
  rm -rf "$tmp_dir"
}

if [ ! -x "$PUP_BIN" ]; then
  install_pup
fi

if [ ! -x "$PUP_BIN" ]; then
  echo "Datadog Pup CLI requires curl and tar to install pup." >&2
  exit 127
fi

set -a
. "$ENV_FILE"
set +a

exec "$PUP_BIN" "$@"
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

export async function installDatadogPupCli(
  sandbox: Sandbox,
  credentials: DatadogPupCliCredentials,
): Promise<void> {
  const homeDirectory = await resolveHomeDirectory(sandbox);
  const openAgentsDirectory = `${homeDirectory}/${OPEN_AGENTS_DIRECTORY_NAME}`;
  const localBinDirectory = `${homeDirectory}/${LOCAL_BIN_DIRECTORY_NAME}`;
  const envFilePath = `${openAgentsDirectory}/${DATADOG_ENV_FILE_NAME}`;
  const localWrapperPath = `${localBinDirectory}/${DATADOG_LOCAL_WRAPPER_NAME}`;
  const wrapper = renderDatadogWrapper(envFilePath);

  await sandbox.mkdir(openAgentsDirectory, { recursive: true });
  await sandbox.mkdir(localBinDirectory, { recursive: true });
  await sandbox.writeFile(envFilePath, renderEnvFile(credentials), "utf-8");
  await sandbox.writeFile(DATADOG_WRAPPER_PATH, wrapper, "utf-8");
  await sandbox.writeFile(localWrapperPath, wrapper, "utf-8");

  const permissionResult = await sandbox.exec(
    [
      `chmod 700 ${shellQuote(openAgentsDirectory)}`,
      `chmod 600 ${shellQuote(envFilePath)}`,
      `chmod 755 ${shellQuote(DATADOG_WRAPPER_PATH)} ${shellQuote(localWrapperPath)}`,
    ].join(" && "),
    sandbox.workingDirectory,
    INSTALL_TIMEOUT_MS,
  );

  if (!permissionResult.success) {
    throw new Error(
      permissionResult.stderr.trim() ||
        permissionResult.stdout.trim() ||
        "Failed to configure Datadog Pup CLI permissions",
    );
  }
}

export async function installConfiguredDatadogPupCli(sandbox: Sandbox): Promise<void> {
  const credentials = readDatadogPupCliCredentials();
  if (!credentials) {
    return;
  }

  await installDatadogPupCli(sandbox, credentials);
}
