import { Effect } from "effect";
import type { GetAccountConnection } from "../contracts/account-connection.ts";
import { CurrentActor, type ResourceLifecycle } from "../contracts/executor.ts";
import type { InteractiveHost } from "../contracts/interactive-accounts.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { readConnection } from "./connection-state.ts";
import { pendingInteractive } from "./interactive-state.ts";
import type { Query } from "./database.ts";

/** Resolve links through the product lifecycle; an HTTP client never supplies bound credentials. */
export const makeConnectionInteractive = (
  db: Query,
  interactive: Pick<InteractiveHost, "start" | "status" | "submit" | "cancel">,
  lifecycle?: ResourceLifecycle,
) => {
  const context = (input: typeof GetAccountConnection.Type) =>
    Effect.gen(function* () {
      const row = yield* readConnection(db, input);
      const accounts = yield* backgroundAccounts(db, lifecycle, {
        app: row.target.app,
        actor: yield* CurrentActor,
        connecting: row.target.requirement,
      });
      return { owner: row.owner, connection: row.id, accounts };
    });
  return {
    startInteractive: (input: typeof GetAccountConnection.Type & { readonly method: string }) =>
      Effect.flatMap(context(input), (ctx) => interactive.start({ ...ctx, method: input.method })),
    interactiveStatus: (input: typeof GetAccountConnection.Type) =>
      Effect.flatMap(context(input), interactive.status),
    submitInteractive: (input: typeof GetAccountConnection.Type & { readonly value: string }) =>
      Effect.flatMap(context(input), (ctx) => interactive.submit({ ...ctx, value: input.value })),
    cancelInteractive: (input: typeof GetAccountConnection.Type) =>
      Effect.gen(function* () {
        const row = yield* readConnection(db, input);
        const ctx =
          pendingInteractive(row)?.driver === undefined
            ? yield* context(input)
            : { owner: row.owner, connection: row.id, accounts: { app: {} } };
        yield* interactive.cancel(ctx);
      }),
  };
};
