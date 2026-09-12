import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import { makeTestExecutor } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

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
      describeAuthMethods: () => [
        {
          id: "oauth",
          label: "OAuth",
          kind: "oauth" as const,
          template: String(TEMPLATE),
          oauth: { scopes: [] },
        },
      ],
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
        createThenRollback: () =>
          ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.connections.create({
                ...REF,
                template: TEMPLATE,
                value: "rolled-back-secret",
              });
              return yield* Effect.fail("rollback" as const);
            }),
          ),
        createInTransaction: () =>
          ctx.transaction(
            ctx.connections.create({
              ...REF,
              template: TEMPLATE,
              value: "committed-secret",
            }),
          ),
        credentialValues: () => Effect.sync(() => [...store.values()]),
        resolveValue: () => ctx.connections.resolveValue(REF),
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

  it.effect("discards required credential writes when an outer transaction rolls back", () =>
    Effect.gen(function* () {
      const executor = yield* setup([]);

      const outcome = yield* Effect.exit(executor.demo.createThenRollback());

      expect(Exit.isFailure(outcome)).toBe(true);
      expect(yield* executor.connections.get(REF)).toBeNull();
      expect(yield* executor.demo.credentialValues()).toEqual([]);
    }),
  );

  it.effect("finishes required credential writes before a committed outer call returns", () =>
    Effect.gen(function* () {
      const executor = yield* setup([]);

      yield* executor.demo.createInTransaction();

      expect(yield* executor.connections.get(REF)).not.toBeNull();
      expect(yield* executor.demo.credentialValues()).toEqual(["committed-secret"]);
    }),
  );

  it.effect(
    "discards new and replacement OAuth-client secrets when an outer transaction rolls back",
    () =>
      Effect.gen(function* () {
        const executor = yield* setup([]);
        const slug = OAuthClientSlug.make("transactional-client");
        const client = (clientId: string, clientSecret: string) => ({
          owner: "org" as const,
          slug,
          authorizationUrl: "https://example.test/authorize",
          tokenUrl: "https://example.test/token",
          grant: "client_credentials" as const,
          clientId,
          clientSecret,
        });

        const newResult = yield* Effect.exit(
          executor.demo.inTransaction(
            executor.oauth
              .createClient(client("new-id", "new-secret"))
              .pipe(Effect.andThen(Effect.fail("rollback" as const))),
          ),
        );
        expect(Exit.isFailure(newResult)).toBe(true);
        expect(yield* executor.oauth.listClients()).toEqual([]);
        expect(yield* executor.demo.credentialValues()).toEqual([]);

        yield* executor.oauth.createClient(client("original-id", "original-secret"));
        const before = yield* executor.demo.credentialValues();
        const replacementResult = yield* Effect.exit(
          executor.demo.inTransaction(
            executor.oauth
              .createClient(client("replacement-id", "replacement-secret"))
              .pipe(Effect.andThen(Effect.fail("rollback" as const))),
          ),
        );
        expect(Exit.isFailure(replacementResult)).toBe(true);
        expect(yield* executor.oauth.listClients()).toEqual([
          expect.objectContaining({ clientId: "original-id" }),
        ]);
        expect(yield* executor.demo.credentialValues()).toEqual(before);
      }),
  );

  it.effect(
    "discards new and replacement OAuth-connection tokens when an outer transaction rolls back",
    () =>
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          clients: { "transaction-client": "transaction-secret" },
        });
        const executor = yield* setup([]);
        const slug = OAuthClientSlug.make("transaction-connection-client");
        yield* executor.oauth.createClient({
          owner: "org",
          slug,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "transaction-client",
          clientSecret: "transaction-secret",
        });
        const start = executor.oauth.start({
          ...REF,
          client: slug,
          clientOwner: "org" as const,
          template: TEMPLATE,
        });
        const beforeNew = yield* executor.demo.credentialValues();

        const newResult = yield* Effect.exit(
          executor.demo.inTransaction(start.pipe(Effect.andThen(Effect.fail("rollback" as const)))),
        );
        expect(Exit.isFailure(newResult)).toBe(true);
        expect(yield* executor.connections.get(REF)).toBeNull();
        expect(yield* executor.demo.credentialValues()).toEqual(beforeNew);

        yield* start;
        const originalValue = yield* executor.demo.resolveValue();
        const beforeReplacement = yield* executor.demo.credentialValues();
        const replacementResult = yield* Effect.exit(
          executor.demo.inTransaction(start.pipe(Effect.andThen(Effect.fail("rollback" as const)))),
        );
        expect(Exit.isFailure(replacementResult)).toBe(true);
        expect(yield* executor.demo.resolveValue()).toBe(originalValue);
        expect(yield* executor.demo.credentialValues()).toEqual(beforeReplacement);
      }).pipe(Effect.scoped),
  );
});
