import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { type InStatement } from "@libsql/client";

import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
  collectTables,
  createExecutor,
  type Executor,
} from "./executor";
import { StorageError } from "./fuma-runtime";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import {
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
} from "./ids";
import { definePlugin } from "./plugin";
import { resetSubjectTouchCache, touchSubject } from "./subject-registry";

// The platform view: `executor.admin`, an OPT-IN read-only surface that reads
// across every subject in the tenant. Written against the real SQLite bring-up
// so the tenant-reach policy, the bigint `last_seen_at` round-trip, and the
// field allowlist are all live.

const TENANT = "t1";
const OTHER_TENANT = "t2";
const SUBJECT_A = "user_a";
const SUBJECT_B = "user_b";

/** Every column on `connection` that could resolve, or help resolve, a
 *  credential. NONE of these may appear on an admin shape — enumerated so a
 *  future column addition has to be argued with this list. */
const FORBIDDEN_CONNECTION_FIELDS = [
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
] as const;

/**
 * The upstream-derived halves of a stored health verdict: the account identity
 * extracted from the configured `identityField` (typically the user's email AT
 * the provider), a raw diagnostic that can quote an upstream error body, and a
 * bounded sample of the real response body.
 *
 * These are NOT on the list above, and that is deliberate rather than an
 * oversight. This layer is the in-process platform view, not a wire shape:
 * `AdminConnection.lastHealth` is the full `HealthCheckResult`, and the
 * narrowing to status + checkedAt happens where the response is BUILT, in
 * `@executor-js/api`'s `admin/reads.ts` → `AdminConnectionHealth`. Listing them
 * as forbidden top-level connection keys would pass without testing anything,
 * because they never were top-level keys — they live nested inside
 * `lastHealth`. That vacuous-green assertion is precisely the failure mode this
 * comment exists to prevent.
 *
 * So the assertion below pins the SEAM instead: this layer DOES carry them, and
 * anyone who "fixes" the leak here rather than at the projection has moved the
 * boundary. The absence assertions live in `packages/core/api`'s
 * `admin-users.test.ts`, against real HTTP responses.
 */
const UPSTREAM_HEALTH_FIELDS = ["identity", "detail", "responseSample"] as const;

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
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
        // leave the storage layer.
        JSON.stringify({ token: `SECRET-item-${row.rowId}` }),
        `SECRET-refresh-${row.rowId}`,
        row.oauthScope ?? null,
        // A full stored verdict, upstream-derived fields included — that is
        // what a real health check writes. This layer is entitled to read them
        // back (see UPSTREAM_HEALTH_FIELDS); the API's projection is what keeps
        // them off the wire.
        JSON.stringify({
          status: "healthy",
          checkedAt: 1_700_000_000_000,
          identity: `UPSTREAM-identity-${row.rowId}@provider.test`,
          detail: `UPSTREAM-detail-${row.rowId}`,
          responseSample: [{ path: "user.email", value: `UPSTREAM-sample-${row.rowId}` }],
        }),
        Date.now(),
        Date.now(),
      ],
    });
  });

/** A tenant-scoped `integration` row, inserted raw. Needed because
 *  `integrations.remove` short-circuits on an absent slug — without a real row
 *  the call returns success having touched no storage, which would make a
 *  read-only assertion vacuous. */
const insertIntegration = (db: SqliteTestFumaDb, slug: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await db.client.execute({
      sql: `INSERT INTO integration (
          row_id, tenant, slug, plugin_id, name, description, config, can_remove,
          can_refresh, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `i-${slug}`,
        TENANT,
        slug,
        "demo",
        slug,
        null,
        JSON.stringify({}),
        1,
        0,
        Date.now(),
        Date.now(),
      ],
    });
  });

/** Seed two users and an org connection under `t1`, plus an untouchable other
 *  tenant. Subjects go in through `touchSubject` (the only legitimate writer);
 *  connections go in raw, because no single bound executor could have written
 *  another subject's rows. */
const seed = (db: SqliteTestFumaDb): Effect.Effect<void> =>
  Effect.gen(function* () {
    // `touchSubject` keeps a process-local memory of principals it already
    // filed, so a second seed against a FRESH database would be skipped as a
    // repeat sighting and leave the table empty. Each seed is a new world.
    resetSubjectTouchCache();

    yield* touchSubject(db.db, { tenant: TENANT, externalId: SUBJECT_A });
    yield* touchSubject(db.db, { tenant: TENANT, externalId: SUBJECT_B });
    yield* touchSubject(db.db, { tenant: OTHER_TENANT, externalId: "user_elsewhere" });

    yield* insertConnection(db, {
      rowId: "c-a1",
      tenant: TENANT,
      owner: "user",
      subject: SUBJECT_A,
      integration: "github",
      name: "personal",
      oauthScope: "repo read:user",
    });
    yield* insertConnection(db, {
      rowId: "c-a2",
      tenant: TENANT,
      owner: "user",
      subject: SUBJECT_A,
      integration: "linear",
      name: "work",
    });
    yield* insertConnection(db, {
      rowId: "c-b1",
      tenant: TENANT,
      owner: "user",
      subject: SUBJECT_B,
      integration: "github",
      name: "b-personal",
      oauthScope: "repo",
    });
    yield* insertConnection(db, {
      rowId: "c-org",
      tenant: TENANT,
      owner: "org",
      subject: "",
      integration: "stripe",
      name: "shared",
    });
    yield* insertConnection(db, {
      rowId: "c-other",
      tenant: OTHER_TENANT,
      owner: "user",
      subject: SUBJECT_A,
      integration: "github",
      name: "other-tenant",
    });
  });

/**
 * A plugin contributing one writable credential provider.
 *
 * `oauth.createClient` stores the client secret out-of-band and fails BEFORE
 * touching storage when no writable provider is registered. Without this, the
 * read-only assertion below would pass on the wrong error and prove nothing —
 * so the provider is here to make the write actually reach the owner policy.
 */
const providerPlugin = definePlugin(() => {
  const store = new Map<string, string>();
  return {
    id: "memory-provider" as const,
    storage: () => ({}),
    credentialProviders: [
      {
        key: ProviderKey.make("memory"),
        writable: true,
        get: (id: ProviderItemId) => Effect.sync(() => store.get(String(id)) ?? null),
        set: (id: ProviderItemId, value: string) =>
          Effect.sync(() => void store.set(String(id), value)),
        delete: (id: ProviderItemId) => Effect.sync(() => void store.delete(String(id))),
      },
    ],
  };
})();

const makePlatformExecutor = (
  db: SqliteTestFumaDb,
  options?: { readonly platformView?: boolean; readonly subject?: string | null },
): Effect.Effect<Executor, never> =>
  createExecutor({
    tenant: Tenant.make(TENANT),
    ...(options?.subject === null ? {} : { subject: Subject.make(options?.subject ?? SUBJECT_A) }),
    db: db.db,
    plugins: [providerPlugin],
    onElicitation: "accept-all",
    ...(options?.platformView === false ? {} : { platformView: true }),
  }).pipe(Effect.orDie);

const requireAdmin = (executor: Executor) => {
  const admin = executor.admin;
  if (!admin) return Effect.die("expected the platform view to be enabled");
  return Effect.succeed(admin);
};

describe("platform view — admin.listSubjects", () => {
  it.effect("lists every subject in the tenant and no other tenant's", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const subjects = yield* admin.listSubjects();

        // `user_elsewhere` lives under t2 — invisible at any reach.
        expect(subjects.map((entry) => entry.externalId).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
      }),
    ),
  );

  it.effect("returns created_at and the bigint last_seen_at through the ORM", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const before = Date.now();
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const subjects = yield* admin.listSubjects();
        const entry = subjects.find((row) => row.externalId === SUBJECT_A);

        expect(entry?.createdAt).toBeInstanceOf(Date);
        // A raw SQL read would hand back an unusable blob here.
        expect(typeof entry?.lastSeenAt).toBe("number");
        expect(entry?.lastSeenAt ?? 0).toBeGreaterThanOrEqual(before);
        expect(entry?.status).toBeNull();
      }),
    ),
  );

  it.effect("pages with a stable order", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const all = yield* admin.listSubjects();
        const first = yield* admin.listSubjects({ limit: 1 });
        const second = yield* admin.listSubjects({ limit: 1, offset: 1 });

        expect(all).toHaveLength(2);
        expect(first.map((entry) => entry.externalId)).toEqual([all[0]?.externalId]);
        expect(second.map((entry) => entry.externalId)).toEqual([all[1]?.externalId]);
      }),
    ),
  );

  // Drizzle's SQLite dialect emits OFFSET only alongside LIMIT, and SQLite
  // rejects a bare OFFSET — so forwarding the two independently made
  // `{ offset }` a SQL syntax error on every SQLite host. The default limit is
  // what makes an offset-only page a legal query at all.
  it.effect("accepts an offset with no limit", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        const all = yield* admin.listSubjects();
        const skipped = yield* admin.listSubjects({ offset: 1 });

        expect(skipped.map((entry) => entry.externalId)).toEqual([all[1]?.externalId]);
        // Past the end is an empty page, not an error.
        expect(yield* admin.listSubjects({ offset: 50 })).toEqual([]);
        expect(yield* admin.listSubjectsWithConnections({ offset: 1 })).toHaveLength(1);
      }),
    ),
  );

  // A fraction is a 400 at the HTTP contract, but the SDK is a public entry
  // point of its own: a fractional limit reaching the driver is a `datatype
  // mismatch` failure, so it is floored here rather than forwarded.
  it.effect("floors a fractional limit and offset instead of failing the query", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        const all = yield* admin.listSubjects();

        expect(yield* admin.listSubjects({ limit: 1.5 })).toEqual([all[0]]);
        expect(yield* admin.listSubjects({ offset: 1.9 })).toEqual([all[1]]);
      }),
    ),
  );

  // The no-args call is the one an API consumer writes by default, and
  // `listSubjectsWithConnections` turns each returned row into its own
  // sequential connection query. Unbounded, that is the whole tenant inside one
  // request.
  it.effect("bounds an unpaged call to the default page size, and clamps past the maximum", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // One more subject than a default page holds, so "no arguments" and
        // "everything" are distinguishable.
        for (let index = 0; index < ADMIN_DEFAULT_PAGE_SIZE + 5; index += 1) {
          yield* touchSubject(db.db, {
            tenant: TENANT,
            // Zero-padded: `external_id` breaks `created_at` ties, and these
            // rows are written inside the same millisecond.
            externalId: `user_${String(index).padStart(4, "0")}`,
          });
        }

        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        expect(yield* admin.listSubjects()).toHaveLength(ADMIN_DEFAULT_PAGE_SIZE);
        expect(yield* admin.listSubjectsWithConnections()).toHaveLength(ADMIN_DEFAULT_PAGE_SIZE);
        // A caller may ask for more, up to the ceiling — and no further.
        expect(yield* admin.listSubjects({ limit: ADMIN_MAX_PAGE_SIZE * 10 })).toHaveLength(
          ADMIN_DEFAULT_PAGE_SIZE + 5,
        );
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// The platform view is read-only across EVERY surface, not just `admin`.
//
// A platform executor is subject-less but still bound to the tenant's ORG
// partition, so before `writes: "denied"` its ordinary product surfaces formed
// an unguarded pure-org executor: it could create, update and delete every
// `owner: "org"` row in the tenant through `connections`, `policies`,
// `integrations` and `oauth`, while only the `admin` handle was actually
// guarded. These pin that the guarantee now covers the whole executor.
// ---------------------------------------------------------------------------

/**
 * The owner policy refuses a write by failing the storage effect. `Effect.flip`
 * makes a SUCCEEDING write a test failure outright rather than something to
 * assert on afterwards.
 *
 * The message is checked too, not just the failure: several of these surfaces
 * can fail for unrelated reasons BEFORE reaching storage (an absent row, a
 * missing credential provider), and such a failure would let the assertion pass
 * without the policy ever having been consulted.
 */
const expectWriteRefused = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E | StorageError>,
) =>
  // The surfaces under test fail with different unions (StorageFailure,
  // ConnectionNotFoundError, …). The refusal this pins is always a
  // StorageError, so the effect is widened for the catch; `orDie` below still
  // turns every OTHER tag into a test failure, and a write that SUCCEEDS dies
  // rather than reaching an assertion — so the hole can never pass silently.
  (effect as Effect.Effect<A, StorageError>).pipe(
    Effect.flatMap(() => Effect.die("expected the platform view to refuse this write")),
    Effect.catchTag("StorageError", (error: StorageError) => {
      expect(error.message).toContain("read-only");
      return Effect.void;
    }),
    Effect.orDie,
  );

describe("platform view — read-only across every surface", () => {
  it.effect("refuses org-row writes through policies and oauth", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db, { subject: null });

        yield* expectWriteRefused(
          executor.policies.create({ owner: "org", pattern: "tools.*", action: "block" }),
        );
        yield* expectWriteRefused(
          executor.oauth.createClient({
            owner: "org",
            slug: OAuthClientSlug.make("intruder"),
            authorizationUrl: "https://acme.test/authorize",
            tokenUrl: "https://acme.test/token",
            grant: "authorization_code",
            clientId: "intruder-id",
            clientSecret: "intruder-secret",
          }),
        );

        // Nothing landed.
        expect(yield* executor.policies.list()).toEqual([]);
        expect(yield* executor.oauth.listClients()).toEqual([]);
      }),
    ),
  );

  // A DELETE is the sharpest case: it carries no values to check against, so
  // the reach/writes guard is the only thing between this executor and the
  // tenant's org rows.
  it.effect("refuses to delete the tenant's org rows", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // A real `integration` row: `integrations.remove` returns success
        // without touching storage when the slug is absent, so asserting
        // against a missing row would prove nothing.
        yield* insertIntegration(db, "stripe");
        const executor = yield* makePlatformExecutor(db, { subject: null });

        yield* expectWriteRefused(
          executor.connections.remove({
            owner: "org",
            integration: IntegrationSlug.make("stripe"),
            name: ConnectionName.make("shared"),
          }),
        );
        yield* expectWriteRefused(
          executor.oauth.removeClient("org", OAuthClientSlug.make("anything")),
        );
        yield* expectWriteRefused(executor.integrations.remove(IntegrationSlug.make("stripe")));

        // Every row survived.
        const admin = yield* requireAdmin(executor);
        expect(yield* admin.listSubjects()).toHaveLength(2);
        const connections = yield* Effect.promise(() =>
          db.client.execute({ sql: `SELECT name FROM connection WHERE owner = 'org'`, args: [] }),
        );
        expect(connections.rows).toHaveLength(1);
        const integrations = yield* Effect.promise(() =>
          db.client.execute({ sql: `SELECT slug FROM integration`, args: [] }),
        );
        expect(integrations.rows).toHaveLength(1);
      }),
    ),
  );

  // Read-only is the WRITE axis only. The ordinary surfaces keep BOUND reach on
  // purpose: widening them would hand every subject's connection row —
  // credential item ids included — to a surface that only ever needed the admin
  // projection.
  it.effect("does not widen the ordinary surfaces' reads to other subjects", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db, { subject: null });

        const connections = yield* executor.connections.list().pipe(Effect.orDie);

        // Only the tenant's org row: A's and B's user connections stay invisible
        // to this surface, even though `admin` can see both.
        expect(connections.map((entry) => entry.name)).toEqual(["shared"]);
      }),
    ),
  );

  // The guarantee must be exactly as narrow as advertised: an executor WITHOUT
  // the opt-in is a normal product executor and writes normally. A read-only
  // default would be a silent behavior change for every existing host.
  it.effect("leaves an ordinary product executor fully writable", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        yield* insertIntegration(db, "stripe");
        const executor = yield* makePlatformExecutor(db, {
          platformView: false,
          subject: SUBJECT_A,
        });

        const policy = yield* executor.policies
          .create({ owner: "org", pattern: "tools.*", action: "block" })
          .pipe(Effect.orDie);
        expect(policy.pattern).toBe("tools.*");

        yield* executor.oauth
          .createClient({
            owner: "org",
            slug: OAuthClientSlug.make("legit"),
            authorizationUrl: "https://acme.test/authorize",
            tokenUrl: "https://acme.test/token",
            grant: "authorization_code",
            clientId: "legit-id",
            clientSecret: "legit-secret",
          })
          .pipe(Effect.orDie);
        expect(yield* executor.policies.list().pipe(Effect.orDie)).toHaveLength(1);
        expect(yield* executor.oauth.listClients().pipe(Effect.orDie)).toHaveLength(1);

        yield* executor.connections
          .remove({
            owner: "org",
            integration: IntegrationSlug.make("stripe"),
            name: ConnectionName.make("shared"),
          })
          .pipe(Effect.orDie);
        yield* executor.integrations.remove(IntegrationSlug.make("stripe")).pipe(Effect.orDie);

        const connections = yield* Effect.promise(() =>
          db.client.execute({ sql: `SELECT name FROM connection WHERE owner = 'org'`, args: [] }),
        );
        expect(connections.rows).toHaveLength(0);
        const integrations = yield* Effect.promise(() =>
          db.client.execute({ sql: `SELECT slug FROM integration`, args: [] }),
        );
        expect(integrations.rows).toHaveLength(0);
      }),
    ),
  );
});

describe("platform view — admin.listSubjectConnections", () => {
  it.effect("lists another subject's connections across the tenant", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // Bound to A; reading B is exactly what the product view cannot do.
        const executor = yield* makePlatformExecutor(db, { subject: SUBJECT_A });
        const admin = yield* requireAdmin(executor);

        const connections = yield* admin.listSubjectConnections(SUBJECT_B);

        expect(connections.map((entry) => entry.name)).toEqual(["b-personal"]);
        expect(connections[0]?.integration).toBe("github");
        expect(connections[0]?.owner).toBe("user");
        expect(connections[0]?.subject).toBe(SUBJECT_B);
        expect(connections[0]?.oauthScope).toBe("repo");
        expect(connections[0]?.lastHealth?.status).toBe("healthy");
      }),
    ),
  );

  it.effect("does not attribute org-owned connections to a user", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const forA = yield* admin.listSubjectConnections(SUBJECT_A);

        // The org's `stripe/shared` belongs to the tenant, not to A.
        expect(forA.map((entry) => entry.integration).sort()).toEqual(["github", "linear"]);
        expect(forA.every((entry) => entry.owner === "user")).toBe(true);
      }),
    ),
  );

  it.effect("never returns credential-bearing fields", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const connections = yield* admin.listSubjectConnections(SUBJECT_A);
        expect(connections.length).toBeGreaterThan(0);

        for (const connection of connections) {
          const keys = Object.keys(connection);
          for (const forbidden of FORBIDDEN_CONNECTION_FIELDS) {
            expect(keys).not.toContain(forbidden);
          }
          // Belt and braces: no seeded secret value appears anywhere in the
          // serialized shape, whatever it is keyed under.
          expect(JSON.stringify(connection)).not.toContain("SECRET-");
        }

        // The SEAM, pinned. This layer carries the whole stored verdict —
        // upstream account content and all — because it is in-process and the
        // caller is the platform itself. The narrowing to status + checkedAt is
        // `@executor-js/api`'s `AdminConnectionHealth`, applied where the
        // RESPONSE is built. If this assertion ever fails because the fields
        // stopped arriving here, the projection in `admin/reads.ts` is no
        // longer the thing holding the line and the API's own absence tests
        // have quietly become vacuous.
        const health = connections[0]?.lastHealth;
        for (const field of UPSTREAM_HEALTH_FIELDS) {
          expect(
            Object.keys(health ?? {}),
            `the platform view still carries "${field}"; the API projection is the boundary`,
          ).toContain(field);
        }
      }),
    ),
  );
});

describe("platform view — admin.listSubjectsWithConnections", () => {
  it.effect("joins each subject to its own connections", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();
        const byId = new Map(rows.map((row) => [row.externalId, row]));

        expect(rows.map((row) => row.externalId).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
        expect(
          byId
            .get(SUBJECT_A)
            ?.connections.map((c) => c.name)
            .sort(),
        ).toEqual(["personal", "work"]);
        expect(byId.get(SUBJECT_B)?.connections.map((c) => c.name)).toEqual(["b-personal"]);
      }),
    ),
  );

  it.effect("never returns credential-bearing fields", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();

        for (const row of rows) {
          for (const connection of row.connections) {
            const keys = Object.keys(connection);
            for (const forbidden of FORBIDDEN_CONNECTION_FIELDS) {
              expect(keys).not.toContain(forbidden);
            }
          }
        }
        expect(JSON.stringify(rows)).not.toContain("SECRET-");
      }),
    ),
  );

  it.effect("works for a pure-org executor with no bound subject", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // The shape an org-level API key produces: platform view on, no
        // subject bound at all.
        const executor = yield* makePlatformExecutor(db, { subject: null });
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();

        expect(rows.map((row) => row.externalId).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
        expect(rows.flatMap((row) => row.connections)).toHaveLength(3);
      }),
    ),
  );
});

describe("platform view — admin.getSubject", () => {
  it.effect("reads one subject by external_id", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        const subject = yield* admin.getSubject(SUBJECT_B);

        expect(subject?.externalId).toBe(SUBJECT_B);
        // The same field discipline as the list: a keyed read is not a
        // different projection.
        expect(Object.keys(subject!).sort()).toEqual([
          "createdAt",
          "externalId",
          "lastSeenAt",
          "status",
        ]);
      }),
    ),
  );

  it.effect("returns null for an unknown id and for another tenant's subject", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        expect(yield* admin.getSubject("user_nobody")).toBeNull();
        // `user_elsewhere` exists — under t2. The tenant policy filters the
        // keyed read exactly as it filters the list.
        expect(yield* admin.getSubject("user_elsewhere")).toBeNull();
      }),
    ),
  );

  it.effect("joins connections in one call, and issues none for an absent subject", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        const joined = yield* admin.getSubjectWithConnections(SUBJECT_A);
        expect(joined?.externalId).toBe(SUBJECT_A);
        expect(joined?.connections.map((entry) => entry.integration).sort()).toEqual([
          "github",
          "linear",
        ]);
        // Org-owned rows belong to the tenant, not to any user, so the
        // keyed join excludes them exactly as the list join does.
        expect(joined?.connections.every((entry) => entry.owner === "user")).toBe(true);

        expect(yield* admin.getSubjectWithConnections("user_nobody")).toBeNull();
      }),
    ),
  );

  it.effect("never returns credential-bearing fields on the keyed join", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const admin = yield* requireAdmin(yield* makePlatformExecutor(db));

        const joined = yield* admin.getSubjectWithConnections(SUBJECT_A);

        for (const connection of joined!.connections) {
          const keys = Object.keys(connection);
          for (const forbidden of FORBIDDEN_CONNECTION_FIELDS) {
            expect(keys).not.toContain(forbidden);
          }
        }
        expect(JSON.stringify(joined)).not.toContain("SECRET-");
      }),
    ),
  );
});

describe("platform view — default off", () => {
  it.effect("an executor without the opt-in has no admin surface", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db, { platformView: false });

        expect(executor.admin).toBeUndefined();
      }),
    ),
  );

  it.effect("the product view still reads only the bound subject when the opt-in is on", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // Enabling the platform view must not widen ANY existing surface.
        const executor = yield* makePlatformExecutor(db, { subject: SUBJECT_A });

        const connections = yield* executor.connections.list().pipe(Effect.orDie);

        expect(connections.map((entry) => entry.name).sort()).toEqual([
          "personal",
          "shared",
          "work",
        ]);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// The joined read is BATCHED: two queries, not one per subject.
// ---------------------------------------------------------------------------

const SUBJECT_C = "user_c";

/** Count the SELECTs against `connection` a body issues. The joined read used
 *  to fan out one per subject in the page; the count is the regression guard,
 *  since the returned rows look identical either way. */
const countingConnectionReads = (db: SqliteTestFumaDb) => {
  const client = db.client;
  const execute = client.execute.bind(client);
  let reads = 0;
  client.execute = (statement: InStatement) => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    if (/^\s*select/i.test(sql) && /\bconnection\b/i.test(sql)) reads += 1;
    return execute(statement);
  };
  return () => reads;
};

describe("platform view — the joined read does not fan out per subject", () => {
  it.effect("reads every subject's connections in ONE query", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // A third principal, so a per-subject fan-out would be visibly >1.
        yield* touchSubject(db.db, { tenant: TENANT, externalId: SUBJECT_C });
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const connectionReads = countingConnectionReads(db);
        const rows = yield* admin.listSubjectsWithConnections();

        expect(rows).toHaveLength(3);
        expect(connectionReads()).toBe(1);
      }),
    ),
  );

  it.effect("keeps a subject with no connections in the page, with an empty array", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        yield* touchSubject(db.db, { tenant: TENANT, externalId: SUBJECT_C });
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();
        const byId = new Map(rows.map((row) => [row.externalId, row]));

        expect(byId.get(SUBJECT_C)?.connections).toEqual([]);
        // The rows that DO have connections are unchanged by the batching.
        expect(
          byId
            .get(SUBJECT_A)
            ?.connections.map((c) => c.name)
            .sort(),
        ).toEqual(["personal", "work"]);
        expect(byId.get(SUBJECT_B)?.connections.map((c) => c.name)).toEqual(["b-personal"]);
      }),
    ),
  );

  it.effect("keeps the batched read inside the tenant, and off org-owned rows", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // The seed holds both traps: SUBJECT_A also owns a connection in
        // OTHER_TENANT, and this tenant has an org-owned row whose `subject`
        // is the empty-string sentinel. Widening one per-subject `=` into a
        // single `in` must reach neither.
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();
        const names = rows.flatMap((row) => row.connections).map((c) => c.name);

        expect(names).not.toContain("other-tenant");
        expect(names).not.toContain("shared");
        expect(names.sort()).toEqual(["b-personal", "personal", "work"]);
      }),
    ),
  );
});
