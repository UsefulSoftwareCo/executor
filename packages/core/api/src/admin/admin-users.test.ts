import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Data, Effect, Layer, type Scope } from "effect";

import {
  Subject,
  Tenant,
  collectTables,
  createExecutor,
  type AdminSubject,
  type Executor,
  type ExecutorAdmin,
} from "@executor-js/sdk";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "@executor-js/sdk/testing";
import { resetSubjectTouchCache, touchSubject } from "@executor-js/sdk/host-internal";

import { AdminUsersHttpApi, AdminUsersForbidden, AdminUsersUnauthorized } from "./api";
import { AdminUsersHandlers } from "./handlers";
import { AdminUsersProvider, type AdminUsersHeaders } from "./service";
import {
  getUser,
  listUserConnections,
  listUsers,
  listUsersWithConnections,
  platformViewOf,
  type AdminIdentityDirectory,
  type AdminUserDirectory,
} from "./reads";

// ---------------------------------------------------------------------------
// The admin users HTTP surface, over a real SQLite-backed platform view.
//
// The reads themselves (tenant reach, the bigint `last_seen_at` round-trip, the
// field allowlist) are proven in the SDK's `platform-view.test.ts`. What this
// file proves is the HTTP EDGE on top of them:
//   - the public vocabulary + wire shapes the contract promises,
//   - the authorization outcomes (401 vs 403) a host's provider produces,
//   - that a tenant's admin plane cannot see another tenant's rows,
//   - that no credential-bearing field survives the projection.
//
// The provider seam is stubbed the way each host's real one behaves, so the
// authz assertions are about the CONTRACT (which status a refusal renders),
// not about WorkOS or Better Auth.
// ---------------------------------------------------------------------------

const TENANT_A = "org_a";
const TENANT_B = "org_b";
const USER_A1 = "user_a1";
const USER_A2 = "user_a2";
const USER_B1 = "user_b1";

/** Every field that could resolve, or help resolve, a credential. NONE may
 *  appear anywhere in an admin HTTP response — enumerated so a future column
 *  addition has to be argued with this list. Mirrors the SDK's own list. */
const FORBIDDEN_FIELDS = [
  "item_ids",
  "itemIds",
  "refresh_item_id",
  "refreshItemId",
  "provider",
  "provider_state",
  "providerState",
  "oauth_token_url",
  "oauthTokenUrl",
  "template",
  "client_secret",
  "clientSecret",
  "secret",
  "token",
  // The internal partition keys: the public vocabulary is users/owners, so
  // neither the raw column name nor the tenant may leak onto the wire.
  "subject",
  "tenant",
  // The upstream-derived halves of a stored health verdict. These are not
  // CREDENTIALS — they are the provider's own response content: the account
  // identity extracted from `identityField` (another user's email at the
  // provider), a raw diagnostic that can quote an upstream error body, and a
  // sample of the real response body. `lastHealth` is an allowed COLUMN, which
  // is exactly why these need naming: the per-column allowlist passed while the
  // whole nested object rode along inside it. `AdminConnectionHealth` narrows
  // it to status + checkedAt; this list is what keeps it narrow.
  "identity",
  "detail",
  "responseSample",
  "httpStatus",
] as const;

// The bodies below acquire a scoped web handler, so `R` carries `Scope` rather
// than being erased; `Effect.scoped` closes it when the body finishes.
const withDb = <A, E>(
  body: (db: SqliteTestFumaDb) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      body,
      (db) => Effect.promise(() => db.close()),
    ),
  );

const insertConnection = (
  db: SqliteTestFumaDb,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly owner: string;
    readonly subject: string;
    readonly integration: string;
    readonly name: string;
    readonly oauthScope?: string | null;
  },
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await db.client.execute({
      sql: `INSERT INTO connection (
          row_id, tenant, owner, subject, integration, name, template, provider,
          item_ids, refresh_item_id, oauth_scope, last_health, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.rowId,
        row.tenant,
        row.owner,
        row.subject,
        row.integration,
        row.name,
        "oauth2",
        "memory",
        // Deliberately secret-bearing: the assertions below prove these never
        // reach an HTTP response.
        JSON.stringify({ token: `SECRET-item-${row.rowId}` }),
        `SECRET-refresh-${row.rowId}`,
        row.oauthScope ?? null,
        // A REAL stored health verdict, including the parts that come from the
        // upstream provider's own response. `identity` is the value pulled from
        // the configured `identityField` (typically the account's email AT the
        // provider), `detail` is a raw diagnostic that can quote an upstream
        // body, and `responseSample` is a bounded sample of the actual response
        // body's scalar leaves. All three are legitimate on the product plane,
        // where the caller owns the credential — and none may cross onto the
        // ADMIN plane, which reports on other people's connections. Seeded here
        // so the assertions below have ground truth to catch rather than
        // asserting the absence of something that was never present.
        JSON.stringify({
          status: "healthy",
          checkedAt: 1_700_000_000_000,
          httpStatus: 200,
          identity: `UPSTREAM-identity-${row.rowId}@provider.test`,
          detail: `UPSTREAM-detail-${row.rowId}`,
          responseSample: [
            { path: "user.email", value: `UPSTREAM-sample-${row.rowId}@provider.test` },
            { path: "user.login", value: `UPSTREAM-login-${row.rowId}` },
          ],
        }),
        Date.now(),
        Date.now(),
      ],
    });
  });

/** Two users with connections under tenant A, plus a whole separate tenant B
 *  that A's admin plane must never see. */
const seed = (db: SqliteTestFumaDb): Effect.Effect<void> =>
  Effect.gen(function* () {
    // `touchSubject` keeps a process-local memory of principals it already
    // filed, so a second seed against a FRESH database would be skipped as a
    // repeat sighting and leave the table empty. Each seed is a new world.
    resetSubjectTouchCache();

    yield* touchSubject(db.db, { tenant: TENANT_A, externalId: USER_A1 });
    yield* touchSubject(db.db, { tenant: TENANT_A, externalId: USER_A2 });
    yield* touchSubject(db.db, { tenant: TENANT_B, externalId: USER_B1 });

    yield* insertConnection(db, {
      rowId: "c-a1-gh",
      tenant: TENANT_A,
      owner: "user",
      subject: USER_A1,
      integration: "github",
      name: "personal",
      oauthScope: "repo read:user",
    });
    yield* insertConnection(db, {
      rowId: "c-a2-linear",
      tenant: TENANT_A,
      owner: "user",
      subject: USER_A2,
      integration: "linear",
      name: "work",
    });
    yield* insertConnection(db, {
      rowId: "c-b1-gh",
      tenant: TENANT_B,
      owner: "user",
      subject: USER_B1,
      integration: "github",
      name: "b-secret",
      oauthScope: "admin:org",
    });
  });

const platformExecutorFor = (db: SqliteTestFumaDb, tenant: string): Effect.Effect<Executor> =>
  createExecutor({
    tenant: Tenant.make(tenant),
    db: db.db,
    onElicitation: "accept-all",
    platformView: true,
  }).pipe(Effect.orDie);

/** A product-view executor: bound to one subject, no platform view at all. */
const productExecutorFor = (db: SqliteTestFumaDb, tenant: string): Effect.Effect<Executor> =>
  createExecutor({
    tenant: Tenant.make(tenant),
    subject: Subject.make(USER_A1),
    db: db.db,
    onElicitation: "accept-all",
  }).pipe(Effect.orDie);

/**
 * A stub `AdminUsersProvider` shaped like a host's real one: it authorizes off
 * the request headers, then delegates to the shared reads. `authorize` returns
 * the tenant an authorized caller may read, or a refusal — exactly the decision
 * cloud makes from an org key / admin session and self-host from a Better Auth
 * member.
 */
const stubProvider = (
  executorFor: (tenant: string) => Effect.Effect<Executor>,
  authorize: (
    headers: AdminUsersHeaders,
  ) => Effect.Effect<string, AdminUsersUnauthorized | AdminUsersForbidden>,
  directory?: AdminIdentityDirectory | AdminUserDirectory,
) =>
  Layer.succeed(AdminUsersProvider)({
    listUsers: (headers, options) =>
      authorize(headers).pipe(
        Effect.flatMap(executorFor),
        Effect.flatMap((executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listUsers(admin, options, directory)),
          ),
        ),
      ),
    listUsersWithConnections: (headers, options) =>
      authorize(headers).pipe(
        Effect.flatMap(executorFor),
        Effect.flatMap((executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listUsersWithConnections(admin, options, directory)),
          ),
        ),
      ),
    listUserConnections: (headers, externalId) =>
      authorize(headers).pipe(
        Effect.flatMap(executorFor),
        Effect.flatMap((executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listUserConnections(admin, externalId)),
          ),
        ),
      ),
    getUser: (headers, identifier) =>
      authorize(headers).pipe(
        Effect.flatMap(executorFor),
        Effect.flatMap((executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => getUser(admin, identifier, directory)),
          ),
        ),
      ),
  });

/**
 * The authorization the hosts implement, reduced to its decision table:
 * an org-scoped key (or admin session) names its tenant; a plain member or a
 * user-scoped key is forbidden; no credential at all is unauthorized.
 */
const headerAuthorize = (headers: AdminUsersHeaders) => {
  const credential = headers["authorization"];
  if (!credential) return Effect.fail(new AdminUsersUnauthorized());
  if (credential === "Bearer org_a_key") return Effect.succeed(TENANT_A);
  if (credential === "Bearer org_b_key") return Effect.succeed(TENANT_B);
  // A valid user-scoped key / plain member session: authentic, but this plane
  // serves the whole tenant and they name one member.
  return Effect.fail(new AdminUsersForbidden());
};

// `HttpRouter.provideRequest` (not a plain `Layer.provide`) is what clears the
// handlers' per-request `AdminUsersProvider` marker — the same reason the real
// hosts mount the provider through a router middleware.
const webHandlerFor = (provider: Layer.Layer<AdminUsersProvider>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(AdminUsersHttpApi).pipe(
          Layer.provide(AdminUsersHandlers),
          HttpRouter.provideRequest(provider),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const get = (
  web: {
    readonly handler: (request: Request, context: Context.Context<never>) => Promise<Response>;
  },
  path: string,
  credential?: string,
) =>
  Effect.promise(() =>
    web.handler(
      new Request(`http://localhost${path}`, {
        headers: credential ? { authorization: credential } : {},
      }),
      Context.empty(),
    ),
  );

const jsonOf = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

type UsersBody = {
  readonly users: ReadonlyArray<{
    readonly externalId: string;
    readonly email: string | null;
    readonly displayName: string | null;
  }>;
};
type ConnectionsBody = {
  readonly connections: ReadonlyArray<{ readonly integration: string; readonly name: string }>;
};
type UserBody = {
  readonly user: {
    readonly externalId: string;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly lastSeenAt: number | null;
    readonly status: string | null;
    readonly connections: ReadonlyArray<{
      readonly integration: string;
      readonly oauthScope: string | null;
      readonly lastHealth: { readonly status: string } | null;
    }>;
  };
};
type UsersWithConnectionsBody = {
  readonly users: ReadonlyArray<{
    readonly externalId: string;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly lastSeenAt: number | null;
    readonly status: string | null;
    readonly connections: ReadonlyArray<{
      readonly integration: string;
      readonly oauthScope: string | null;
      readonly lastHealth: { readonly status: string } | null;
    }>;
  }>;
};

const ORG_A = "Bearer org_a_key";

/**
 * A host member directory that knows USER_A1 only.
 *
 * USER_A2 is deliberately absent — that is the real case of a member who left
 * the org while their connections remain, and the one an id-space mismatch would
 * also look like. `seen` records the ids the directory was asked for, so a test
 * can prove the join is ONE batched read of the returned page rather than a
 * lookup per user.
 */
const stubDirectory =
  (seen: string[][]): AdminIdentityDirectory =>
  (externalIds) => {
    seen.push([...externalIds]);
    return Effect.succeed(new Map([[USER_A1, { email: "a1@users.test", displayName: "User A1" }]]));
  };

/** The email the stub directory knows USER_A1 by. Stored MIXED-CASE on
 *  purpose: WorkOS preserves whatever casing a user was created with, so the
 *  case-insensitivity rule has to hold against a non-normalized directory
 *  value, not just a non-normalized query. */
const A1_EMAIL_STORED = "A1@Users.Test";
const A1_EMAIL = "a1@users.test";

/**
 * The two-way directory: the same USER_A1-only knowledge as `stubDirectory`,
 * plus the reverse resolver.
 *
 * USER_A2 stays absent in BOTH directions, so it doubles as the "member the
 * directory cannot name" case. `resolved` records every email the resolver was
 * asked for, so a test can prove the lookup normalizes before comparing.
 */
const stubUserDirectory = (options: {
  readonly seen?: string[][];
  readonly resolved?: string[];
}): AdminUserDirectory => ({
  identities: (externalIds) => {
    options.seen?.push([...externalIds]);
    return Effect.succeed(new Map([[USER_A1, { email: A1_EMAIL_STORED, displayName: "User A1" }]]));
  },
  resolveEmail: (email) => {
    options.resolved?.push(email);
    // Compares a NORMALIZED stored value, the rule both real hosts follow.
    return Effect.succeed(A1_EMAIL_STORED.toLowerCase() === email ? USER_A1 : null);
  },
});

/** The failure a host's directory raises — WorkOS or Better Auth being
 *  unreachable. Typed rather than a bare `Error`, since the directory seam's
 *  `unknown` error channel exists to carry each host's OWN error type. */
class DirectoryUnavailable extends Data.TaggedError("DirectoryUnavailable")<{
  readonly message: string;
}> {}

/** A directory whose read fails, standing in for a WorkOS/Better Auth outage. */
const failingDirectory: AdminIdentityDirectory = () =>
  Effect.fail(new DirectoryUnavailable({ message: "member directory unavailable" }));

describe("admin users API", () => {
  it.effect("lists every user of the tenant for an authorized org caller", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const response = yield* get(web, "/admin/users", ORG_A);
        expect(response.status).toBe(200);
        const body = yield* jsonOf<UsersBody>(response);

        expect(
          body.users.map((user) => user.externalId),
          "both of the tenant's users are reported",
        ).toEqual([USER_A1, USER_A2]);
      }),
    ),
  );

  it.effect("reports a user's connections with access summary but no credential", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const response = yield* get(web, `/admin/users/${USER_A1}/connections`, ORG_A);
        expect(response.status).toBe(200);
        const body = yield* jsonOf<ConnectionsBody>(response);

        expect(
          body.connections.map((connection) => connection.integration),
          "the user's own connection is reported",
        ).toEqual(["github"]);
        expect(body.connections[0]?.name).toBe("personal");
      }),
    ),
  );

  it.effect("joins users with their connections for the dashboard view", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const response = yield* get(web, "/admin/users/with-connections", ORG_A);
        expect(response.status).toBe(200);
        const body = yield* jsonOf<UsersWithConnectionsBody>(response);

        expect(
          body.users.map((user) => [user.externalId, user.connections.map((c) => c.integration)]),
          "each user carries their own connections",
        ).toEqual([
          [USER_A1, ["github"]],
          [USER_A2, ["linear"]],
        ]);
        // The access summary and health travel; `lastSeenAt` is a number the
        // dashboard can render (a raw SQL read would hand back a blob).
        expect(body.users[0]?.connections[0]?.oauthScope).toBe("repo read:user");
        expect(body.users[0]?.connections[0]?.lastHealth?.status).toBe("healthy");
        expect(typeof body.users[0]?.lastSeenAt).toBe("number");
        expect(body.users[0]?.status, "no lifecycle state is recorded yet").toBeNull();
      }),
    ),
  );

  it.effect("never serves credential material on any admin response", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        for (const path of [
          "/admin/users",
          "/admin/users/with-connections",
          `/admin/users/${USER_A1}/connections`,
          `/admin/users/${USER_A1}`,
        ]) {
          const response = yield* get(web, path, ORG_A);
          const raw = yield* Effect.promise(() => response.text());

          for (const field of FORBIDDEN_FIELDS) {
            expect(raw, `${path} must not expose "${field}"`).not.toContain(`"${field}"`);
          }
          // The seeded secrets are the ground truth: nothing derived from a
          // credential may appear, whatever it is called.
          expect(raw, `${path} must not leak a stored secret`).not.toContain("SECRET-");
          // And the same test for upstream ACCOUNT data, which is a different
          // kind of leak from a credential and was reaching the wire inside
          // `lastHealth`. Matching on the seeded marker rather than on field
          // names catches a rename, a re-nesting, or a stringified blob.
          expect(raw, `${path} must not leak upstream account data`).not.toContain("UPSTREAM-");
        }
      }),
    ),
  );

  it.effect("isolates tenants: an org caller sees nothing of another tenant", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const users = yield* jsonOf<UsersBody>(yield* get(web, "/admin/users", ORG_A));
        expect(
          users.users.map((user) => user.externalId),
          "tenant B's user is invisible to tenant A",
        ).not.toContain(USER_B1);

        // Naming another tenant's user directly returns nothing rather than
        // that user's connections — the tenant clause is never relaxed.
        const crossTenant = yield* jsonOf<ConnectionsBody>(
          yield* get(web, `/admin/users/${USER_B1}/connections`, ORG_A),
        );
        expect(crossTenant.connections, "tenant B's connections stay in tenant B").toEqual([]);

        // And tenant B's own caller does see them — proving the emptiness above
        // is isolation, not a broken fixture.
        const ownView = yield* jsonOf<ConnectionsBody>(
          yield* get(web, `/admin/users/${USER_B1}/connections`, "Bearer org_b_key"),
        );
        expect(ownView.connections.map((c) => c.name)).toEqual(["b-secret"]);
      }),
    ),
  );

  it.effect("refuses a caller with no credential and a caller who is only a member", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const anonymous = yield* get(web, "/admin/users");
        expect(anonymous.status, "no credential → unauthorized").toBe(401);

        // A user-scoped API key or plain member session: authentic, but this
        // plane serves the whole tenant.
        const member = yield* get(web, "/admin/users", "Bearer user_scoped_key");
        expect(member.status, "a non-admin caller → forbidden").toBe(403);

        const memberJoined = yield* get(web, "/admin/users/with-connections", "Bearer user_key");
        expect(memberJoined.status).toBe(403);
        const memberConnections = yield* get(
          web,
          `/admin/users/${USER_A1}/connections`,
          "Bearer user_key",
        );
        expect(memberConnections.status).toBe(403);

        // The single-user read refuses on the same terms, and crucially it
        // refuses BEFORE looking: an unauthorized caller must not be able to
        // tell a real user from an absent one by the status they get back.
        expect((yield* get(web, `/admin/users/${USER_A1}`)).status).toBe(401);
        expect((yield* get(web, `/admin/users/${USER_A1}`, "Bearer user_key")).status).toBe(403);
        expect((yield* get(web, "/admin/users/nobody", "Bearer user_key")).status).toBe(403);
      }),
    ),
  );

  // The response schema strips unknown fields on encode, so the HTTP assertions
  // above would still pass if the projection leaked one. Assert the projection
  // directly too: it is the layer that is supposed to be an allowlist, and both
  // layers should hold on their own.
  it.effect("projects only allowlisted fields, before the schema ever encodes", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* platformExecutorFor(db, TENANT_A);
        const admin = yield* platformViewOf(executor);

        const { connections } = yield* listUserConnections(admin, USER_A1);
        expect(
          Object.keys(connections[0] ?? {}).sort(),
          "the connection projection is exactly the allowlist",
        ).toEqual(["integration", "lastHealth", "name", "oauthScope", "owner"]);

        // `lastHealth` is an allowed column holding a nested object, so the
        // allowlist has to reach INSIDE it — a whole-object forward is what let
        // the provider's `identity` / `detail` / `responseSample` onto the
        // wire. The stored verdict here carries all of them (see the seed), so
        // this is a projection assertion, not a vacuous one.
        expect(
          Object.keys(connections[0]?.lastHealth ?? {}).sort(),
          "the health projection is exactly status + checkedAt",
        ).toEqual(["checkedAt", "status"]);
        expect(connections[0]?.lastHealth?.status, "and the verdict itself survives").toBe(
          "healthy",
        );

        const { users } = yield* listUsers(admin, {});
        expect(
          Object.keys(users[0] ?? {}).sort(),
          "the user projection is exactly the allowlist",
        ).toEqual(["createdAt", "displayName", "email", "externalId", "lastSeenAt", "status"]);
      }),
    ),
  );

  it.effect("fails loudly when wired to a product-view executor", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // A host that forgot `platformView: true` must not silently report an
        // empty tenant — that would read as "this owner has no users".
        const web = yield* webHandlerFor(
          stubProvider((tenant) => productExecutorFor(db, tenant), headerAuthorize),
        );

        const response = yield* get(web, "/admin/users", ORG_A);
        expect(response.status, "a missing platform view is a server error").toBe(500);
      }),
    ),
  );

  // ── Host identity join ────────────────────────────────────────────────────

  it.effect("joins the host's email and name onto users the directory resolves", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const seen: string[][] = [];
        const web = yield* webHandlerFor(
          stubProvider(
            (tenant) => platformExecutorFor(db, tenant),
            headerAuthorize,
            stubDirectory(seen),
          ),
        );

        const body = yield* jsonOf<UsersBody>(yield* get(web, "/admin/users", ORG_A));
        expect(
          body.users.map((user) => [user.externalId, user.email, user.displayName]),
          "the resolvable member is named; the unresolvable one reports absent identity",
        ).toEqual([
          [USER_A1, "a1@users.test", "User A1"],
          [USER_A2, null, null],
        ]);

        // The join is a BATCH: one directory read for the whole page, carrying
        // every id at once — never one read per user.
        expect(seen, "one directory read, for exactly the page's ids").toEqual([
          [USER_A1, USER_A2],
        ]);
      }),
    ),
  );

  it.effect("joins identity onto the connections view too, over the same one read", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const seen: string[][] = [];
        const web = yield* webHandlerFor(
          stubProvider(
            (tenant) => platformExecutorFor(db, tenant),
            headerAuthorize,
            stubDirectory(seen),
          ),
        );

        const body = yield* jsonOf<UsersWithConnectionsBody>(
          yield* get(web, "/admin/users/with-connections", ORG_A),
        );
        expect(body.users.map((user) => [user.externalId, user.email])).toEqual([
          [USER_A1, "a1@users.test"],
          [USER_A2, null],
        ]);
        expect(seen.length, "still one directory read for the page").toBe(1);
      }),
    ),
  );

  // Identity is decoration on an operator view, not the answer: a directory
  // outage must cost the rows their names, never cost the operator the read.
  it.effect("still serves users when the host's identity lookup fails", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider(
            (tenant) => platformExecutorFor(db, tenant),
            headerAuthorize,
            failingDirectory,
          ),
        );

        const response = yield* get(web, "/admin/users", ORG_A);
        expect(response.status, "a directory outage is not a failed request").toBe(200);
        const body = yield* jsonOf<UsersBody>(response);
        expect(
          body.users.map((user) => [user.externalId, user.email, user.displayName]),
          "every user is still reported, simply unnamed",
        ).toEqual([
          [USER_A1, null, null],
          [USER_A2, null, null],
        ]);
      }),
    ),
  );

  // A host that cannot map its id space to a directory at all passes none. The
  // rows must still be complete — absent identity, not a missing field.
  it.effect("reports absent identity when the host wires no directory", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const body = yield* jsonOf<UsersBody>(yield* get(web, "/admin/users", ORG_A));
        expect(body.users.map((user) => [user.email, user.displayName])).toEqual([
          [null, null],
          [null, null],
        ]);
      }),
    ),
  );

  // Email and name are the ONLY fields this join is allowed to add. The
  // forbidden-field assertions above run without a directory, so re-run the
  // credential check with one wired: a directory is a new data source reaching
  // the response, and it must not become a hole in the allowlist.
  it.effect("adds only email and displayName to the allowlist", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const seen: string[][] = [];
        const web = yield* webHandlerFor(
          stubProvider(
            (tenant) => platformExecutorFor(db, tenant),
            headerAuthorize,
            stubUserDirectory({ seen }),
          ),
        );

        for (const path of [
          "/admin/users",
          "/admin/users/with-connections",
          // The single-user read joins identity through the same seam, so it
          // gets the same sweep — including the email-addressed form, whose
          // response is built on a directory value.
          `/admin/users/${USER_A1}`,
          `/admin/users/${encodeURIComponent(A1_EMAIL)}`,
          `/admin/users?email=${encodeURIComponent(A1_EMAIL)}`,
        ]) {
          const response = yield* get(web, path, ORG_A);
          const raw = yield* Effect.promise(() => response.text());
          for (const field of FORBIDDEN_FIELDS) {
            expect(raw, `${path} must not expose "${field}"`).not.toContain(`"${field}"`);
          }
          expect(raw, `${path} must not leak a stored secret`).not.toContain("SECRET-");
        }
      }),
    ),
  );

  it.effect("pages the user list", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        const first = yield* jsonOf<UsersBody>(yield* get(web, "/admin/users?limit=1", ORG_A));
        expect(first.users.map((user) => user.externalId)).toEqual([USER_A1]);

        const second = yield* jsonOf<UsersBody>(
          yield* get(web, "/admin/users?limit=1&offset=1", ORG_A),
        );
        expect(second.users.map((user) => user.externalId)).toEqual([USER_A2]);
      }),
    ),
  );

  // `offset` and `limit` are independently optional in the contract, so
  // `?offset=` alone is a request a consumer will make. Drizzle's SQLite
  // dialect emits OFFSET only alongside LIMIT and SQLite rejects a bare OFFSET,
  // so this used to 500 on every SQLite host — local, self-host and D1 alike.
  // The SDK's default page size is what makes it a legal query.
  it.effect("serves an offset with no limit rather than 500ing", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        for (const path of ["/admin/users?offset=1", "/admin/users/with-connections?offset=1"]) {
          const response = yield* get(web, path, ORG_A);
          expect(response.status, path).toBe(200);
          expect((yield* jsonOf<UsersBody>(response)).users.map((user) => user.externalId)).toEqual(
            [USER_A2],
          );
        }

        // Well past the end is an empty page, still a 200.
        const far = yield* get(web, "/admin/users?offset=25", ORG_A);
        expect(far.status).toBe(200);
        expect((yield* jsonOf<UsersBody>(far)).users).toEqual([]);
      }),
    ),
  );

  // A fraction decoded cleanly through `FiniteFromString` and reached the
  // driver as a `datatype mismatch` 500. A row count is an integer by nature,
  // so the contract rejects it up front — the same 400 a non-numeric value gets,
  // which is what the schema's comment always claimed.
  it.effect("400s a fractional limit or offset instead of failing in the driver", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize),
        );

        for (const path of [
          "/admin/users?limit=1.5",
          "/admin/users?offset=0.5",
          "/admin/users/with-connections?limit=1.5",
          // Still 400s for the reasons that already held.
          "/admin/users?limit=abc",
          "/admin/users?limit=0",
          "/admin/users?limit=501",
        ]) {
          expect((yield* get(web, path, ORG_A)).status, path).toBe(400);
        }

        // The integral neighbours are unaffected.
        expect((yield* get(web, "/admin/users?limit=1&offset=0", ORG_A)).status).toBe(200);
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // Single-user reads, by opaque id and by email.
  // -------------------------------------------------------------------------

  const singleUserWeb = (db: SqliteTestFumaDb, resolved?: string[]) =>
    webHandlerFor(
      stubProvider(
        (tenant) => platformExecutorFor(db, tenant),
        headerAuthorize,
        stubUserDirectory(resolved ? { resolved } : {}),
      ),
    );

  it.effect("returns one user with identity and connections in a single call", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* singleUserWeb(db);

        const response = yield* get(web, `/admin/users/${USER_A1}`, ORG_A);
        expect(response.status).toBe(200);
        const body = yield* jsonOf<UserBody>(response);

        // The whole point of the endpoint: identity AND connections together,
        // so a per-user check needs exactly one request.
        expect(body.user.externalId).toBe(USER_A1);
        expect(body.user.email).toBe(A1_EMAIL_STORED);
        expect(body.user.displayName).toBe("User A1");
        expect(typeof body.user.lastSeenAt).toBe("number");
        expect(body.user.connections.map((connection) => connection.integration)).toEqual([
          "github",
        ]);
        expect(body.user.connections[0]?.oauthScope).toBe("repo read:user");
        expect(body.user.connections[0]?.lastHealth?.status).toBe("healthy");
      }),
    ),
  );

  it.effect("finds the same user by email, case-insensitively", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const resolved: string[] = [];
        const web = yield* singleUserWeb(db, resolved);

        // Three spellings of one address: as stored, all-lower, and shouted.
        for (const spelling of [A1_EMAIL_STORED, A1_EMAIL, A1_EMAIL.toUpperCase()]) {
          const response = yield* get(web, `/admin/users/${encodeURIComponent(spelling)}`, ORG_A);
          expect(response.status, `${spelling} should resolve`).toBe(200);
          const body = yield* jsonOf<UserBody>(response);
          expect(body.user.externalId).toBe(USER_A1);
          expect(body.user.connections.map((connection) => connection.integration)).toEqual([
            "github",
          ]);
        }

        // The seam normalizes before the resolver ever sees the value, so a
        // host implementation never has to repeat the rule for the QUERY side.
        expect(resolved).toEqual([A1_EMAIL, A1_EMAIL, A1_EMAIL]);
      }),
    ),
  );

  it.effect("404s an unknown id and an unknown email, distinctly from 401 and 403", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* singleUserWeb(db);

        const unknownId = yield* get(web, "/admin/users/user_nobody", ORG_A);
        expect(unknownId.status).toBe(404);
        const unknownEmail = yield* get(
          web,
          `/admin/users/${encodeURIComponent("nobody@users.test")}`,
          ORG_A,
        );
        expect(unknownEmail.status).toBe(404);

        // The distinct error is what lets a caller tell "no footprint" from
        // "bad credential" without parsing a message. Asserted on the encoded
        // body, which is what a consumer actually receives.
        expect(yield* Effect.promise(() => unknownId.text())).toContain("AdminUserNotFound");

        // And 404 must not echo the identifier back.
        const raw = yield* Effect.promise(() => unknownEmail.text());
        expect(raw).not.toContain("nobody@users.test");
      }),
    ),
  );

  it.effect("404s a user of ANOTHER tenant rather than revealing them", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* singleUserWeb(db);

        // B's user exists, but not for A — the same answer as a nonexistent id,
        // which is what keeps the admin plane tenant-isolated.
        expect((yield* get(web, `/admin/users/${USER_B1}`, ORG_A)).status).toBe(404);
        expect((yield* get(web, `/admin/users/${USER_B1}`, "Bearer org_b_key")).status).toBe(200);
      }),
    ),
  );

  // The decision documented on the contract: the admin plane reports FOOTPRINT,
  // not org membership. A directory member who never touched executor is a 404,
  // not identity-with-empty-connections — otherwise a caller gating on this
  // endpoint would treat a never-onboarded invitee as onboarded.
  it.effect("404s an email the directory knows but who has no subject row", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // Seed connections/tenant B but NOT a subject row for the directory's
        // only known member, so the directory resolves and storage does not.
        yield* touchSubject(db.db, { tenant: TENANT_B, externalId: USER_B1 });
        const web = yield* singleUserWeb(db);

        const response = yield* get(web, `/admin/users/${encodeURIComponent(A1_EMAIL)}`, ORG_A);
        expect(response.status, "known to the directory, unknown to this tenant").toBe(404);
        expect(yield* Effect.promise(() => response.text())).toContain("AdminUserNotFound");
      }),
    ),
  );

  it.effect("filters the bulk lists by email, and returns an empty list for an unknown one", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* singleUserWeb(db);

        const filtered = yield* jsonOf<UsersBody>(
          yield* get(
            web,
            `/admin/users?email=${encodeURIComponent(A1_EMAIL.toUpperCase())}`,
            ORG_A,
          ),
        );
        expect(filtered.users.map((user) => user.externalId)).toEqual([USER_A1]);

        const joined = yield* jsonOf<UsersWithConnectionsBody>(
          yield* get(
            web,
            `/admin/users/with-connections?email=${encodeURIComponent(A1_EMAIL)}`,
            ORG_A,
          ),
        );
        expect(joined.users.map((user) => user.externalId)).toEqual([USER_A1]);
        expect(joined.users[0]?.connections.map((c) => c.integration)).toEqual(["github"]);

        // An unknown email is an empty page, never an unfiltered one — the
        // failure mode that would quietly hand back the whole tenant.
        const unknown = yield* jsonOf<UsersBody>(
          yield* get(web, "/admin/users?email=nobody%40users.test", ORG_A),
        );
        expect(unknown.users).toEqual([]);
      }),
    ),
  );

  // A resolver OUTAGE must not read as "no such user": that is a wrong answer an
  // operator would act on. Contrast with the identity join, which degrades to
  // unnamed rows precisely because it is decoration.
  it.effect("500s when the email resolver fails, rather than reporting no match", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* webHandlerFor(
          stubProvider((tenant) => platformExecutorFor(db, tenant), headerAuthorize, {
            resolveEmail: () => Effect.fail(new DirectoryUnavailable({ message: "down" })),
          }),
        );

        expect(
          (yield* get(web, `/admin/users/${encodeURIComponent(A1_EMAIL)}`, ORG_A)).status,
        ).toBe(500);
        expect((yield* get(web, `/admin/users?email=${A1_EMAIL}`, ORG_A)).status).toBe(500);
      }),
    ),
  );

  // `externalId` is opaque by contract, so the "@" test is a routing hint and
  // not a parse: an id that happens to contain "@" must still be findable.
  it.effect("falls back to a literal id lookup for an id containing @", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const oddId = "user@odd";
        yield* touchSubject(db.db, { tenant: TENANT_A, externalId: oddId });
        const web = yield* singleUserWeb(db);

        const response = yield* get(web, `/admin/users/${encodeURIComponent(oddId)}`, ORG_A);
        expect(response.status).toBe(200);
        expect((yield* jsonOf<UserBody>(response)).user.externalId).toBe(oddId);
      }),
    ),
  );

  it.effect("still resolves /with-connections as the list, not as a user id", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const web = yield* singleUserWeb(db);

        // The router-ordering invariant, asserted rather than trusted: the
        // static segment must keep winning now that `/:identifier` exists.
        const body = yield* jsonOf<UsersWithConnectionsBody>(
          yield* get(web, "/admin/users/with-connections", ORG_A),
        );
        expect(body.users.map((user) => user.externalId)).toEqual([USER_A1, USER_A2]);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// `?email=` is a KEYED read, not a filtered scan.
//
// These drive the reads directly over a recording `ExecutorAdmin`, because the
// property under test is WHICH storage call the filter makes — invisible from
// the HTTP edge, where a page-then-filter and a keyed read return the same
// body. That equivalence is exactly what let the joined view read 100 subjects
// (and their connections) to answer with one row.
// ---------------------------------------------------------------------------

const A_SUBJECT: AdminSubject = {
  externalId: USER_A1,
  createdAt: new Date(0),
  lastSeenAt: null,
  status: null,
};

/** An `ExecutorAdmin` that answers everything and records the reads it was
 *  asked for, so a test can assert the call the filter chose. */
const recordingAdmin = (calls: string[]): ExecutorAdmin => ({
  listSubjects: () => {
    calls.push("listSubjects");
    return Effect.succeed([A_SUBJECT]);
  },
  getSubject: () => {
    calls.push("getSubject");
    return Effect.succeed(A_SUBJECT);
  },
  listSubjectConnections: () => {
    calls.push("listSubjectConnections");
    return Effect.succeed([]);
  },
  listSubjectsWithConnections: () => {
    calls.push("listSubjectsWithConnections");
    return Effect.succeed([{ ...A_SUBJECT, connections: [] }]);
  },
  getSubjectWithConnections: () => {
    calls.push("getSubjectWithConnections");
    return Effect.succeed({ ...A_SUBJECT, connections: [] });
  },
});

describe("admin users reads — the ?email= filter is applied before the read", () => {
  it.effect("resolves the joined view through the keyed read, never a page scan", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = yield* listUsersWithConnections(
        recordingAdmin(calls),
        { email: A1_EMAIL },
        stubUserDirectory({}),
      );

      expect(calls).toEqual(["getSubjectWithConnections"]);
      expect(body.users.map((user) => user.externalId)).toEqual([USER_A1]);
    }),
  );

  it.effect("resolves the plain list through the keyed read too", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = yield* listUsers(
        recordingAdmin(calls),
        { email: A1_EMAIL },
        stubUserDirectory({}),
      );

      expect(calls).toEqual(["getSubject"]);
      expect(body.users.map((user) => user.externalId)).toEqual([USER_A1]);
    }),
  );

  it.effect("issues NO storage read at all for an email the directory cannot name", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = yield* listUsersWithConnections(
        recordingAdmin(calls),
        { email: "nobody@users.test" },
        stubUserDirectory({}),
      );

      expect(calls).toEqual([]);
      expect(body.users).toEqual([]);
    }),
  );

  it.effect("still pages the filtered result: offset past the only row is empty", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const admin = recordingAdmin(calls);

      const first = yield* listUsersWithConnections(
        admin,
        { email: A1_EMAIL, offset: 0, limit: 10 },
        stubUserDirectory({}),
      );
      const past = yield* listUsersWithConnections(
        admin,
        { email: A1_EMAIL, offset: 1, limit: 10 },
        stubUserDirectory({}),
      );

      expect(first.users.map((user) => user.externalId)).toEqual([USER_A1]);
      expect(past.users).toEqual([]);
    }),
  );

  it.effect("leaves the unfiltered list on the paged read", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* listUsersWithConnections(recordingAdmin(calls), { limit: 50 }, stubUserDirectory({}));

      expect(calls).toEqual(["listSubjectsWithConnections"]);
    }),
  );
});
