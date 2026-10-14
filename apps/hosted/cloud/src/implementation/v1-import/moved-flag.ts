/**
 * The v1 moved flag (`org_moved_to_v2` in v1's database, `notes/v1-import.md`). `moving` stops v1
 * refreshing OAuth tokens and writing before v2 copies them; `moved` sends v1 sign-in to v2.
 *
 * Only for the later automatic move. The opt-in import does not use it: that import copies the
 * workspace and v1 keeps working.
 *
 * NOT APPROVED: the table, the `v1_import_writer` role and v1's readers of the flag do not exist
 * yet. {@link v1MovedFlagPostgres} is the intended implementation; it is not wired anywhere and
 * must not be until the flag and v1's handling of it are approved and deployed.
 */
import { PgClient } from "@effect/sql-pg";
import { Effect, type Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";

export type V1MovedState = "moving" | "moved";

export interface V1MovedFlag {
  readonly set: (input: {
    readonly organization: string;
    readonly state: V1MovedState;
    /** Null before the v2 organization exists. */
    readonly v2Organization: string | null;
  }) => Effect.Effect<void, V1ImportUnavailable>;
}

/**
 * The intended write, as the `v1_import_writer` role allows: INSERT and UPDATE on
 * `org_moved_to_v2` only. Not wired; see the module comment.
 */
export const v1MovedFlagPostgres = (database: Redacted.Redacted<string>): V1MovedFlag => ({
  set: (input) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        insert into org_moved_to_v2 (org_id, state, v2_org_id, updated_at)
        values (${input.organization}, ${input.state}, ${input.v2Organization}, now())
        on conflict (org_id) do update set
          state = excluded.state, v2_org_id = excluded.v2_org_id, updated_at = now()
      `;
    }).pipe(
      Effect.provide(PgClient.layer({ url: database, maxConnections: 1, prepare: false })),
      Effect.mapError(() => new V1ImportUnavailable()),
    ),
});
