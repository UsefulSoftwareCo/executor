import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, bearer, mcp, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { type Client } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Context } from "effect";

import { loadConfig } from "../config";
import { seedOrgAndAdmin } from "./seed";
import { consumeInviteCode, ensureInviteCodeTable, findRedeemableCode } from "./invites";

// The self-service signup gate: present only on the live (phase-2) auth
// instance, so the bootstrap seed's `createUser` — which
// runs on the gate-free phase-1 instance — is never blocked. `getAuth` is
// late-bound because the hooks call `auth.api.addMember` AFTER the instance they
// belong to is constructed (the closure resolves it at request time).
interface SignupGate {
  readonly client: Client;
  readonly organizationId: string;
  readonly getAuth: () => Auth | null;
}

// Only self-service email signups are code-gated. Server/admin-initiated user
// creation (the seed, or a future admin "add user") flows through other paths.
const SIGNUP_PATH = "/sign-up/email";

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

const makeAuthOptions = (url: string, organizationId: string, gate?: SignupGate) => {
  const config = loadConfig();
  // Always resolved (generated + persisted when no env is set); this guards only
  // an explicitly-set env secret that is too weak.
  const secret = config.authSecret;
  if (secret.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a multi-user auth server must not boot with a weak session secret
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET), if set, must be at least 32 characters");
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
          // every authenticated user resolves to the org scope.
          before: async (session: Record<string, unknown>) => ({
            data: { ...session, activeOrganizationId: organizationId },
          }),
        },
      },
      // The signup gate. First-run: an org with ZERO members is unclaimed, so
      // the first signup is admitted ungated and becomes the owner. After that,
      // `before` rejects a signup without a valid, unused, unexpired invite code
      // and `after` makes the new user a real `member` + burns the code.
      ...(gate
        ? {
            user: {
              create: {
                before: async (_user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  if (await orgHasNoMembers(gate)) return; // first user claims the org
                  const code = inviteCodeFrom(context);
                  if (!code) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "An invite code is required to sign up.",
                    });
                  }
                  if (!(await findRedeemableCode(gate.client, code))) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "That invite code is invalid, already used, or expired.",
                    });
                  }
                },
                after: async (user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  const auth = gate.getAuth();
                  if (!auth) return;
                  // First user into an empty org becomes its owner (no code).
                  if (await orgHasNoMembers(gate)) {
                    await auth.api.addMember({
                      body: { userId: user.id, role: "owner", organizationId: gate.organizationId },
                    });
                    return;
                  }
                  const code = inviteCodeFrom(context);
                  if (!code) return;
                  const redeemable = await findRedeemableCode(gate.client, code);
                  if (!redeemable) return;
                  await auth.api.addMember({
                    body: {
                      userId: user.id,
                      role: redeemable.role,
                      organizationId: gate.organizationId,
                    },
                  });
                  await consumeInviteCode(gate.client, code, {
                    usedBy: user.id,
                    usedByEmail: user.email,
                  });
                },
              },
            },
          }
        : {}),
    },
  } satisfies BetterAuthOptions;
};

// The invite code rides on the signup request body (`{ name, email, password,
// inviteCode }`); Better Auth reads the body loosely, so a non-schema field
// survives to the create hook's endpoint context.
const inviteCodeFrom = (context: { body?: unknown }): string | undefined => {
  const body = context.body;
  if (body && typeof body === "object" && "inviteCode" in body) {
    const code = (body as { inviteCode?: unknown }).inviteCode;
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return undefined;
};

// Count org members via Better Auth's OWN adapter — the SAME connection that
// `addMember` writes through. SelfHostDb opens a SEPARATE libSQL connection
// whose snapshot can lag Better Auth's writes (observed under Bun: a just-added
// member is invisible to that connection for a while), so any membership read
// that gates behaviour MUST go through here to stay consistent with the writes.
export const countOrgMembers = (auth: Auth, organizationId: string): Promise<number> =>
  auth.$context.then(({ adapter }) =>
    adapter.count({ model: "member", where: [{ field: "organizationId", value: organizationId }] }),
  );

// True when the single org has no members yet — the unclaimed first-run state.
const orgHasNoMembers = async (gate: SignupGate): Promise<boolean> => {
  const auth = gate.getAuth();
  if (!auth) return true;
  return (await countOrgMembers(auth, gate.organizationId)) === 0;
};

const createAuthInstance = (url: string, organizationId: string, gate?: SignupGate) =>
  betterAuth(makeAuthOptions(url, organizationId, gate));

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

  // Phase 1: bootstrap instance (placeholder org, NO signup gate), create
  // tables, seed. `runMigrations()` flows through the LibsqlDialect and is
  // idempotent; the gate-free instance lets the seed's `createUser` through.
  const bootstrap = createAuthInstance(url, "");
  await (await bootstrap.$context).runMigrations();
  await ensureInviteCodeTable(client);
  const { organizationId, organizationName } = await seedOrgAndAdmin(bootstrap, client, config);

  // Phase 2: the live instance — real org id (session pin) + the signup gate.
  // `getAuth` resolves to this very instance, so the gate's `after` hook can
  // call `auth.api.addMember` once a code is redeemed.
  let auth: Auth | null = null;
  const gate: SignupGate = { client, organizationId, getAuth: () => auth };
  auth = createAuthInstance(url, organizationId, gate);
  return { auth, organizationId, organizationName, handler: auth.handler };
};
