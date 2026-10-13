// ---------------------------------------------------------------------------
// The moved-to-v2 flag and the toolkit slug lookup, against the real PGlite
// Postgres every cloud unit test runs on (scripts/test-globalsetup.ts).
//
// What this pins:
//   - only a `moved` row that names its v2 organization forwards; no row,
//     `moving`, or `moved` without a v2 organization all read as not moved
//   - the table rejects any other state
//   - a toolkit slug resolves to the row the v1 session would pick: the
//     org's toolkit wins over the caller's own, another user's personal
//     toolkit and another org's are invisible, and an unknown slug is null
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { UserStoreService, makeUserStoreLayer } from "../auth/context";
import { DbService, makeDbLayer } from "../db/db";
import { orgMovedToV2 } from "../db/schema";
import { PluginsProvider, makeScopedExecutor } from "@executor-js/api/server";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

import { CloudDbProvider, CloudHostConfig } from "../engine/execution-stack";
import { readMovedToV2 } from "./moved-to-v2";
import { resolveToolkitRowId } from "./toolkit-lookup";

const toolkitsOnly = Layer.succeed(PluginsProvider)({ plugins: () => [toolkitsPlugin()] });

const dbLayer = makeDbLayer();
const layer = Layer.mergeAll(dbLayer, makeUserStoreLayer().pipe(Layer.provide(dbLayer)));

const run = <A, E>(effect: Effect.Effect<A, E, DbService | UserStoreService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));

const freshOrg = () =>
  Effect.gen(function* () {
    const id = `org_${crypto.randomUUID().replaceAll("-", "")}`;
    const store = yield* UserStoreService;
    yield* store.use("upsertOrganization", (s) =>
      s.upsertOrganization({ id, name: "Moved Org", updatedAt: new Date() }),
    );
    return id;
  });

const setState = (orgId: string, state: string, v2OrgId: string | null) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    yield* Effect.promise(() => db.insert(orgMovedToV2).values({ orgId, state, v2OrgId }));
  });

const movedToV2 = readMovedToV2;

describe("moved-to-v2 flag", () => {
  it("reads only a moved row with a v2 organization as moved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const none = yield* freshOrg();
        const moving = yield* freshOrg();
        const movingNoOrg = yield* freshOrg();
        const movedNoOrg = yield* freshOrg();
        const moved = yield* freshOrg();
        yield* setState(moving, "moving", "v2-org-moving");
        yield* setState(movingNoOrg, "moving", null);
        yield* setState(movedNoOrg, "moved", null);
        yield* setState(moved, "moved", "v2-org-moved");
        return {
          none: yield* movedToV2(none),
          moving: yield* movedToV2(moving),
          movingNoOrg: yield* movedToV2(movingNoOrg),
          movedNoOrg: yield* movedToV2(movedNoOrg),
          moved: yield* movedToV2(moved),
        };
      }),
    );
    expect(result).toEqual({
      none: null,
      moving: null,
      movingNoOrg: null,
      movedNoOrg: null,
      moved: { v2OrganizationId: "v2-org-moved" },
    });
  });

  it("refuses a state other than moving or moved", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const org = yield* freshOrg();
          yield* setState(org, "paused", null);
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("toolkit slug lookup", () => {
  const createToolkit = (
    organizationId: string,
    accountId: string,
    owner: "org" | "user",
    slug: string,
  ) =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor<readonly [ReturnType<typeof toolkitsPlugin>]>(
        accountId,
        organizationId,
        "",
      );
      const created = yield* executor.toolkits.create({ owner, name: slug, slug });
      // v2 keys an imported toolkit by its storage row id, which is not the toolkit's id.
      const { db } = yield* DbService;
      const rows = yield* Effect.promise(() =>
        db.execute<{ row_id: string }>(sql`
          select row_id from plugin_storage
          where tenant = ${organizationId} and plugin_id = 'toolkits'
            and collection = 'toolkits' and key = ${created.id}
        `),
      );
      const rowId = [...rows][0]?.row_id;
      expect(rowId).toBeDefined();
      expect(rowId).not.toBe(created.id);
      return rowId;
    }).pipe(
      Effect.provide(Layer.mergeAll(CloudDbProvider, toolkitsOnly, CloudHostConfig)),
      Effect.provide(makeDbLayer()),
      Effect.scoped,
    );

  it("resolves the row the v1 session would pick for this caller", async () => {
    const org = await run(freshOrg());
    const otherOrg = await run(freshOrg());
    const run2 = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

    const orgDeploy = await run2(createToolkit(org, "user_me", "org", "deploy"));
    const notes = await run2(createToolkit(org, "user_me", "user", "notes"));
    const theirs = await run2(createToolkit(org, "user_other", "user", "secret"));
    await run2(createToolkit(otherOrg, "user_me", "org", "elsewhere"));

    expect(await resolveToolkitRowId(org, "user_me", "deploy")).toBe(orgDeploy);
    expect(await resolveToolkitRowId(org, "user_me", "notes")).toBe(notes);
    expect(await resolveToolkitRowId(org, "user_me", "secret")).toBeNull();
    expect(await resolveToolkitRowId(org, "user_me", "elsewhere")).toBeNull();
    expect(await resolveToolkitRowId(org, "user_me", "missing")).toBeNull();
    expect(await resolveToolkitRowId(org, "user_other", "secret")).toBe(theirs);
  });
});
