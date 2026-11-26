import type { AppAccounts, Executor, StorageError } from "@executor-js/sdk/core";
import { Context, Effect, type Exit } from "effect";

export class HostedExecutor extends Context.Service<
  HostedExecutor,
  Effect.Effect<Executor, StorageError>
>()("hosted/Executor") {}

export type HostedBackgroundWork = (work: Effect.Effect<void>) => Effect.Effect<boolean>;
export const HostedBackground = Context.Reference<HostedBackgroundWork | undefined>(
  "hosted/Background",
  { defaultValue: () => undefined },
);

export interface StatementGroups {
  readonly group: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export const ConcurrentStatements = Context.Reference<StatementGroups | undefined>(
  "hosted/ConcurrentStatements",
  { defaultValue: () => undefined },
);

export const statementGroup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(ConcurrentStatements, (groups) =>
    groups === undefined ? effect : groups.group(effect),
  );

export const StatementBatch = Context.Reference<
  | ((
      leaves: ReadonlyArray<Effect.Effect<unknown>>,
      options: { readonly outside: number },
    ) => Effect.Effect<Array<Exit.Exit<unknown, unknown>>>)
  | undefined
>("hosted/StatementBatch", { defaultValue: () => undefined });

export interface CallState {
  readonly accounts: AppAccounts;
  readonly hint: unknown;
}

export const CallStateCache = Context.Reference<Map<string, CallState> | undefined>(
  "hosted/CallStateCache",
  { defaultValue: () => undefined },
);
