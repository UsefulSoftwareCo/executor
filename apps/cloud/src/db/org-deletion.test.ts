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

import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { eq, inArray } from "drizzle-orm";

import { DbService } from "./db";
import type { DrizzleDb } from "./db";
import { makeUserStore } from "../auth/user-store";
import { memberships, accounts } from "./schema";
import {
  blob,
  connection,
  definition,
  integration,
  oauth_client,
  oauth_session,
  plugin_storage,
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
] as const;

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
