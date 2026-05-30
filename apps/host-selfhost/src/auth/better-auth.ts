import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, bearer, mcp, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { type Client } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Context } from "effect";

import { loadConfig } from "../config";
import { seedOrgAndAdmin } from "./seed";

// ---------------------------------------------------------------------------
// Better Auth instance over the SAME libSQL `file:` URL as the FumaDB executor
// tables ("one file, two schema regions").
//
// Schema-at-boot: passing `{ dialect: new LibsqlDialect({ url }), type: "sqlite" }`
// makes Better Auth's createKyselyAdapter take its `"dialect" in db` branch (no
// native dep, no bun:sqlite); `runMigrations()` creates the auth tables
// idempotently in that file. `makeAuthOptions` is the single source of truth so
// the migrator and runtime instance never drift.
//
// CRITICAL: LibsqlDialect opens its OWN libSQL connection to the file — it does
// NOT share SelfHostDb's drizzle connection. Both target one file, and a row
// Better Auth writes via this dialect is immediately readable through the
// drizzle/FumaDB client (proven by seed.ts's reads + better-auth.test.ts). The
// per-connection foreign_keys/WAL PRAGMAs SelfHostDb set on its own connection
// do NOT carry to this one; for the auth tables that is fine (Kysely issues no
// FK-dependent reads at boot and WAL is already a file-level mode), and the
// shared file stays consistent because writes go through SQLite's file lock.
//
// NEVER call .destroy() on the resulting Kysely instance during normal
// operation — SelfHostDb owns the file lifecycle and closes its client at
// shutdown; the dialect's connection is GC'd with the auth instance.
//
// `satisfies BetterAuthOptions` (not a return annotation) keeps the literal
// plugin tuple so `betterAuth` infers the plugin-augmented `auth.api` and
// session/user shapes (activeOrganizationId, role, createUser, ...).
// ---------------------------------------------------------------------------

const makeAuthOptions = (url: string, organizationId: string) => {
  const config = loadConfig();
  const secret = config.authSecret;
  if (!secret || secret.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a multi-user auth server must not boot without a strong session secret
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET) must be set and at least 32 characters");
  }
  return {
    database: { dialect: new LibsqlDialect({ url }), type: "sqlite" as const },
    secret,
    baseURL: config.webBaseUrl,
    // The browser Origin must match this exactly; CLI/MCP bearer requests carry
    // no Origin and are unaffected.
    trustedOrigins: [config.webBaseUrl],
    emailAndPassword: { enabled: true },
    // `apiKey` issues long-lived personal keys (the API-keys page). With
    // `enableSessionForAPIKeys`, presenting a key resolves to its owner's
    // session — so a key works as a Bearer token for the API + MCP endpoint.
    //
    // `mcp()` adds the MCP OAuth Authorization Server: dynamic client
    // registration + authorize + token under /api/auth/mcp/*, the discovery
    // docs, and `getMcpSession` (opaque-bearer validation). It WRAPS
    // oidcProvider — do NOT also add oidcProvider. The two root well-known docs
    // are re-emitted by the shared envelope (MCP clients probe the origin root,
    // not the /api/auth basePath).
    plugins: [
      organization(),
      admin(),
      apiKey({ enableSessionForAPIKeys: true }),
      bearer(),
      mcp({ loginPage: "/login" }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Single-org instance: pin every session to the one organization, so
          // every authenticated user resolves to the org scope. (Membership
          // rows are only created for the bootstrap admin via createOrganization;
          // the pin — not a member row — is what scope derivation reads.)
          before: async (session: Record<string, unknown>) => ({
            data: { ...session, activeOrganizationId: organizationId },
          }),
        },
      },
    },
  } satisfies BetterAuthOptions;
};

const createAuthInstance = (url: string, organizationId: string) =>
  betterAuth(makeAuthOptions(url, organizationId));

export type Auth = ReturnType<typeof createAuthInstance>;

export interface BetterAuthHandle {
  readonly auth: Auth;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly handler: (request: Request) => Promise<Response>;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthHandle>()(
  "@executor-js/host-selfhost/BetterAuth",
) {}

/**
 * Build the Better Auth instance: migrate, seed the org+admin, then rebuild
 * with the resolved org id pinned into the session hook. runMigrations and the
 * seed are idempotent, so this is safe on every boot.
 *
 * `url` is the SAME libSQL `file:` URL SelfHostDb opened; `client` is
 * SelfHostDb's drizzle connection to that file, used by the seed for its two
 * idempotency reads against the auth tables Better Auth just migrated (proving
 * the cross-connection invariant: Better Auth writes via LibsqlDialect are
 * visible through SelfHostDb's client on the same file).
 */
export const buildBetterAuth = async (url: string, client: Client): Promise<BetterAuthHandle> => {
  const config = loadConfig();

  // Phase 1: bootstrap instance (placeholder org), create tables, seed.
  // `runMigrations()` flows through the LibsqlDialect and is idempotent.
  const bootstrap = createAuthInstance(url, "");
  await (await bootstrap.$context).runMigrations();
  const { organizationId, organizationName } = await seedOrgAndAdmin(bootstrap, client, config);

  // Phase 2: rebuild with the real org id so the session-pin hook is correct.
  // Migrations are already applied; this instance opens its own dialect
  // connection to the same file.
  const auth = createAuthInstance(url, organizationId);
  return { auth, organizationId, organizationName, handler: auth.handler };
};
