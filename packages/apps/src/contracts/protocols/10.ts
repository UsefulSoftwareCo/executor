/**
 * Host protocol 10: protocol 9 plus app-owned SQL.
 *
 * A build with SQL files in `migrations/` declares `sql` and owns a raw SQLite database. The host
 * applies pending migrations with the `migrate` command when it deploys a build, before activating
 * it. Apps
 * of this protocol no longer declare a document `database`; the field remains so requirements read
 * from older retained builds keep their meaning. Every other message is protocol 9's, re-exported
 * unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol10` with
 * `packages/apps/protocols/10.json`. Define the next protocol instead of editing this file.
 * See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import {
  DeclaredRequirements as PreviousRequirements,
  HostInvocation as PreviousInvocation,
  HostRequest as PreviousRequest,
  protocol9,
} from "./9.ts";

export * from "./9.ts";

/** Account requirements, plus whether the app owns a SQL database. */
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  sql: Schema.optionalKey(Schema.Literal(true)),
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Apply the build's pending SQL migrations. No accounts are bound and the app is not evaluated. */
export const MigrateCommand = Schema.Struct({ operation: Schema.Literal("migrate") });
export type MigrateCommand = typeof MigrateCommand.Type;

/** The migrations this command applied, oldest first, by position and file path. Empty when the database was current. */
export const MigrateResult = Schema.Array(
  Schema.Struct({ id: Schema.Int, name: Schema.NonEmptyString }),
);
export type MigrateResult = typeof MigrateResult.Type;

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([...PreviousRequest.members, MigrateCommand]);
export type HostRequest = typeof HostRequest.Type;

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
  command: HostRequest,
});
export type HostInvocation = typeof HostInvocation.Type;

/** Every message of protocol 10, in the order its snapshot records them. */
export const protocol10 = {
  version: 10,
  schemas: {
    ...protocol9.schemas,
    request: HostRequest,
    requirements: DeclaredRequirements,
    invocation: HostInvocation,
    migrate: MigrateResult,
  },
} as const;
