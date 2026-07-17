import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidOrgSlug } from "@executor-js/api";
import {
  missingPublicOriginWarning,
  resolvePublicOrigin,
  shouldWarnMissingPublicOrigin,
} from "@executor-js/sdk/public-origin";

// ---------------------------------------------------------------------------
// Self-host server config — a single typed surface parsed from the
// environment. Slice 1 keeps this a plain loader with safe defaults; it can
// graduate to Effect-Schema validation without changing call sites.
// ---------------------------------------------------------------------------

export const SELF_HOST_NAMESPACE = "executor_selfhost";
export const SELF_HOST_SCHEMA_VERSION = "1.0.0";

export type SelfHostDatabaseConfig =
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "remote";
      readonly url: string;
      readonly authToken?: string;
    };

export type SelfHostMcpMode = "stateful" | "stateless";

export interface SelfHostConfig {
  /** Bind address. Defaults to loopback. */
  readonly host: string;
  readonly port: number;
  /** Local SQLite file or remote libSQL database. */
  readonly database: SelfHostDatabaseConfig;
  /** Stateful by default; stateless is intended for request-isolated platforms. */
  readonly mcpMode: SelfHostMcpMode;
  /** Public base URL used by core tools that build absolute links. */
  readonly webBaseUrl: string;
  /**
   * Whether sandboxed code may reach loopback/private network addresses.
   * Defaults to false — adversarial LLM code should not hit the host's
   * internal network unless an operator opts in.
   */
  readonly allowLocalNetwork: boolean;
  // Better Auth session secret. Always resolved (env, else generated + persisted
  // under the data dir) so a single-container deploy boots with no env; the auth
  // layer still validates an explicitly-set env secret is long enough.
  readonly authSecret: string;
  readonly bootstrapAdminEmail: string | undefined;
  readonly bootstrapAdminPassword: string | undefined;
  readonly bootstrapAdminName: string;
  /** The single organization every self-host user belongs to. */
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly orgSlug: string;
}

export const resolveDataDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.EXECUTOR_DATA_DIR ?? join(process.cwd(), ".executor-selfhost");

let cachedSecretKey: string | undefined;

/**
 * Request-isolated hosts cannot persist generated keys between instances.
 * Their image sets this guard so a missing managed key fails before boot.
 */
export const assertManagedSecretsConfigured = (
  env: NodeJS.ProcessEnv = process.env,
  mcpMode: SelfHostMcpMode = resolveMcpMode(env),
  database?: SelfHostDatabaseConfig,
): void => {
  const requiresManagedSecrets =
    env.EXECUTOR_REQUIRE_MANAGED_SECRETS === "true" ||
    mcpMode === "stateless" ||
    database?.kind === "remote";
  if (!requiresManagedSecrets) return;

  const authSecret = (env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET)?.trim();
  if (!authSecret || !env.EXECUTOR_SECRET_KEY?.trim()) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: ephemeral hosts must not generate instance-local encryption or session keys
    throw new Error(
      "BETTER_AUTH_SECRET (or AUTH_SECRET) and EXECUTOR_SECRET_KEY are required on this host",
    );
  }
};

/**
 * Master key for the encrypted secret provider. Prefers EXECUTOR_SECRET_KEY;
 * otherwise generates and persists a random key under the data dir on first
 * boot (so a single-container deploy is encrypted-by-default without manual
 * setup). Memoized so repeated per-request reads are cheap.
 */
export const resolveSecretKey = (env: NodeJS.ProcessEnv = process.env): string => {
  const cache = env === process.env;
  if (cache && cachedSecretKey) return cachedSecretKey;
  const fromEnv = env.EXECUTOR_SECRET_KEY?.trim();
  if (fromEnv) {
    if (cache) cachedSecretKey = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(env), "secret.key");
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, "utf8").trim();
    if (cache) cachedSecretKey = stored;
    return stored;
  }
  mkdirSync(resolveDataDir(env), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a secret-encryption key at ${keyPath}. Set EXECUTOR_SECRET_KEY to manage it explicitly (and to keep secrets readable across data-dir changes).`,
  );
  if (cache) cachedSecretKey = generated;
  return generated;
};

let cachedAuthSecret: string | undefined;

/**
 * Better Auth session secret. Prefers BETTER_AUTH_SECRET / AUTH_SECRET;
 * otherwise generates and persists a strong random secret under the data dir on
 * first boot (so a single-container deploy boots with no env and keeps sessions
 * valid across restarts). Memoized; mirrors {@link resolveSecretKey}.
 */
export const resolveAuthSecret = (env: NodeJS.ProcessEnv = process.env): string => {
  const cache = env === process.env;
  if (cache && cachedAuthSecret) return cachedAuthSecret;
  const fromEnv = (env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET)?.trim();
  if (fromEnv) {
    if (cache) cachedAuthSecret = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(env), "auth-secret.key");
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, "utf8").trim();
    if (cache) cachedAuthSecret = stored;
    return stored;
  }
  mkdirSync(resolveDataDir(env), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a session secret at ${keyPath}. Set BETTER_AUTH_SECRET to manage it explicitly (rotating it signs everyone out).`,
  );
  if (cache) cachedAuthSecret = generated;
  return generated;
};

let warnedNoPublicUrl = false;

const REMOTE_DATABASE_PROTOCOLS = new Set(["libsql:", "https:", "http:", "wss:", "ws:"]);

/** Resolve the local SQLite or remote libSQL connection from environment variables. */
export const resolveDatabaseConfig = (
  env: NodeJS.ProcessEnv = process.env,
): SelfHostDatabaseConfig => {
  const executorUrl = env.EXECUTOR_DB_URL?.trim() || undefined;
  const executorAuthToken = env.EXECUTOR_DB_AUTH_TOKEN?.trim() || undefined;
  const tursoUrl = env.TURSO_DATABASE_URL?.trim() || undefined;
  const tursoAuthToken = env.TURSO_AUTH_TOKEN?.trim() || undefined;
  const url = executorUrl ?? tursoUrl;
  const authToken = executorUrl ? executorAuthToken : tursoAuthToken;

  if ((executorAuthToken && !executorUrl) || (tursoAuthToken && !tursoUrl)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: incomplete database credentials must fail before boot
    throw new Error(
      "EXECUTOR_DB_AUTH_TOKEN or TURSO_AUTH_TOKEN requires EXECUTOR_DB_URL or TURSO_DATABASE_URL",
    );
  }

  if (url) {
    let protocol: string;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: operator-provided database URL is validated once at startup
    try {
      protocol = new URL(url).protocol;
    } catch {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: invalid database URL must fail before boot
      throw new Error("EXECUTOR_DB_URL or TURSO_DATABASE_URL must be an absolute URL");
    }
    if (!REMOTE_DATABASE_PROTOCOLS.has(protocol)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: unsupported database transport must fail before boot
      throw new Error(
        "EXECUTOR_DB_URL or TURSO_DATABASE_URL must use libsql, https, http, wss, or ws",
      );
    }
    return authToken ? { kind: "remote", url, authToken } : { kind: "remote", url };
  }

  if (resolveMcpMode(env) === "stateless") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: request-isolated hosts must not silently persist state to ephemeral storage
    throw new Error(
      "EXECUTOR_DB_URL or TURSO_DATABASE_URL is required when EXECUTOR_MCP_MODE=stateless",
    );
  }

  const dataDir = env.EXECUTOR_DATA_DIR ?? join(process.cwd(), ".executor-selfhost");
  return {
    kind: "file",
    path: env.EXECUTOR_DB_PATH ?? join(dataDir, "data.db"),
  };
};

/** Resolve the MCP serving mode, rejecting silent typos at startup. */
export const resolveMcpMode = (env: NodeJS.ProcessEnv = process.env): SelfHostMcpMode => {
  const mode = env.EXECUTOR_MCP_MODE?.trim() ?? "stateful";
  if (mode === "stateful" || mode === "stateless") return mode;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: unsupported serving mode must fail before boot
  throw new Error('EXECUTOR_MCP_MODE must be either "stateful" or "stateless"');
};

// The public origin used to build absolute links (OAuth redirects, MCP OAuth
// metadata, the connect-card URL). Priority via the shared resolver: an explicit
// EXECUTOR_WEB_BASE_URL, then a platform-injected origin (zero-config on
// Railway/Render/Fly/…), then a localhost fallback for local dev. NEVER derived
// from the request `Host` — that's spoofable and would let host-header injection
// poison those links (the request origin is only trusted for the CSRF/
// `trustedOrigins` check, which is same-origin-safe; see better-auth.ts).
const resolveWebBaseUrl = (port: number, env: NodeJS.ProcessEnv = process.env): string => {
  const resolved = resolvePublicOrigin({
    explicit: env.EXECUTOR_WEB_BASE_URL,
    env,
  });
  if (resolved) return resolved;
  const fallback = `http://localhost:${port}`;
  // A deployed instance with no detectable origin mints localhost links — warn
  // once (unless local dev/test) so the operator sets the variable.
  if (!warnedNoPublicUrl && shouldWarnMissingPublicOrigin(env.NODE_ENV)) {
    warnedNoPublicUrl = true;
    console.warn(
      missingPublicOriginWarning({
        varName: "EXECUTOR_WEB_BASE_URL",
        fallback,
      }),
    );
  }
  return fallback;
};

export interface LoadSelfHostConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly database?: SelfHostDatabaseConfig;
  readonly mcpMode?: SelfHostMcpMode;
}

export const loadHostConfig = (
  env: NodeJS.ProcessEnv = process.env,
): Pick<SelfHostConfig, "host" | "port" | "webBaseUrl" | "allowLocalNetwork"> => {
  const port = Number.parseInt(env.PORT ?? "4788", 10);
  return {
    host: env.EXECUTOR_HOST ?? "127.0.0.1",
    port,
    webBaseUrl: resolveWebBaseUrl(port, env),
    allowLocalNetwork: env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true",
  };
};

export const loadConfig = (options: LoadSelfHostConfigOptions = {}): SelfHostConfig => {
  const env = options.env ?? process.env;
  const host = loadHostConfig(env);
  const mcpMode = options.mcpMode ?? resolveMcpMode(env);
  const database = options.database ?? resolveDatabaseConfig(env);
  assertManagedSecretsConfigured(env, mcpMode, database);
  return {
    ...host,
    database,
    mcpMode,
    authSecret: resolveAuthSecret(env),
    bootstrapAdminEmail: env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapAdminName: env.EXECUTOR_BOOTSTRAP_ADMIN_NAME ?? "Admin",
    organizationName: env.EXECUTOR_ORG_NAME ?? "Default",
    orgSlug: resolveOrgSlug(env),
  };
};

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments (api, mcp, login, …) — a colliding slug would shadow real routes.
const resolveOrgSlug = (env: NodeJS.ProcessEnv = process.env): string => {
  const slug = env.EXECUTOR_ORG_SLUG;
  if (!slug) return "default";
  if (!isValidOrgSlug(slug) && slug !== "default") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a colliding org slug would shadow app routes; refuse to boot
    throw new Error(
      `EXECUTOR_ORG_SLUG ${JSON.stringify(slug)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "login")`,
    );
  }
  return slug;
};
