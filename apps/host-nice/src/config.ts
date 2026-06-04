import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// host-nice server config — host-selfhost's config re-targeted to Postgres and
// multi-org so the host runs on nice-chatbot's database and identity.
//
// Differences from host-selfhost:
//   - Storage is Postgres (`POSTGRES_URL` / `DATABASE_URL`) in a dedicated
//     `executor` schema, not a libSQL file.
//   - Multi-org: there is no single pinned organization. Org bootstrap is
//     optional (for a first-run admin); normal operation lets each org be
//     created/selected via the UI and the Better Auth `organization` plugin.
//   - Optional SSO: when nice-chatbot OIDC env is present, login delegates to
//     nice-chatbot (Phase 1). Until then, email/password still works.
// ---------------------------------------------------------------------------

export const HOST_NICE_NAMESPACE = "executor_nice";
export const HOST_NICE_SCHEMA_VERSION = "1.0.0";

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface HostNiceConfig {
  /** Bind address. Defaults to all interfaces in a container, loopback in dev. */
  readonly host: string;
  readonly port: number;
  /** Postgres connection string (shared with nice-chatbot). */
  readonly postgresUrl: string;
  /** Postgres schema the executor tables live in. Defaults to `executor`. */
  readonly dbSchema: string;
  /** Public base URL used by core tools that build absolute links. */
  readonly webBaseUrl: string;
  /**
   * Whether sandboxed code may reach loopback/private network addresses.
   * Defaults to false — adversarial LLM code must not reach the shared
   * Postgres or the host's internal network unless an operator opts in.
   */
  readonly allowLocalNetwork: boolean;
  /** Better Auth session secret (shared cookie domain → SSO with nice-chatbot). */
  readonly authSecret: string;
  /** Cookie domain so the session is shared across `*.<domain>` subdomains. */
  readonly cookieDomain: string | undefined;
  /** Optional OIDC delegation to nice-chatbot. When unset, email/password. */
  readonly oidc: OidcConfig | undefined;
  /** Optional first-run admin bootstrap (CI / infra-as-code). */
  readonly bootstrapAdminEmail: string | undefined;
  readonly bootstrapAdminPassword: string | undefined;
  readonly bootstrapAdminName: string;
  /** Optional default org seeded on first run (admins create more in the UI). */
  readonly defaultOrgName: string | undefined;
  readonly defaultOrgSlug: string | undefined;
}

export const resolveDataDir = (): string =>
  process.env.EXECUTOR_DATA_DIR ?? join(process.cwd(), ".executor-nice");

let cachedSecretKey: string | undefined;

/**
 * Master key for the encrypted secret provider. Prefers EXECUTOR_SECRET_KEY;
 * otherwise generates and persists a random key under the data dir on first
 * boot. Memoized.
 */
export const resolveSecretKey = (): string => {
  if (cachedSecretKey) return cachedSecretKey;
  const fromEnv = process.env.EXECUTOR_SECRET_KEY?.trim();
  if (fromEnv) {
    cachedSecretKey = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(), "secret.key");
  if (existsSync(keyPath)) {
    cachedSecretKey = readFileSync(keyPath, "utf8").trim();
    return cachedSecretKey;
  }
  mkdirSync(resolveDataDir(), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a secret-encryption key at ${keyPath}. Set EXECUTOR_SECRET_KEY to manage it explicitly.`,
  );
  cachedSecretKey = generated;
  return generated;
};

let cachedAuthSecret: string | undefined;

/**
 * Better Auth session secret. Prefers BETTER_AUTH_SECRET / AUTH_SECRET — set it
 * to the SAME value as nice-chatbot so both apps mint/verify sessions
 * compatibly under a shared cookie domain. Falls back to a persisted random
 * secret for a standalone dev boot.
 */
export const resolveAuthSecret = (): string => {
  if (cachedAuthSecret) return cachedAuthSecret;
  const fromEnv = (process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET)?.trim();
  if (fromEnv) {
    cachedAuthSecret = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(), "auth-secret.key");
  if (existsSync(keyPath)) {
    cachedAuthSecret = readFileSync(keyPath, "utf8").trim();
    return cachedAuthSecret;
  }
  mkdirSync(resolveDataDir(), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a session secret at ${keyPath}. Set BETTER_AUTH_SECRET (matching nice-chatbot) to manage it explicitly.`,
  );
  cachedAuthSecret = generated;
  return generated;
};

const resolveOidc = (): OidcConfig | undefined => {
  const issuer = process.env.EXECUTOR_OIDC_ISSUER?.trim();
  const clientId = process.env.EXECUTOR_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.EXECUTOR_OIDC_CLIENT_SECRET?.trim();
  if (issuer && clientId && clientSecret) return { issuer, clientId, clientSecret };
  return undefined;
};

export const resolvePostgresUrl = (): string => {
  const url = (process.env.POSTGRES_URL ?? process.env.DATABASE_URL)?.trim();
  if (!url) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the host cannot boot without a database
    throw new Error("POSTGRES_URL (or DATABASE_URL) is required for host-nice");
  }
  return url;
};

export const loadConfig = (): HostNiceConfig => {
  const port = Number.parseInt(process.env.PORT ?? "4788", 10);
  return {
    host: process.env.EXECUTOR_HOST ?? "127.0.0.1",
    port,
    postgresUrl: resolvePostgresUrl(),
    dbSchema: process.env.EXECUTOR_DB_SCHEMA ?? "executor",
    webBaseUrl: process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${port}`,
    allowLocalNetwork: process.env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true",
    authSecret: resolveAuthSecret(),
    cookieDomain: process.env.EXECUTOR_COOKIE_DOMAIN?.trim() || undefined,
    oidc: resolveOidc(),
    bootstrapAdminEmail: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapAdminName: process.env.EXECUTOR_BOOTSTRAP_ADMIN_NAME ?? "Admin",
    defaultOrgName: process.env.EXECUTOR_ORG_NAME?.trim() || undefined,
    defaultOrgSlug: process.env.EXECUTOR_ORG_SLUG?.trim() || undefined,
  };
};
