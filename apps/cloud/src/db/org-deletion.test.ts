// ---------------------------------------------------------------------------
// purgeOrganizationData — org deletion cascade
// ---------------------------------------------------------------------------
//
// Runs inside the Cloudflare Workers runtime against a real PGlite Postgres
// (scripts/test-globalsetup.ts), the same path api.ts uses per request. Seeds
// two orgs across every tenant table + blob namespace, purges one, and asserts:
//   - every executor tenant table row for the target org is gone
//   - org- and user-scoped secret blobs for the target org are gone
//   - the identity row is gone and its memberships cascade with it
//   - a second org's data is completely untouched
//   - the blob prefix match escapes LIKE wildcards (a `_` in the org id must
//     not widen the match to a look-alike namespace)
//
// Plus a SCHEMA-DRIFT guard (see "purge coverage" below): the purge list is
// hand-written, so a table added to the schema without being added to it would
// leave that org's rows behind forever, silently. The guard derives the set of
// org-owned tables from the schema itself rather than restating it.

import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { eq, getTableColumns, getTableName, inArray } from "drizzle-orm";

import { DbService } from "./db";
import type { DrizzleDb } from "./db";
import { makeUserStore } from "../auth/user-store";
import * as cloudSchema from "./schema";
import * as executorSchema from "./executor-schema";
import { memberships, accounts } from "./schema";
import {
  access_group,
  access_group_member,
  artifact,
  blob,
  connection,
  definition,
  integration,
  oauth_client,
  oauth_session,
  plugin_storage,
  subject,
  tool,
  tool_policy,
} from "./executor-schema";

const program = <A, E>(body: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(DbService.Live), Effect.scoped) as Effect.Effect<A, E, never>,
  );

// Insert one row into every tenant table, plus an org- and a user-scoped blob,
// all owned by `tenant`. `tag` keeps unique indexes from colliding across orgs.
const seedTenant = async (db: DrizzleDb, tenant: string, tag: string) => {
  const now = new Date();
  await db.insert(integration).values({
    slug: `int-${tag}`,
    plugin_id: "p",
    created_at: now,
    updated_at: now,
    tenant,
  });
  await db.insert(connection).values({
    integration: "int",
    name: `conn-${tag}`,
    template: "t",
    provider: "pr",
    item_ids: [],
    created_at: now,
    updated_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });
  await db.insert(oauth_client).values({
    slug: `oc-${tag}`,
    authorization_url: "u",
    token_url: "u",
    grant: "g",
    client_id: "c",
    created_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });
  await db.insert(oauth_session).values({
    state: `state-${tag}`,
    client_slug: "cs",
    integration: "int",
    name: "n",
    template: "t",
    redirect_url: "r",
    payload: {},
    expires_at: 0n,
    created_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });
  await db.insert(tool).values({
    integration: "int",
    connection: "conn",
    plugin_id: "p",
    name: `tool-${tag}`,
    description: "d",
    created_at: now,
    updated_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });
  await db.insert(definition).values({
    integration: "int",
    connection: "conn",
    plugin_id: "p",
    name: `def-${tag}`,
    schema: {},
    created_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });
  await db.insert(tool_policy).values({
    id: `tp-${tag}`,
    pattern: "*",
    action: "allow",
    position: "1",
    created_at: now,
    updated_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });
  await db.insert(plugin_storage).values({
    plugin_id: "p",
    collection: "col",
    key: `k-${tag}`,
    data: {},
    created_at: now,
    updated_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });

  await db.insert(subject).values({
    external_id: `acct-${tag}`,
    created_at: now,
    last_seen_at: BigInt(now.getTime()),
    tenant,
  });

  await db.insert(artifact).values({
    id: `art-${tag}`,
    title: "Dashboard",
    code: "export default function App() { return null; }",
    created_at: now,
    updated_at: now,
    tenant,
    owner: "o",
    subject: "s",
  });

  await db.insert(access_group).values({
    id: `grp-${tag}`,
    name: "finance",
    created_at: now,
    updated_at: now,
    tenant,
  });
  await db.insert(access_group_member).values({
    group_id: `grp-${tag}`,
    subject: "s",
    created_at: now,
    tenant,
  });

  const orgNs = `o:${tenant}/plugin`;
  const userNs = `u:${tenant}:subject/plugin`;
  await db.insert(blob).values({
    namespace: orgNs,
    key: "k",
    value: "v",
    id: JSON.stringify([orgNs, "k"]),
  });
  await db.insert(blob).values({
    namespace: userNs,
    key: "k",
    value: "v",
    id: JSON.stringify([userNs, "k"]),
  });
};

const TENANT_TABLES = [
  integration,
  connection,
  oauth_client,
  oauth_session,
  tool,
  definition,
  tool_policy,
  plugin_storage,
  subject,
  artifact,
  access_group,
  access_group_member,
] as const;

// Tables that are NOT purged by org id, each with the reason it is exempt. Any
// schema table not carrying a `tenant` column must be listed here — that is
// what makes the drift guard below total rather than a spot check.
const NOT_ORG_OWNED: Record<string, string> = {
  // Purged, but by NAMESPACE PREFIX (`o:<org>/…` / `u:<org>:…`) rather than a
  // tenant column, so it cannot be checked by the column rule.
  blob: "org-scoped by namespace prefix, purged via the LIKE match",
  // Instance-wide, not owned by any org.
  private_executor_cloud_settings: "singleton instance settings, not org-scoped",
  // Identity mirror. `organizations` is deleted directly and `memberships`
  // cascades from its FK; `accounts` deliberately outlives the org.
  organizations: "the identity row itself, deleted directly",
  memberships: "cascades from the organizations FK",
  accounts: "shared across orgs — deliberately survives",
};

const countTenantRows = async (db: DrizzleDb, tenant: string): Promise<number> => {
  let total = 0;
  for (const table of TENANT_TABLES) {
    const rows = await db.select().from(table).where(eq(table.tenant, tenant));
    total += rows.length;
  }
  // Count by the exact namespaces `seedTenant` inserts. Matching on a `%tenant%`
  // LIKE here would reintroduce the very wildcard hazard under test.
  const blobs = await db
    .select()
    .from(blob)
    .where(inArray(blob.namespace, [`o:${tenant}/plugin`, `u:${tenant}:subject/plugin`]));
  return total + blobs.length;
};

describe("purgeOrganizationData", () => {
  it("removes all of one org's data and leaves other orgs untouched", async () => {
    // Underscore in the id is deliberate: an unescaped `_` in a LIKE pattern is
    // a single-char wildcard, so the escaping has to hold for this to be safe.
    const orgA = `org_del_${crypto.randomUUID().slice(0, 8)}`;
    const orgB = `org_keep_${crypto.randomUUID().slice(0, 8)}`;
    const accountId = `user_${crypto.randomUUID().slice(0, 8)}`;

    // A look-alike blob that only an UNescaped `_` wildcard would match:
    // `o:<orgA>/…` with the underscore replaced by another char.
    const trapNs = `o:${orgA.replace("_", "X")}/plugin`;

    await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(async () => {
          const store = makeUserStore(db);
          await store.upsertOrganization({ id: orgA, name: "Delete Me" });
          await store.upsertOrganization({ id: orgB, name: "Keep Me" });
          await store.ensureAccount(accountId);
          await db.insert(memberships).values({ accountId, organizationId: orgA });
          await db.insert(memberships).values({ accountId, organizationId: orgB });
          await seedTenant(db, orgA, "a");
          await seedTenant(db, orgB, "b");
          await db.insert(blob).values({
            namespace: trapNs,
            key: "k",
            value: "v",
            id: JSON.stringify([trapNs, "k"]),
          });
        });
      }),
    );

    await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() => makeUserStore(db).deleteOrganizationCascade(orgA));
      }),
    );

    await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(async () => {
          const store = makeUserStore(db);

          // Target org: every tenant row + blob gone, identity gone, membership
          // cascaded, but the shared account survives (it may join other orgs).
          expect(await countTenantRows(db, orgA)).toBe(0);
          expect(await store.getOrganization(orgA)).toBeNull();
          const orgAMemberships = await db
            .select()
            .from(memberships)
            .where(eq(memberships.organizationId, orgA));
          expect(orgAMemberships).toHaveLength(0);
          const account = await db.select().from(accounts).where(eq(accounts.id, accountId));
          expect(account, "the account outlives the org").toHaveLength(1);

          // The look-alike blob must survive: escaping keeps `_` literal.
          const trap = await db.select().from(blob).where(eq(blob.namespace, trapNs));
          expect(trap, "escaped LIKE must not match a look-alike namespace").toHaveLength(1);

          // Second org: fully intact.
          expect(await countTenantRows(db, orgB)).toBeGreaterThan(0);
          expect(await store.getOrganization(orgB)).not.toBeNull();
          const orgBMemberships = await db
            .select()
            .from(memberships)
            .where(eq(memberships.organizationId, orgB));
          expect(orgBMemberships).toHaveLength(1);
        });
      }),
    );
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Purge coverage vs the schema
// ---------------------------------------------------------------------------
//
// The purge list in `org-deletion.ts` is hand-written, one `tx.delete(...)` per
// table. Adding a tenant table to the schema and forgetting that line leaves
// every deleted org's rows in it forever — no error, no failing test, and the
// data is exactly what a deletion was supposed to remove.
//
// So the expected set is DERIVED: a `tenant` column is what makes a table
// org-owned, and every table without one must be named in `NOT_ORG_OWNED` with
// its reason. A new table lands in one of the two buckets automatically, and
// both buckets fail loudly until it is handled.
describe("purge coverage", () => {
  // Every drizzle table the cloud DB is built from (the same two modules
  // `combinedSchema` spreads), by table name.
  const allTables = Object.values({ ...cloudSchema, ...executorSchema });

  const orgOwnedTables = allTables.filter((table) => "tenant" in getTableColumns(table));
  const orgOwnedNames = orgOwnedTables.map(getTableName).sort();
  const seededNames = TENANT_TABLES.map(getTableName).sort();

  it("classifies every schema table as org-owned or explicitly exempt", () => {
    const unclassified = allTables
      .map(getTableName)
      .filter((name) => !orgOwnedNames.includes(name) && !(name in NOT_ORG_OWNED));
    expect(
      unclassified,
      "a new table must either carry `tenant` (and be purged) or be listed in NOT_ORG_OWNED with a reason",
    ).toEqual([]);
  });

  it("purges every org-owned table in the schema", () => {
    // `TENANT_TABLES` is what this suite seeds and then asserts is empty after
    // the purge, so keeping it equal to the schema-derived set is what makes
    // the cascade test above cover the WHOLE schema rather than a snapshot of
    // it. A tenant table added tomorrow fails here first — the fix is to seed
    // it, which then fails the cascade test until `purgeOrganizationData`
    // deletes it too.
    expect(seededNames, "every org-owned table is seeded and checked by the cascade test").toEqual(
      orgOwnedNames,
    );
  });

  it("seeds a row in every org-owned table, so the cascade assertions are not vacuous", async () => {
    // Guards the other half: a table listed in TENANT_TABLES but never seeded
    // would count zero rows before AND after the purge, passing while proving
    // nothing. Assert the seed actually populates each one.
    const tenant = `org_seed_${crypto.randomUUID().slice(0, 8)}`;
    const empty = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        return yield* Effect.promise(async () => {
          await seedTenant(db, tenant, `seed${crypto.randomUUID().slice(0, 6)}`);
          const missing: Array<string> = [];
          for (const table of TENANT_TABLES) {
            const rows = await db.select().from(table).where(eq(table.tenant, tenant));
            if (rows.length === 0) missing.push(getTableName(table));
          }
          return missing;
        });
      }),
    );
    expect(empty, "seedTenant must insert a row into every table the cascade checks").toEqual([]);
  }, 20_000);
});
