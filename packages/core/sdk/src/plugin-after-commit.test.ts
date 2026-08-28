import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import { makeTestExecutor } from "./test-config";

// A plugin's `removeConnection` runs INSIDE core's removal transaction, which is
// what makes its database work atomic with the row deletions. The same property
// makes anything reaching outside the database unsafe there: revoking a token at
// the provider's API cannot be rolled back with the transaction, so an abort
// leaves the connection restored and the token already dead.
//
// `ctx.afterCommit` is the way out, and these pin both directions of its
// contract — it runs when the removal is durable, and it is discarded when the
// removal is not.

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const revokingPlugin = (revoked: string[]) =>
  definePlugin(() => {
    const store = new Map<string, string>();
    return {
      id: "demo" as const,
      credentialProviders: [
        {
          key: ProviderKey.make("memory"),
          writable: true as const,
          get: (id: ProviderItemId) => Effect.sync(() => store.get(String(id)) ?? null),
          set: (id: ProviderItemId, value: string) =>
            Effect.sync(() => {
              store.set(String(id), value);
            }),
          delete: (id: ProviderItemId) =>
            Effect.sync(() => {
              store.delete(String(id));
            }),
        },
      ],
      storage: () => ({}),
      resolveTools: () =>
        Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
      invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
      /** Stands in for "revoke the token at the provider's API" — the archetypal
       *  irreversible, outside-the-database cleanup. */
      removeConnection: ({ ctx, connection }) =>
        ctx.afterCommit(
          Effect.sync(() => {
            revoked.push(String(connection.name));
          }),
        ),
      extension: (ctx) => ({
        seed: () =>
          ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
        inTransaction: <A, E>(effect: Effect.Effect<A, E>) => ctx.transaction(effect),
      }),
    };
  })();

const setup = (revoked: string[]) =>
  makeTestExecutor({ plugins: [revokingPlugin(revoked)] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

const REF = {
  owner: "org",
  integration: INTEG,
  name: ConnectionName.make("main"),
} as const;

describe("ctx.afterCommit inside a lifecycle hook", () => {
  it.effect("runs the deferred cleanup once the removal is durable", () =>
    Effect.gen(function* () {
      const revoked: string[] = [];
      const executor = yield* setup(revoked);
      yield* executor.connections.create({ ...REF, template: TEMPLATE, value: "secret-token" });

      yield* executor.connections.remove(REF);

      // Deferring must not mean dropping: an ordinary removal still revokes.
      expect(revoked).toEqual(["main"]);
    }),
  );

  it.effect("discards the deferred cleanup when the removal rolls back", () =>
    Effect.gen(function* () {
      const revoked: string[] = [];
      const executor = yield* setup(revoked);
      yield* executor.connections.create({ ...REF, template: TEMPLATE, value: "secret-token" });

      const outcome = yield* Effect.exit(
        executor.demo.inTransaction(
          Effect.gen(function* () {
            yield* executor.connections.remove(REF);
            return yield* Effect.fail("rollback" as const);
          }),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);

      // The connection survived, so revoking its token would have destroyed a
      // live credential with nothing left to undo it.
      const stillThere = yield* executor.connections.get(REF);
      expect(String(stillThere?.name)).toBe("main");
      expect(revoked).toEqual([]);
    }),
  );
});
