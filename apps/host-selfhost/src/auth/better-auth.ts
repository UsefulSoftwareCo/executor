import { betterAuth, getCurrentAdapter, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, bearer, deviceAuthorization, mcp, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { type Client } from "@libsql/client";
import { LibsqlDialect, type LibsqlDialectConfig } from "@libsql/kysely-libsql";
import { Context } from "effect";

import { loadConfig } from "../config";
import {
  ensureInviteCodeTable,
  finalizeFirstOwner,
  finalizeInviteCode,
  reserveFirstOwner,
  reserveInviteCode,
  signupClaimPlugin,
} from "./invites";
import { seedOrgAndAdmin } from "./seed";

// The self-service gate acts only on the public email-signup endpoint, so the
// bootstrap seed's server-side createUser call is never blocked.
interface SignupGate {
  readonly organizationId: string;
}

// Only self-service email signups are code-gated. Server/admin-initiated user
// creation (the seed, or a future admin "add user") flows through other paths.
const SIGNUP_PATH = "/sign-up/email";

type SignupClaim =
  | NonNullable<Awaited<ReturnType<typeof reserveFirstOwner>>>
  | NonNullable<Awaited<ReturnType<typeof reserveInviteCode>>>;

// Both hooks execute in the same endpoint context and database transaction.
// Keeping the reservation on that context passes only an opaque claim id from
// the pre-user hook to the pre-account hook, without accepting client state.
const signupClaims = new WeakMap<object, SignupClaim>();

// libSQL supports transactions, but its single adopted client cannot begin two
// transactions concurrently. Queue only email signups at this process boundary
// so each request gets a real transaction instead of racing into SQLITE_BUSY.
// The database claim predicates remain the authority across processes.
const serializeEmailSignups = (handler: (request: Request) => Promise<Response>) => {
  let pending = Promise.resolve();
  return (request: Request) => {
    if (new URL(request.url).pathname !== `/api/auth${SIGNUP_PATH}`) return handler(request);
    const response = pending.then(() => handler(request));
    pending = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  };
};

// ---------------------------------------------------------------------------
// Better Auth instance over the SAME libSQL CONNECTION as the FumaDB executor
// tables ("one connection, two schema regions").
//
// Schema-at-boot: passing `{ dialect: new LibsqlDialect({ client }), type:
// "sqlite" }` makes Better Auth's createKyselyAdapter take its `"dialect" in db`
// branch (no native dep, no bun:sqlite); `runMigrations()` creates the auth
// tables idempotently. `makeAuthOptions` is the single source of truth so the
// migrator and runtime instance never drift.
//
// CRITICAL: LibsqlDialect is handed SelfHostDb's EXISTING `@libsql/client` (the
// `{ client }` config branch), NOT a fresh `{ url }` connection. This is the
// crux of the self-host data-loss fix: libSQL connections each manage their own
// `-wal`/`-shm`, and when Better Auth opened a SECOND connection to the same
// file (`{ url }`), its open unlinked SelfHostDb's `-wal`/`-shm` and created new
// ones — orphaning SelfHostDb onto a now-deleted WAL inode. Every executor-core
// write (integrations, connections, tools) then landed in that deleted inode
// and vanished on the next restart, while Better Auth's own writes (on the live
// WAL) survived — the "reconnected account, zero tools" bug, reproducing even
// after the throwaway-bootstrap-instance fix because the LONG-LIVED auth
// connection unlinked it just the same. Sharing one client means one WAL: no
// unlink, and SelfHostDb's foreign_keys/WAL/busy_timeout PRAGMAs now cover auth
// queries too (same connection). `{ client }` sets closeClient=false, so the
// dialect never closes the handle — SelfHostDb owns the file lifecycle and
// closes its client at shutdown. NEVER call .destroy() during normal operation.
//
// We build exactly ONE auth instance, held for the process lifetime. An earlier
// design also built a throwaway "bootstrap" instance (discarded mid-boot); that
// is gone too. The org id is late-bound through a shared reference, so no
// second instance is needed.
//
// `satisfies BetterAuthOptions` (not a return annotation) keeps the literal
// plugin tuple so `betterAuth` infers the plugin-augmented `auth.api` and
// session/user shapes (activeOrganizationId, role, createUser, ...).
// ---------------------------------------------------------------------------

const makeAuthOptions = (client: Client, getOrganizationId: () => string, gate?: SignupGate) => {
  const config = loadConfig();
  // Always resolved (generated + persisted when no env is set); this guards only
  // an explicitly-set env secret that is too weak.
  const secret = config.authSecret;
  if (secret.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a multi-user auth server must not boot with a weak session secret
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET), if set, must be at least 32 characters");
  }
  return {
    // Hand Better Auth the SAME libSQL client SelfHostDb already opened — NOT a
    // fresh `{ url }` connection. `{ client }` makes LibsqlDialect adopt the
    // existing handle (closeClient=false, so SelfHostDb keeps ownership). One
    // connection means one WAL: see the header comment for why a second
    // connection is the self-host data-loss bug.
    //
    // The cast bridges a dependency skew: @libsql/kysely-libsql pins an older
    // @libsql/core (0.8) than @libsql/client (0.17), so the two `Client` types
    // differ — only in `.sync()` (embedded-replica replication, unused here).
    // The dialect calls execute/batch/transaction/close, which are identical
    // across both versions, so sharing the 0.17 client is sound at runtime.
    database: {
      // oxlint-disable-next-line executor/no-double-cast -- boundary: the two @libsql/core versions' Client types are structurally identical for the calls the dialect makes (see above); no schema/decode applies to a native client handle.
      dialect: new LibsqlDialect({ client } as unknown as LibsqlDialectConfig),
      type: "sqlite" as const,
      // Better Auth defaults Kysely transaction support off, even when the
      // dialect supports it. Signup claims rely on the user, membership,
      // credential account, session, and claim sharing one real transaction.
      transaction: true,
    },
    secret,
    // The browser Origin must match this exactly; CLI/MCP bearer requests carry
    // no Origin and are unaffected. `config.webBaseUrl` resolves from an explicit
    // EXECUTOR_WEB_BASE_URL, else a platform-injected origin (Railway/Render/Fly/
    // …), else localhost — so a PaaS deploy is zero-config and any other host
    // sets the one variable (a loud warning fires on the localhost fallback).
    // See config.ts. We deliberately do NOT derive this from the request `Host`:
    // matching the ecosystem (Windmill `BASE_URL`, n8n `WEBHOOK_URL`), a pinned
    // origin keeps host-header injection out of OAuth redirects and links.
    baseURL: config.webBaseUrl,
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
      signupClaimPlugin,
      admin(),
      apiKey({ enableSessionForAPIKeys: true, rateLimit: { enabled: false } }),
      bearer(),
      // RFC 8628 device authorization, the CLI `executor login` flow. Registers
      // /device/code + /device/token + the approval endpoints; the issued token
      // is an opaque session that `bearer()` (above) accepts as `Authorization:
      // Bearer` on the /api/* plane. `validateClient` is left unset, so any
      // client_id is accepted (the CLI presents "executor-cli"). `verificationUri`
      // is the page the user opens to confirm the code — the self-host app serves
      // it at /device (this is also the Better Auth default; pinned for clarity).
      deviceAuthorization({ verificationUri: "/device" }),
      // `consentPage` makes the MCP authorize flow redirect to a human approval
      // screen instead of auto-issuing a code — but ONLY when the request
      // carries `prompt=consent`. MCP clients don't send that, so the self-host
      // serving layer injects it on every authorize (see resolveAuthProviders'
      // force-mcp-consent shim); together they force an approval step for every
      // connecting client. The page itself is the SPA route `/mcp-consent`.
      // `loginPage` in oidcConfig is required by the type but the mcp() plugin
      // overrides it with the top-level one; `consentPage` is what we're after.
      mcp({
        loginPage: "/login",
        oidcConfig: { loginPage: "/login", consentPage: "/mcp-consent" },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Single-org instance: pin every session to the one organization, so
          // every authenticated user resolves to the org scope. The org id is
          // read late (the seed resolves it AFTER this instance is built — see
          // buildBetterAuth); no session is created during the seed, so the
          // empty initial value is never observed.
          before: async (session: Record<string, unknown>) => ({
            data: { ...session, activeOrganizationId: getOrganizationId() },
          }),
        },
      },
      // The signup gate reserves the first-owner slot or invite before creating
      // the user, then creates the membership and finalizes the claim before
      // creating the credential account. Better Auth wraps the whole email
      // signup in one database transaction, so any later failure rolls back the
      // user, membership, and claim together.
      ...(gate
        ? {
            user: {
              create: {
                before: async (user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  const adapter = await getCurrentAdapter(context.context.adapter);
                  const ownerClaim = await reserveFirstOwner(
                    adapter,
                    gate.organizationId,
                    user.email,
                  );
                  if (ownerClaim) {
                    signupClaims.set(context, ownerClaim);
                    return;
                  }
                  const code = inviteCodeFrom(context);
                  if (!code) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "An invite code is required to sign up.",
                    });
                  }
                  const inviteClaim = await reserveInviteCode(adapter, code, user.email);
                  if (!inviteClaim) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "That invite code is invalid, already used, or expired.",
                    });
                  }
                  signupClaims.set(context, inviteClaim);
                },
              },
            },
            account: {
              create: {
                before: async (account, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  const claim = signupClaims.get(context);
                  if (!claim) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "The signup claim could not be completed.",
                    });
                  }
                  const adapter = await getCurrentAdapter(context.context.adapter);
                  await adapter.create({
                    model: "member",
                    data: {
                      organizationId: gate.organizationId,
                      userId: account.userId,
                      role: claim.kind === "owner" ? "owner" : claim.role,
                      createdAt: new Date(),
                    },
                  });
                  const finalized =
                    claim.kind === "owner"
                      ? await finalizeFirstOwner(adapter, gate.organizationId, claim.claimId, {
                          id: account.userId,
                          email: claim.email,
                        })
                      : await finalizeInviteCode(adapter, claim, {
                          id: account.userId,
                          email: claim.email,
                        });
                  if (!finalized) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "The signup claim could not be completed.",
                    });
                  }
                  signupClaims.delete(context);
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

// Count org members via Better Auth's own adapter. System setup status uses the
// live membership count, while the durable signup claim separately prevents a
// previously claimed instance from reopening when every member is removed.
export const countOrgMembers = (auth: Auth, organizationId: string): Promise<number> =>
  auth.$context.then(({ adapter }) =>
    adapter.count({ model: "member", where: [{ field: "organizationId", value: organizationId }] }),
  );

const createAuthInstance = (client: Client, getOrganizationId: () => string, gate?: SignupGate) =>
  betterAuth(makeAuthOptions(client, getOrganizationId, gate));

export type Auth = ReturnType<typeof createAuthInstance>;

export interface BetterAuthHandle {
  readonly auth: Auth;
  readonly organizationId: string;
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly organizationSlug: string;
  readonly handler: (request: Request) => Promise<Response>;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthHandle>()(
  "@executor-js/host-selfhost/BetterAuth",
) {}

/**
 * Build the single Better Auth instance: migrate, seed the org+admin, and pin
 * the resolved org id into the (late-bound) session hook and signup gate.
 * runMigrations and the seed are idempotent, so this is safe on every boot.
 *
 * One instance, not two: the org id the session-pin and gate need isn't known
 * until the seed creates the org, but both read it lazily through one ref, so
 * there is no need for a throwaway bootstrap instance, and no second libSQL
 * connection to be GC-closed mid-boot and unlink the
 * shared WAL (see the header comment; that was the self-host data-loss bug).
 *
 * The gate is active during the seed, but its hooks only act on the
 * `/sign-up/email` path — the seed's admin `createUser`/`createOrganization`
 * pass straight through, exactly as the old gate-free bootstrap instance did.
 *
 * `client` is SelfHostDb's libSQL connection. Better Auth's LibsqlDialect is
 * built on this SAME client (not a fresh `{ url }` one — see the header
 * comment's data-loss note), so auth tables and executor tables share one
 * connection and one WAL. The seed also uses it directly for its two
 * idempotency reads against the auth tables Better Auth just migrated.
 */
export const buildBetterAuth = async (client: Client): Promise<BetterAuthHandle> => {
  const config = loadConfig();

  // The org id is resolved by the seed below, AFTER this instance is built; the
  // session-pin hook and the gate read it through this late-bound accessor (no
  // session is created during the seed, so the empty initial id is never
  // observed).
  const orgRef = { id: "" };
  const gate: SignupGate = {
    get organizationId() {
      return orgRef.id;
    },
  };

  const auth = createAuthInstance(client, () => orgRef.id, gate);
  // `runMigrations()` flows through the LibsqlDialect and is idempotent.
  await (await auth.$context).runMigrations();
  await ensureInviteCodeTable(client);
  const { organizationId, organizationName } = await seedOrgAndAdmin(auth, client, config);
  orgRef.id = organizationId;
  const handler = serializeEmailSignups(auth.handler);

  return {
    auth,
    organizationId,
    organizationName,
    organizationSlug: config.orgSlug,
    handler,
  };
};
