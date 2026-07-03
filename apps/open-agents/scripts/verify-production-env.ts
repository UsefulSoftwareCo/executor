import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const EXPECTED_PROJECT = {
  projectName: "openagents",
  rootDirectory: null,
  framework: "services",
  nodeVersion: "24.x",
};

const EXPECTED_SERVICE_CONFIG = {
  web: {
    root: "apps/open-agents",
    framework: "nextjs",
    installCommand: "bun install --frozen-lockfile --minimum-release-age=0",
    buildCommand: "bun run build",
  },
  eve: {
    root: ".",
    framework: "eve",
    installCommand: "bun install --frozen-lockfile --minimum-release-age=0",
    buildCommand:
      "bun run apps/open-agents/scripts/verify-eve-vercel-output-patch.ts && eve build && bun run apps/open-agents/scripts/patch-eve-vercel-output.ts",
  },
};

const EXPECTED_SERVICE_REWRITES = [
  { source: "/eve/v1/(.*)", service: "eve" },
  { source: "/.well-known/workflow/(.*)", service: "eve" },
  { source: "/(.*)", service: "web" },
];

const REQUIRED_ENV_GROUPS: Record<string, readonly string[]> = {
  postgres: [
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_HOST",
    "POSTGRES_DATABASE",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "PGHOST",
    "PGHOST_UNPOOLED",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "NEON_PROJECT_ID",
  ],
  redis: [
    "REDIS_URL",
    "KV_URL",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "KV_REST_API_READ_ONLY_TOKEN",
  ],
  appRuntime: [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
    "VERCEL_APP_CLIENT_SECRET",
    "EXECUTOR_SECRET_KEY",
    "OPEN_AGENTS_AUTH_MODE",
    "OPEN_AGENTS_ALLOW_PUBLIC_REPO_SESSIONS",
    "OPEN_AGENTS_RESOURCE_PROFILE",
    "VERCEL_OIDC_TOKEN",
  ],
};

const STORAGE_ENV_KEYS = new Set([...REQUIRED_ENV_GROUPS.postgres, ...REQUIRED_ENV_GROUPS.redis]);

const ALLOW_EMPTY_ENCRYPTED_PULL_VALUES = new Set([
  "BETTER_AUTH_SECRET",
  "VERCEL_APP_CLIENT_SECRET",
  "EXECUTOR_SECRET_KEY",
]);

const FORBIDDEN_STORAGE_VALUE_FRAGMENTS = [
  "augment-postgres",
  "augment-redis",
  "shared-postgres",
  "shared-redis",
  "executor-postgres",
  "executor-redis",
];

type OptionalJsonSecretSpec = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
};

const OPTIONAL_JSON_SECRET_SPECS: Record<string, OptionalJsonSecretSpec> = {
  OPEN_AGENTS_BRAINTRUST_CLI_SECRET: {
    required: ["apiKey"],
    optional: ["apiUrl", "appUrl", "org", "project"],
  },
  OPEN_AGENTS_DATADOG_PUP_CLI_SECRET: {
    required: ["apiKey", "appKey"],
    optional: ["site"],
  },
  OPEN_AGENTS_SNOWFLAKE_CLI_SECRET: {
    required: ["account", "private_key", "role", "user", "warehouse"],
    optional: ["database", "schema"],
  },
};

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function findWorkspaceRoot(): string {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "apps", "open-agents"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not find workspace root containing apps/open-agents");
    }
    current = parent;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return trimmed;
}

function readEnvFile(filePath: string): Map<string, string> {
  const env = new Map<string, string>();
  const content = readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equals = line.indexOf("=");
    if (equals <= 0) {
      continue;
    }

    env.set(line.slice(0, equals), unquote(line.slice(equals + 1)));
  }
  return env;
}

function readProjectFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function projectSetting(project: Record<string, unknown>, key: string): unknown {
  const settings = project.settings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined) {
      return value;
    }
  }
  return project[key];
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function assertProject(project: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries(EXPECTED_PROJECT)) {
    const actual = projectSetting(project, key);
    if (actual !== expected) {
      fail(
        `Vercel project ${key} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
}

function assertServiceConfig(config: Record<string, unknown>): void {
  const services = config.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    fail("vercel.json must define services");
  }

  for (const [serviceName, expected] of Object.entries(EXPECTED_SERVICE_CONFIG)) {
    const service = (services as Record<string, unknown>)[serviceName];
    if (!service || typeof service !== "object" || Array.isArray(service)) {
      fail(`vercel.json must define services.${serviceName}`);
    }

    for (const [key, expectedValue] of Object.entries(expected)) {
      const actual = (service as Record<string, unknown>)[key];
      if (actual !== expectedValue) {
        fail(
          `vercel.json services.${serviceName}.${key} must be ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
  }

  const rewrites = config.rewrites;
  if (!Array.isArray(rewrites)) {
    fail("vercel.json must define service rewrites");
  }

  for (const [index, expected] of EXPECTED_SERVICE_REWRITES.entries()) {
    const rewrite = rewrites[index];
    if (!rewrite || typeof rewrite !== "object" || Array.isArray(rewrite)) {
      fail(`vercel.json rewrites[${index}] is missing`);
    }

    const destination = (rewrite as Record<string, unknown>).destination;
    const service =
      destination && typeof destination === "object" && !Array.isArray(destination)
        ? (destination as Record<string, unknown>).service
        : undefined;

    if (
      (rewrite as Record<string, unknown>).source !== expected.source ||
      service !== expected.service
    ) {
      fail(
        `vercel.json rewrites[${index}] must route ${expected.source} to service ${expected.service}`,
      );
    }
  }
}

function assertEnv(env: Map<string, string>): void {
  const missing: string[] = [];
  for (const [group, keys] of Object.entries(REQUIRED_ENV_GROUPS)) {
    for (const key of keys) {
      const value = env.get(key);
      if (value === undefined || (!value.trim() && !ALLOW_EMPTY_ENCRYPTED_PULL_VALUES.has(key))) {
        missing.push(`${group}:${key}`);
      }
    }
  }

  if (missing.length > 0) {
    fail(`Missing required production env vars: ${missing.join(", ")}`);
  }

  const authUrl = env.get("BETTER_AUTH_URL") ?? "";
  if (!authUrl.startsWith("https://")) {
    fail("BETTER_AUTH_URL must be an https URL");
  }

  const authMode = env.get("OPEN_AGENTS_AUTH_MODE");
  if (authMode !== "oauth") {
    fail(
      'OPEN_AGENTS_AUTH_MODE must be "oauth" so production uses the signed-in Vercel OAuth user',
    );
  }

  for (const [key, value] of env) {
    if (!STORAGE_ENV_KEYS.has(key)) {
      continue;
    }
    const normalized = value.toLowerCase();
    const forbidden = FORBIDDEN_STORAGE_VALUE_FRAGMENTS.find((fragment) =>
      normalized.includes(fragment),
    );
    if (forbidden) {
      fail(`${key} appears to point at a forbidden shared storage resource (${forbidden})`);
    }
  }

  assertOptionalJsonSecrets(env);
}

function assertOptionalJsonSecrets(env: Map<string, string>): void {
  for (const [key, spec] of Object.entries(OPTIONAL_JSON_SECRET_SPECS)) {
    const raw = env.get(key);
    if (raw === undefined) {
      continue;
    }
    if (!raw.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(`${key} must be a JSON object`);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${key} must be a JSON object`);
    }

    const secret = parsed as Record<string, unknown>;
    for (const field of spec.required) {
      if (typeof secret[field] !== "string" || !secret[field].trim()) {
        fail(`${key}.${field} must be a non-empty string`);
      }
    }

    for (const field of spec.optional) {
      const value = secret[field];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        fail(`${key}.${field} must be a non-empty string when set`);
      }
    }
  }
}

const workspaceRoot = findWorkspaceRoot();
const projectFile =
  readArg("--project-file") ?? path.join(workspaceRoot, ".vercel", "project.json");
const envFile =
  readArg("--env-file") ?? path.join(workspaceRoot, ".vercel", ".env.production.local");

if (!existsSync(projectFile)) {
  fail(`Missing Vercel project file: ${projectFile}`);
}
if (!existsSync(envFile)) {
  fail(`Missing pulled production env file: ${envFile}`);
}

assertProject(readProjectFile(projectFile));
assertServiceConfig(readProjectFile(path.join(workspaceRoot, "vercel.json")));
assertEnv(readEnvFile(envFile));

console.log("✓ openagents Vercel project settings and pulled production env are valid");
console.log(`  project: ${projectFile}`);
console.log(`  env: ${envFile}`);
console.log(
  "  storage policy: only openagents-postgres/openagents-redis are allowed; known shared Augment resource names are blocked",
);
console.log(
  "  optional CLI secrets: Braintrust, Datadog Pup, and Snowflake shapes are validated when configured",
);
