// ---------------------------------------------------------------------------
// Resolving a toolkit URL's slug to the toolkit's storage row id, for forwarding.
//
// Toolkits live in plugin storage (`@executor-js/plugin-toolkits`), owned by the
// org or by a single user. v2 imported each toolkit under its `plugin_storage`
// row id (not the toolkit's own `id`, which is the row's `key`), and derives the
// toolkit's v2 connection from that row id, so this reads the row id itself.
// The plugin's API hides it, hence the direct read. Visibility matches the v1
// session: the org's toolkits plus the caller's own personal ones, nobody
// else's. Among rows with the slug the org's toolkit wins over the caller's own,
// as in the plugin's slug resolution (`getBySlugEntry`).
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, makeDbLayer } from "../db/db";

export const resolveToolkitRowId = (
  organizationId: string,
  accountId: string,
  slug: string,
): Promise<string | null> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const result = yield* Effect.promise(() =>
        db.execute<{ row_id: string }>(sql`
          select row_id from plugin_storage
          where tenant = ${organizationId} and plugin_id = 'toolkits' and collection = 'toolkits'
            and (owner = 'org' or (owner = 'user' and subject = ${accountId}))
            and (data::jsonb)->>'slug' = ${slug}
          order by case when owner = 'org' then 0 else 1 end, key
          limit 1
        `),
      );
      return [...result][0]?.row_id ?? null;
    }).pipe(Effect.provide(makeDbLayer()), Effect.scoped),
  );
