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

/**
 * SSO sign-in for the self-host login page and the MCP OAuth connect flow: one
 * OIDC provider (Google, Okta, Entra, any discovery-compliant IdP) resolved
 * from the environment. Present only when the operator configured it; the
 * allowlist is what replaces the invite code for SSO sign-ups (the domain IS
 * the invite), so it is required whenever the provider is enabled.
 */
export interface SsoConfig {
  /** URL-safe id — also the OAuth callback path segment and the button key. */
  readonly providerId: string;
  /** Display name for the login button (“Continue with <name>”). */
  readonly providerName: string;
  /** The IdP's OIDC discovery document (…/.well-known/openid-configuration). */
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Lowercased email domains admitted without an invite code. */
  readonly allowedDomains: readonly string[];
}

export interface SelfHostConfig {
  /** Bind address. Defaults to loopback. */
  readonly host: string;
  readonly port: number;
  /** Absolute path to the SQLite database file. */
  readonly dbPath: string;
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
  /**
   * Sandbox execution budget passed to the QuickJS runtime, or undefined for
   * the runtime's own default (5 minutes). An operator knob in principle, but
   * its real consumer is the e2e harness, which shrinks it to seconds so the
   * sandbox-deadline scenario proves its race without waiting out real
   * minutes (the same pattern as MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS on cloud).
   */
  readonly sandboxTimeoutMs: number | undefined;
  /** SSO sign-in, or undefined when the operator hasn't configured it. */
  readonly sso: SsoConfig | undefined;
}

export const resolveDataDir = (): string =>
  process.env.EXECUTOR_DATA_DIR ?? join(process.cwd(), ".executor-selfhost");

let cachedSecretKey: string | undefined;

/**
 * Master key for the encrypted secret provider. Prefers EXECUTOR_SECRET_KEY;
 * otherwise generates and persists a random key under the data dir on first
 * boot (so a single-container deploy is encrypted-by-default without manual
 * setup). Memoized so repeated per-request reads are cheap.
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
    `[executor] generated a secret-encryption key at ${keyPath}. Set EXECUTOR_SECRET_KEY to manage it explicitly (and to keep secrets readable across data-dir changes).`,
  );
  cachedSecretKey = generated;
  return generated;
};

let cachedAuthSecret: string | undefined;

/**
 * Better Auth session secret. Prefers BETTER_AUTH_SECRET / AUTH_SECRET;
 * otherwise generates and persists a strong random secret under the data dir on
 * first boot (so a single-container deploy boots with no env and keeps sessions
 * valid across restarts). Memoized; mirrors {@link resolveSecretKey}.
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
    `[executor] generated a session secret at ${keyPath}. Set BETTER_AUTH_SECRET to manage it explicitly (rotating it signs everyone out).`,
  );
  cachedAuthSecret = generated;
  return generated;
};

let warnedNoPublicUrl = false;

// The public origin used to build absolute links (OAuth redirects, MCP OAuth
// metadata, the connect-card URL). Priority via the shared resolver: an explicit
// EXECUTOR_WEB_BASE_URL, then a platform-injected origin (zero-config on
// Railway/Render/Fly/…), then a localhost fallback for local dev. NEVER derived
// from the request `Host` — that's spoofable and would let host-header injection
// poison those links (the request origin is only trusted for the CSRF/
// `trustedOrigins` check, which is same-origin-safe; see better-auth.ts).
const resolveWebBaseUrl = (port: number): string => {
  const resolved = resolvePublicOrigin({
    explicit: process.env.EXECUTOR_WEB_BASE_URL,
    env: process.env,
  });
  if (resolved) return resolved;
  const fallback = `http://localhost:${port}`;
  // A deployed instance with no detectable origin mints localhost links — warn
  // once (unless local dev/test) so the operator sets the variable.
  if (!warnedNoPublicUrl && shouldWarnMissingPublicOrigin(process.env.NODE_ENV)) {
    warnedNoPublicUrl = true;
    console.warn(missingPublicOriginWarning({ varName: "EXECUTOR_WEB_BASE_URL", fallback }));
  }
  return fallback;
};

export const loadConfig = (): SelfHostConfig => {
  const port = Number.parseInt(process.env.PORT ?? "4788", 10);
  const dataDir = resolveDataDir();
  return {
    host: process.env.EXECUTOR_HOST ?? "127.0.0.1",
    port,
    dbPath: process.env.EXECUTOR_DB_PATH ?? join(dataDir, "data.db"),
    webBaseUrl: resolveWebBaseUrl(port),
    allowLocalNetwork: process.env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true",
    authSecret: resolveAuthSecret(),
    bootstrapAdminEmail: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapAdminName: process.env.EXECUTOR_BOOTSTRAP_ADMIN_NAME ?? "Admin",
    organizationName: process.env.EXECUTOR_ORG_NAME ?? "Default",
    orgSlug: resolveOrgSlug(),
    sandboxTimeoutMs: resolveSandboxTimeoutMs(),
    sso: resolveSso(),
  };
};

// Well-known discovery documents for providers an operator can name without
// hunting down the URL. Anything else (Okta, Entra, Auth0, …) has a
// tenant-specific issuer, so EXECUTOR_SSO_DISCOVERY_URL is required for it.
const DISCOVERY_PRESETS: Record<string, string> = {
  google: "https://accounts.google.com/.well-known/openid-configuration",
};

// The provider id doubles as the OAuth callback path segment
// (`/api/auth/oauth2/callback/<id>`), so it must be URL-safe.
const PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,48}$/;

// A half-configured provider is refused rather than silently ignored (same
// posture as resolveSandboxTimeoutMs): an operator who set some of the
// variables should find out at boot, not by staring at a login page with no
// button. An empty domain allowlist is refused too — without it, SSO sign-in
// would be open registration for anyone with an account at the IdP, bypassing
// the invite gate entirely.
const resolveSso = (): SsoConfig | undefined => {
  const clientId = process.env.EXECUTOR_SSO_CLIENT_ID?.trim();
  const clientSecret = process.env.EXECUTOR_SSO_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: refuse to boot on half-configured SSO credentials
    throw new Error("EXECUTOR_SSO_CLIENT_ID and EXECUTOR_SSO_CLIENT_SECRET must be set together");
  }
  const providerId = process.env.EXECUTOR_SSO_PROVIDER_ID?.trim().toLowerCase() ?? "";
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: refuse to boot on a missing/malformed provider id
    throw new Error(
      'EXECUTOR_SSO_PROVIDER_ID is required when SSO is configured (1-48 chars of [a-z0-9-], e.g. "google" or "okta") — it names the provider and its OAuth callback path',
    );
  }
  const discoveryUrl =
    process.env.EXECUTOR_SSO_DISCOVERY_URL?.trim() || DISCOVERY_PRESETS[providerId];
  if (!discoveryUrl) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: refuse to boot without a way to reach the IdP
    throw new Error(
      `EXECUTOR_SSO_DISCOVERY_URL is required for provider ${JSON.stringify(providerId)} (the IdP's …/.well-known/openid-configuration URL)`,
    );
  }
  const allowedDomains = (process.env.EXECUTOR_SSO_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().replace(/^@/, "").toLowerCase())
    .filter((domain) => domain.length > 0);
  if (allowedDomains.length === 0) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: SSO sign-in without a domain allowlist is open registration; refuse to boot
    throw new Error(
      'EXECUTOR_SSO_ALLOWED_DOMAINS is required when SSO is configured (comma-separated email domains, e.g. "example.com") — it is what gates sign-ups in place of an invite code',
    );
  }
  const providerName =
    process.env.EXECUTOR_SSO_PROVIDER_NAME?.trim() ||
    providerId.charAt(0).toUpperCase() + providerId.slice(1);
  return { providerId, providerName, discoveryUrl, clientId, clientSecret, allowedDomains };
};

// A malformed value is refused rather than silently ignored: an operator who
// sets the knob and typos it should find out at boot, not by watching a
// runaway execution use the 5-minute default.
const resolveSandboxTimeoutMs = (): number | undefined => {
  const raw = process.env.EXECUTOR_SANDBOX_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: refuse to boot on a malformed operator knob
    throw new Error(
      `EXECUTOR_SANDBOX_TIMEOUT_MS ${JSON.stringify(raw)} is not a positive number of milliseconds`,
    );
  }
  return Math.floor(parsed);
};

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments (api, mcp, login, …) — a colliding slug would shadow real routes.
const resolveOrgSlug = (): string => {
  const slug = process.env.EXECUTOR_ORG_SLUG;
  if (!slug) return "default";
  if (!isValidOrgSlug(slug) && slug !== "default") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a colliding org slug would shadow app routes; refuse to boot
    throw new Error(
      `EXECUTOR_ORG_SLUG ${JSON.stringify(slug)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "login")`,
    );
  }
  return slug;
};
