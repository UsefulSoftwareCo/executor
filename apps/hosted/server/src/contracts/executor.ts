import type { AppAccounts, Executor, StorageError } from "@executor-js/sdk/core";
import { Context, Effect, type Exit } from "effect";

/** Resolve the public SDK on demand. The host owns its lifetime: a cloud request or the self-host process. */
export class HostedExecutor extends Context.Service<
  HostedExecutor,
  Effect.Effect<Executor, StorageError>
>()("hosted/Executor") {}

/**
 * How this host's SQL client sends statements issued at the same time together: `group` runs an
 * effect as one statement group, whose concurrent statements share one connection and go out in
 * one write. Cloud's session objects group on their pool (`PgPool.grouped`), where a connection
 * carries one group at a time, so a slow statement only ever delays its own group; self-host runs
 * PGlite in-process, where grouping changes nothing. Where it is provided, each MCP tool call is a
 * group and makes its independent reads at once instead of one after another. Only a unit that
 * issues statements at the same time and succeeds or fails as a whole should be a group: its
 * statements share one connection, so each waits behind the slowest. Absent by default: in a pool
 * without groups each concurrent statement takes its own connection, and opening one costs far
 * more than the round trips saved.
 */
export interface StatementGroups {
  readonly group: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export const ConcurrentStatements = Context.Reference<StatementGroups | undefined>(
  "hosted/ConcurrentStatements",
  { defaultValue: () => undefined },
);

/** Runs `effect` as one statement group where the host groups statements; as is elsewhere. */
export const statementGroup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(ConcurrentStatements, (groups) =>
    groups === undefined ? effect : groups.group(effect),
  );

/**
 * Sends the first statement each of several effects issues together: once every leaf has issued
 * one or finished, they leave in one socket write on one connection (Cloud) or under one lock
 * (PGlite). Leaves before `outside` run first, each in its own implicit transaction; the rest run
 * in one repeatable-read transaction in that same batch, so they read one snapshot taken after the
 * earlier ones commit. A leaf's later statements run as usual. Leaves must not wait for one
 * another. Returns each leaf's exit. Set by a host whose database client supports it (Cloud's
 * session objects, self-host's MCP sessions); unset elsewhere.
 */
export const StatementBatch = Context.Reference<
  | ((
      leaves: ReadonlyArray<Effect.Effect<unknown>>,
      options: { readonly outside: number },
    ) => Effect.Effect<Array<Exit.Exit<unknown, unknown>>>)
  | undefined
>("hosted/StatementBatch", { defaultValue: () => undefined });

/**
 * What an MCP session's last tool call for one choice ran with: the accounts it resolved from the
 * caller's links, and the SDK's opaque hint about those accounts' grants.
 */
export interface CallState {
  readonly accounts: AppAccounts;
  readonly hint: unknown;
}

/**
 * The state each caller's last tool call read, by caller, app and linked accounts. It holds no
 * authorization: a call only uses it to name the accounts and grants its batch reads, and every
 * read and check in that batch runs live; accounts that no longer match the live links are
 * replaced and the reads sent again. Owned by one MCP session; unset elsewhere.
 */
export const CallStateCache = Context.Reference<Map<string, CallState> | undefined>(
  "hosted/CallStateCache",
  { defaultValue: () => undefined },
);
