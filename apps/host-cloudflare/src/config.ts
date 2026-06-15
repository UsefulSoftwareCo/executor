import type { D1Database, DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

import { isValidOrgSlug } from "@executor-js/api";
import { missingPublicOriginWarning, resolvePublicOrigin } from "@executor-js/sdk/public-origin";

let warnedNoCloudflareOrigin = false;

// ---------------------------------------------------------------------------
// Cloudflare host config. Unlike self-host (process.env + a data dir), a Worker
// receives its bindings + vars per request as `env`, so config is derived from
// that object — there is no process.env, no filesystem, no boot-time secret
// generation. Identity comes entirely from Cloudflare Access in front of the
// Worker; the only real secret is the at-rest secret-encryption key.
// ---------------------------------------------------------------------------

export const CLOUDFLARE_NAMESPACE = "executor_cloudflare";
export const CLOUDFLARE_SCHEMA_VERSION = "1.0.0";

export interface CloudflareEnv {
  /** D1 database binding — the app's SQLite store. */
  readonly DB: D1Database;
  /** R2 bucket binding — holds values too large for a D1 row (~1-2MB cap). */
  readonly BLOBS?: R2Bucket;
  /** MCP session Durable Object namespace — one addressable isolate per MCP
   *  session (the DO id IS the session id), so a session survives across the
   *  Worker's stateless isolates. */
  readonly MCP_SESSION: DurableObjectNamespace;
  /** Zero Trust team domain, e.g. `your-team.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag (the JWT audience to verify). */
  readonly ACCESS_AUD: string;
  /** Claim holding the display name (default `name`). */
  readonly ACCESS_NAME_CLAIM?: string;
  /** Claim holding the user's groups (default `groups`). */
  readonly ACCESS_GROUPS_CLAIM?: string;
  /** Comma-separated emails granted the admin role. */
  readonly ADMIN_EMAILS?: string;
  /** The single organization id/name every authenticated user belongs to. */
  readonly SELF_HOSTED_ORG_ID?: string;
  readonly SELF_HOSTED_ORG_NAME?: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly SELF_HOSTED_ORG_SLUG?: string;
  /** At-rest secret-encryption key (a `wrangler secret`, NOT a var). */
  readonly EXECUTOR_SECRET_KEY?: string;
  readonly ALLOW_LOCAL_NETWORK?: string;
  readonly VITE_PUBLIC_SITE_URL?: string;
  /**
   * Dev/single-user escape hatch: when "true", skip Cloudflare Access entirely
   * and treat every request as a fixed admin. For local `wrangler dev` and
   * unattended validation only — NEVER set on a deployment that isn't already
   * behind Access, or the instance is wide open.
   */
  readonly ENABLE_DEV_AUTH?: string;
}

export interface CloudflareConfig {
  readonly accessTeamDomain: string;
  readonly accessAud: string;
  readonly accessNameClaim: string;
  readonly accessGroupsClaim: string;
  readonly adminEmails: readonly string[];
  readonly organizationId: string;
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly organizationSlug: string;
  readonly secretKey: string;
  readonly allowLocalNetwork: boolean;
  /** Explicit web base URL (`VITE_PUBLIC_SITE_URL`). Unset on a Worker with no
   *  static URL — the per-request origin is used instead (see RequestWebOrigin). */
  readonly webBaseUrl?: string;
  readonly enableDevAuth: boolean;
}

const splitLower = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments — a colliding slug would shadow real routes (notably /api, /mcp,
// and Cloudflare's /cdn-cgi).
const resolveOrgSlug = (value: string | undefined): string => {
  if (!value) return "default";
  if (!isValidOrgSlug(value) && value !== "default") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a colliding org slug would shadow app routes; refuse to boot
    throw new Error(
      `SELF_HOSTED_ORG_SLUG ${JSON.stringify(value)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "mcp")`,
    );
  }
  return value;
};

export const loadConfig = (env: CloudflareEnv): CloudflareConfig => {
  const secretKey = env.EXECUTOR_SECRET_KEY?.trim();
  if (!secretKey || secretKey.length < 16) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the Worker must not boot without the at-rest secret key
    throw new Error(
      "EXECUTOR_SECRET_KEY must be set (wrangler secret put EXECUTOR_SECRET_KEY) — it encrypts stored secrets at rest in D1",
    );
  }
  const enableDevAuth = env.ENABLE_DEV_AUTH === "true";
  const webBaseUrl = resolvePublicOrigin({ explicit: env.VITE_PUBLIC_SITE_URL, env: {} });
  if (!webBaseUrl && !enableDevAuth && !warnedNoCloudflareOrigin) {
    warnedNoCloudflareOrigin = true;
    console.warn(
      missingPublicOriginWarning({
        varName: "VITE_PUBLIC_SITE_URL",
        fallback: "the per-request origin",
      }),
    );
  }
  return {
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    accessAud: env.ACCESS_AUD,
    accessNameClaim: env.ACCESS_NAME_CLAIM ?? "name",
    accessGroupsClaim: env.ACCESS_GROUPS_CLAIM ?? "groups",
    adminEmails: splitLower(env.ADMIN_EMAILS),
    organizationId: env.SELF_HOSTED_ORG_ID ?? "default",
    organizationName: env.SELF_HOSTED_ORG_NAME ?? "Default",
    organizationSlug: resolveOrgSlug(env.SELF_HOSTED_ORG_SLUG),
    secretKey,
    allowLocalNetwork: env.ALLOW_LOCAL_NETWORK === "true",
    // Pinned origin via the shared resolver. A Worker receives no PaaS platform
    // vars (env: {} — there is nothing to detect), so only the explicit
    // VITE_PUBLIC_SITE_URL applies; when it's unset we leave webBaseUrl undefined
    // and let the per-request origin drive it (request.url — Cloudflare-set, not
    // spoofable via Host). Warn once on a real deployment so the operator pins it,
    // mirroring self-host (gated on enableDevAuth = local `wrangler dev`).
    webBaseUrl,
    enableDevAuth,
  };
};
