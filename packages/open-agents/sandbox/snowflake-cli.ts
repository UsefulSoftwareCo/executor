import type { Sandbox } from "./interface";

export type SnowflakeCliCredentials = {
  readonly account: string;
  readonly private_key: string;
  readonly role: string;
  readonly user: string;
  readonly warehouse: string;
  readonly database?: string;
  readonly schema?: string;
};

const SNOWFLAKE_CLI_SECRET_ENV = "OPEN_AGENTS_SNOWFLAKE_CLI_SECRET";
const HOME_DIRECTORY_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;
const SNOWFLAKE_CONFIG_DIRECTORY_NAME = ".snowflake";
const SNOWFLAKE_CONNECTION_NAME = "openagents";
const SNOWFLAKE_PRIVATE_KEY_FILE_NAME = "openagents_key.p8";
const SNOWFLAKE_CONFIG_FILE_NAME = "config.toml";
const SNOWFLAKE_WRAPPER_PATH = "/usr/local/bin/snow";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(
  value: Record<string, unknown>,
  key: keyof SnowflakeCliCredentials,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${SNOWFLAKE_CLI_SECRET_ENV}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: keyof SnowflakeCliCredentials) {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

export function readSnowflakeCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SnowflakeCliCredentials | undefined {
  const raw = env[SNOWFLAKE_CLI_SECRET_ENV];
  if (!raw?.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${SNOWFLAKE_CLI_SECRET_ENV} must be a JSON object`);
  }

  const database = optionalString(parsed, "database");
  const schema = optionalString(parsed, "schema");

  return {
    account: requiredString(parsed, "account"),
    private_key: requiredString(parsed, "private_key"),
    role: requiredString(parsed, "role"),
    user: requiredString(parsed, "user"),
    warehouse: requiredString(parsed, "warehouse"),
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
  };
}

export function hasConfiguredSnowflakeCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env[SNOWFLAKE_CLI_SECRET_ENV]?.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderSnowflakeConfig(credentials: SnowflakeCliCredentials, privateKeyPath: string) {
  const entries = [
    ["account", credentials.account],
    ["user", credentials.user],
    ["authenticator", "SNOWFLAKE_JWT"],
    ["private_key_file", privateKeyPath],
    ["role", credentials.role],
    ["warehouse", credentials.warehouse],
    ...(credentials.database ? ([["database", credentials.database]] as const) : []),
    ...(credentials.schema ? ([["schema", credentials.schema]] as const) : []),
  ];

  return [
    `[connections.${SNOWFLAKE_CONNECTION_NAME}]`,
    ...entries.map(([key, value]) => `${key} = ${tomlString(value)}`),
    "",
  ].join("\n");
}

function renderSnowflakeWrapper() {
  return `#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="\${SNOWFLAKE_CONFIG_FILE:-$HOME/${SNOWFLAKE_CONFIG_DIRECTORY_NAME}/${SNOWFLAKE_CONFIG_FILE_NAME}}"

run_with_uvx() {
  local uvx_bin="$1"
  shift
  exec "$uvx_bin" --python 3.13 --from snowflake-cli snow --config-file "$CONFIG_FILE" "$@"
}

install_uvx() {
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | sh >/dev/null
    return
  fi

  return 1
}

if command -v uvx >/dev/null 2>&1; then
  run_with_uvx "$(command -v uvx)" "$@"
fi

if [ -x "$HOME/.local/bin/uvx" ]; then
  run_with_uvx "$HOME/.local/bin/uvx" "$@"
fi

if install_uvx && [ -x "$HOME/.local/bin/uvx" ]; then
  run_with_uvx "$HOME/.local/bin/uvx" "$@"
fi

echo "Snowflake CLI requires uvx or curl/wget to install uvx." >&2
exit 127
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

export async function installSnowflakeCli(
  sandbox: Sandbox,
  credentials: SnowflakeCliCredentials,
): Promise<void> {
  const homeDirectory = await resolveHomeDirectory(sandbox);
  const snowflakeDirectory = `${homeDirectory}/${SNOWFLAKE_CONFIG_DIRECTORY_NAME}`;
  const privateKeyPath = `${snowflakeDirectory}/${SNOWFLAKE_PRIVATE_KEY_FILE_NAME}`;
  const configPath = `${snowflakeDirectory}/${SNOWFLAKE_CONFIG_FILE_NAME}`;

  await sandbox.mkdir(snowflakeDirectory, { recursive: true });
  await sandbox.writeFile(privateKeyPath, credentials.private_key, "utf-8");
  await sandbox.writeFile(configPath, renderSnowflakeConfig(credentials, privateKeyPath), "utf-8");
  await sandbox.writeFile(SNOWFLAKE_WRAPPER_PATH, renderSnowflakeWrapper(), "utf-8");

  const permissionResult = await sandbox.exec(
    [
      `chmod 700 ${shellQuote(snowflakeDirectory)}`,
      `chmod 600 ${shellQuote(privateKeyPath)} ${shellQuote(configPath)}`,
      `chmod 755 ${shellQuote(SNOWFLAKE_WRAPPER_PATH)}`,
    ].join(" && "),
    sandbox.workingDirectory,
    INSTALL_TIMEOUT_MS,
  );

  if (!permissionResult.success) {
    throw new Error(
      permissionResult.stderr.trim() ||
        permissionResult.stdout.trim() ||
        "Failed to configure Snowflake CLI permissions",
    );
  }
}

export async function installConfiguredSnowflakeCli(sandbox: Sandbox): Promise<void> {
  const credentials = readSnowflakeCliCredentials();
  if (!credentials) {
    return;
  }

  await installSnowflakeCli(sandbox, credentials);
}
