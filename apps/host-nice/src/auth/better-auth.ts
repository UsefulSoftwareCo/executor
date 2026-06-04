import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, bearer, genericOAuth, mcp, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { Pool } from "pg";
import { Context } from "effect";

import { loadConfig, type HostNiceConfig, type OidcConfig } from "../config";

// ---------------------------------------------------------------------------
// Better Auth for host-nice — multi-org, over Postgres, sharing nice-chatbot's
// identity.
//
// Differences from host-selfhost's single-org Better Auth:
//   - Postgres (pg Pool) pinned to the executor `search_path`, NOT a libSQL
//     file. Better Auth opens its own pool and runs its own migrations into the
//     executor schema (the same "two clients, one database, separate
//     connections" pattern host-selfhost used for libSQL).
//   - MULTI-ORG: no single-org session pin. The active org comes from
//     `session.activeOrganizationId` (set when a user creates/selects an org via
//     the organization plugin), so each request resolves to the caller's org.
//   - Optional SSO: when nice-chatbot OIDC env is present, `genericOAuth`
//     delegates login to nice-chatbot so admins sign in once.
//   - No invite-code gate / single-org seed: org membership is managed by the
//     organization plugin (and, in Phase 1, by SSO claims).
//
// `mcp()` adds the MCP OAuth Authorization Server (DCR + authorize + token at
// /api/auth/mcp/*, discovery docs, opaque-bearer validation). With
// `apiKey({ enableSessionForAPIKeys: true })`, a per-org API key presented as a
// Bearer token resolves to its owner's session on the MCP endpoint.
// ---------------------------------------------------------------------------

const SIGNED_OUT_REDIRECT = "/login";

/** The nice-chatbot OIDC provider config for `genericOAuth`, when configured. */
const niceChatbotProvider = (oidc: OidcConfig) => ({
  providerId: "nice-chatbot",
  clientId: oidc.clientId,
  clientSecret: oidc.clientSecret,
  discoveryUrl: `${oidc.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  scopes: ["openid", "profile", "email"],
});

const makeAuthOptions = (url: string, schema: string, config: HostNiceConfig) => {
  const secret = config.authSecret;
  if (secret.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a multi-user auth server must not boot with a weak session secret
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET), if set, must be at least 32 characters");
  }

  // One pg Pool for Better Auth, pinned to the executor schema via the
  // connection `options` so its tables never collide with nice-chatbot's
  // `public` tables in the shared database.
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });

  // genericOAuth is always in the plugin tuple (a conditional spread would break
  // Better Auth's literal-tuple inference and degrade `auth.api`). When no OIDC
  // is configured the provider list is simply empty, so SSO is inert.
  const oauthConfig = config.oidc ? [niceChatbotProvider(config.oidc)] : [];

  return {
    database: pool,
    secret,
    baseURL: config.webBaseUrl,
    // The browser Origin must match this exactly; CLI/MCP bearer requests carry
    // no Origin and are unaffected.
    trustedOrigins: [config.webBaseUrl],
    emailAndPassword: { enabled: true },
    // Share the session cookie across `*.<domain>` so an admin signed into
    // nice-chatbot reaches executor.<domain> already authenticated.
    ...(config.cookieDomain
      ? {
          advanced: {
            crossSubDomainCookies: { enabled: true, domain: config.cookieDomain },
          },
        }
      : {}),
    plugins: [
      organization(),
      admin(),
      apiKey({ enableSessionForAPIKeys: true }),
      bearer(),
      mcp({ loginPage: SIGNED_OUT_REDIRECT }),
      genericOAuth({ config: oauthConfig }),
    ],
  } satisfies BetterAuthOptions;
};

const createAuthInstance = (url: string, schema: string, config: HostNiceConfig) =>
  betterAuth(makeAuthOptions(url, schema, config));

export type Auth = ReturnType<typeof createAuthInstance>;

export interface BetterAuthHandle {
  readonly auth: Auth;
  /** Optional org seeded at first boot (bootstrap); used as a fallback only. */
  readonly defaultOrganizationId: string | undefined;
  readonly handler: (request: Request) => Promise<Response>;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthHandle>()(
  "@executor-js/host-nice/BetterAuth",
) {}

/** Count a user's org memberships through Better Auth's own adapter. */
export const countUserMemberships = (auth: Auth, userId: string): Promise<number> =>
  auth.$context.then(({ adapter }) =>
    adapter.count({ model: "member", where: [{ field: "userId", value: userId }] }),
  );

/**
 * Resolve the active organization for a request: prefer the session's
 * `activeOrganizationId`; otherwise fall back to the user's first membership;
 * otherwise the bootstrap default org (if any). Multi-org: there is no single
 * pinned org, so callers that need a scope use this.
 */
export const resolveActiveOrganizationId = async (
  auth: Auth,
  userId: string,
  sessionActiveOrganizationId: string | null | undefined,
  fallback: string | undefined,
): Promise<string | undefined> => {
  if (sessionActiveOrganizationId) return sessionActiveOrganizationId;
  const { adapter } = await auth.$context;
  const memberships = await adapter.findMany<{ organizationId: string }>({
    model: "member",
    where: [{ field: "userId", value: userId }],
    limit: 1,
  });
  return memberships[0]?.organizationId ?? fallback;
};

/**
 * Optionally seed a bootstrap admin + default org on first boot (CI /
 * infra-as-code), when EXECUTOR_BOOTSTRAP_ADMIN_* and EXECUTOR_ORG_* are set.
 * Idempotent: skips if the admin already exists. Uses Better Auth's own API so
 * it is storage-agnostic (no libSQL-specific SQL like host-selfhost's seed).
 */
const maybeBootstrap = async (
  auth: Auth,
  config: HostNiceConfig,
): Promise<string | undefined> => {
  const email = config.bootstrapAdminEmail;
  const password = config.bootstrapAdminPassword;
  if (!email || !password) return undefined;

  const { adapter } = await auth.$context;
  const existing = await adapter.findOne<{ id: string }>({
    model: "user",
    where: [{ field: "email", value: email }],
  });

  let userId = existing?.id;
  if (!userId) {
    const created = await auth.api.signUpEmail({
      body: { email, password, name: config.bootstrapAdminName },
    });
    userId = created.user.id;
  }

  if (!config.defaultOrgName || !userId) return undefined;
  // Reuse an existing org by slug if present; else create it owned by admin.
  const slug = config.defaultOrgSlug ?? "default";
  const existingOrg = await adapter.findOne<{ id: string }>({
    model: "organization",
    where: [{ field: "slug", value: slug }],
  });
  if (existingOrg) return existingOrg.id;
  const org = await auth.api.createOrganization({
    body: { name: config.defaultOrgName, slug, userId },
  });
  return org?.id;
};

/**
 * Build the Better Auth instance: run migrations into the executor schema,
 * optionally bootstrap an admin + default org, and return the live handle.
 */
export const buildBetterAuth = async (url: string, schema: string): Promise<BetterAuthHandle> => {
  const config = loadConfig();
  const auth = createAuthInstance(url, schema, config);
  await (await auth.$context).runMigrations();
  const defaultOrganizationId = await maybeBootstrap(auth, config);
  return { auth, defaultOrganizationId, handler: auth.handler };
};
