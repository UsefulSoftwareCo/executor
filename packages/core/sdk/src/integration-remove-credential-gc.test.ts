import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { createExecutor, type Executor } from "./executor";
import { StorageError } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig, makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// Removing an INTEGRATION strands the same secrets `connections.remove` used to
// strand, only in bulk and across people: the cascade drops every subject's
// connection rows under the slug, and the credentials those rows minted stayed
// behind in the provider, pointed at by nothing and reachable from nowhere in
// the product.
//
// The fixtures build TWO executors over ONE database bound to two subjects, the
// way `integration-removal-cascade.test.ts` does, over a store the test can
// inspect directly, the way `connection-remove-credential-gc.test.ts` does. The
// reads that matter are of the store itself: a removed connection can no longer
// resolve its own credential, so asking the executor would prove nothing.
//
// Every "it is gone" is paired with an "it is still there". A change that
// simply emptied the store would pass the first half of this file alone.

const INTEG = IntegrationSlug.make("datadog");
const KEPT = IntegrationSlug.make("linear");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const ALICE = "user_alice";
const BOB = "user_bob";

const inspectableProvider = (
  store: Map<string, string>,
  options: {
    readonly deleteFails?: boolean;
    /** Every id the removal ASKED to delete, recorded before the outcome, so a
     *  best-effort test can tell a swallowed failure from a delete that was
     *  never attempted at all. */
    readonly deleteAttempts?: string[];
  } = {},
): CredentialProvider => ({
  key: ProviderKey.make("memory"),
  writable: true,
  get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
  set: (id, value) =>
    Effect.sync(() => {
      store.set(String(id), value);
    }),
  has: (id) => Effect.sync(() => store.has(String(id))),
  delete: (id) =>
    Effect.suspend(() => {
      options.deleteAttempts?.push(String(id));
      return options.deleteFails === true
        ? Effect.fail(
            new StorageError({ message: "credential store is offline", cause: undefined }),
          )
        : Effect.sync(() => {
            store.delete(String(id));
          });
    }),
});

const demoPlugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("query"), description: "query" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: (slug: IntegrationSlug) =>
        ctx.core.integrations.register({ slug, description: String(slug), config: {} }),
      /** The plugin-owned OUTER transaction the removal can find itself inside. */
      inTransaction: <A, E>(effect: Effect.Effect<A, E>) => ctx.transaction(effect),
    }),
  }))();

/** Two executors over ONE database: `alice` is the admin who seeds and removes,
 *  `bob` is a member whose rows the removal reaches but whose rows the remover's
 *  own bound handle cannot see. */
const setup = (provider: CredentialProvider) =>
  Effect.gen(function* () {
    const config = makeTestConfig({ plugins: [demoPlugin(provider)] as const, subject: ALICE });
    const alice = yield* createExecutor(config);
    const bob = yield* createExecutor({
      ...config,
      subject: Subject.make(BOB),
      db: withQueryContext(config.testDb.db, { tenant: String(config.tenant), subject: BOB }),
    });
    yield* Effect.addFinalizer(() =>
      alice.close().pipe(Effect.andThen(bob.close()), Effect.ignore),
    );
    yield* alice.demo.seed(INTEG);
    yield* alice.demo.seed(KEPT);
    return { alice, bob };
  });

const connectPersonal = (
  executor: Executor,
  integration: IntegrationSlug,
  name: string,
  value: string,
) =>
  executor.connections.create({
    owner: "user",
    name: ConnectionName.make(name),
    integration,
    template: TEMPLATE,
    value,
  });

const referencePersonal = (
  executor: Executor,
  integration: IntegrationSlug,
  name: string,
  itemId: string,
) =>
  executor.connections.create({
    owner: "user",
    name: ConnectionName.make(name),
    integration,
    template: TEMPLATE,
    from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make(itemId) },
  });

/** Minted ids carry a per-attempt uuid, so a test cannot spell one out; it finds
 *  the id by the value the mint actually wrote under it. */
const idOf = (store: ReadonlyMap<string, string>, value: string): string => {
  const entry = [...store.entries()].find(([, stored]) => stored === value);
  expect(entry).toBeDefined();
  return entry?.[0] ?? "";
};

const OAUTH_INTEG = IntegrationSlug.make("oauthdemo");
const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth");

const oauthIntegrationPlugin = definePlugin(() => ({
  id: "oauthdemo" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth2",
      kind: "oauth" as const,
      template: String(OAUTH_TEMPLATE),
      oauth: { scopes: [] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({ slug: OAUTH_INTEG, description: "OAuth demo", config: {} }),
  }),
}))();

describe("removing an integration removes the credentials its connections minted", () => {
  it.effect("deletes the minted item of EVERY subject's connection under the slug", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const { alice, bob } = yield* setup(inspectableProvider(store));
      yield* connectPersonal(alice, INTEG, "aliceDd", "alice-token");
      yield* connectPersonal(bob, INTEG, "bobDd", "bob-token");
      yield* connectPersonal(bob, KEPT, "bobLinear", "bob-kept-token");
      const aliceId = idOf(store, "alice-token");
      const bobId = idOf(store, "bob-token");
      const keptId = idOf(store, "bob-kept-token");

      yield* alice.integrations.remove(INTEG);

      expect(store.has(aliceId)).toBe(false);
      // The half that only this change closes. The removal destroys Bob's row
      // through the tenant-reach cascade, but the remover's own bound handle
      // cannot even see that row — so the doomed set has to be read through the
      // same widened handle that deletes it, or Bob's secret is left behind.
      expect(store.has(bobId)).toBe(false);
      // And the sweep stops at the slug: an integration that was not removed
      // keeps its credential.
      expect(store.get(keptId)).toBe("bob-kept-token");
      expect([...store.keys()]).toEqual([keptId]);
    }).pipe(Effect.scoped),
  );

  it.effect("LEAVES an item a doomed connection only referenced", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const { alice, bob } = yield* setup(inspectableProvider(store));
      // Bob already had this, in his own store, under his own id. We never
      // wrote it, so deleting it would destroy a credential that has nothing to
      // do with the integration being removed. The row records that by leaving
      // `credential_write` null.
      store.set("bob-owned-item", "bob-owned-secret");
      yield* referencePersonal(bob, INTEG, "byo", "bob-owned-item");
      // A minted item under the SAME slug, so the sweep is known to have run
      // and to have skipped the referenced one rather than skipped everything.
      yield* connectPersonal(alice, INTEG, "aliceDd", "alice-token");
      const aliceId = idOf(store, "alice-token");

      yield* alice.integrations.remove(INTEG);

      expect(store.has(aliceId)).toBe(false);
      expect(store.get("bob-owned-item")).toBe("bob-owned-secret");
    }).pipe(Effect.scoped),
  );

  it.effect("LEAVES a minted item a SURVIVING connection still points at", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const { alice } = yield* setup(inspectableProvider(store));
      yield* connectPersonal(alice, INTEG, "doomed", "shared-token");
      const sharedId = idOf(store, "shared-token");
      // A connection under an integration that is NOT being removed points at
      // that same item instead of minting its own. Nothing stops this: the
      // reference path stores whatever id it is handed.
      yield* referencePersonal(alice, KEPT, "survivor", sharedId);
      // A second doomed connection with an item nobody else points at, so the
      // survival below is a hold-back and not an inert sweep.
      yield* connectPersonal(alice, INTEG, "alsoDoomed", "lonely-token");
      const lonelyId = idOf(store, "lonely-token");

      yield* alice.integrations.remove(INTEG);

      expect(store.has(lonelyId)).toBe(false);
      // Sweeping the aliased item away would pull the credential out from under
      // a connection that is still live and still using it.
      expect(store.get(sharedId)).toBe("shared-token");
    }).pipe(Effect.scoped),
  );

  // Best effort, and deliberately so. A provider that cannot delete must not
  // resurrect an integration the user has already removed: the failure leaves
  // the orphan that existed before, which is recoverable, where failing the
  // removal would leave rows the catalog no longer has an entry for.
  it.effect("a provider whose delete fails does not fail the removal", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const deleteAttempts: string[] = [];
      const { alice, bob } = yield* setup(
        inspectableProvider(store, { deleteFails: true, deleteAttempts }),
      );
      yield* connectPersonal(bob, INTEG, "bobDd", "bob-token");
      const bobId = idOf(store, "bob-token");

      const outcome = yield* Effect.exit(alice.integrations.remove(INTEG));

      expect(Exit.isSuccess(outcome)).toBe(true);
      // The delete was ATTEMPTED and its failure swallowed. Without this the
      // test would pass just as happily against a removal that never tried.
      expect(deleteAttempts).toEqual([bobId]);
      // The rows went even though the item could not be deleted.
      const bobConnections = yield* bob.connections.list();
      expect(bobConnections.map((connection) => String(connection.integration))).toEqual([]);
      expect(store.get(bobId)).toBe("bob-token");
    }).pipe(Effect.scoped),
  );

  it.effect("deletes BOTH the access and the refresh token of an OAuth connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The OAuth mint is the security-relevant half: it parks a long-lived
        // REFRESH token, and an integration removal sweeping up every member at
        // once is exactly where leaving those behind adds up.
        const store = new Map<string, string>();
        const server = yield* serveOAuthTestServer({});
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins: [demoPlugin(inspectableProvider(store)), oauthIntegrationPlugin] as const,
        });
        yield* executor.oauthdemo.seed();
        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("demo-app"),
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });
        // Everything in the store at this point belongs to the OAuth APP, not
        // to any connection. Captured before the flow so the assertion below
        // cannot accidentally be about nothing.
        const clientItemIds = [...store.keys()];
        expect(clientItemIds.length).toBeGreaterThan(0);

        const started = yield* executor.oauth.start({
          owner: "org",
          client: OAuthClientSlug.make("demo-app"),
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: OAUTH_INTEG,
          template: OAUTH_TEMPLATE,
        });
        if (started.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        // Both halves are versioned per attempt, so they are read back by shape
        // rather than spelled out.
        const oauthIds = [...store.keys()].filter((id) => id.startsWith("oauth:"));
        const refreshIds = oauthIds.filter((id) => id.endsWith(":refresh"));
        const accessIds = oauthIds.filter((id) => !id.endsWith(":refresh"));
        expect(refreshIds).toHaveLength(1);
        expect(accessIds).toHaveLength(1);
        const [accessId = ""] = accessIds;
        const [refreshId = ""] = refreshIds;

        yield* executor.integrations.remove(OAUTH_INTEG);

        expect(store.has(accessId)).toBe(false);
        // The long-lived half. Leaving this behind is the worst outcome here.
        expect(store.has(refreshId)).toBe(false);
        // The app's own client secret is the OAuth client's, not the
        // connection's, and it outlives the integration it was registered
        // against. Nothing here is entitled to delete it.
        expect(clientItemIds.filter((id) => store.has(id))).toEqual(clientItemIds);
      }),
    ),
  );
});

// The deletion reaches OUTSIDE the database, so it must not run inside the
// transaction that removes the rows. Nothing in a provider — a sealed store, a
// keychain, someone else's API — enlists in that transaction or rolls back with
// it. If an abort restores the rows after their secrets have already been
// destroyed, the result is a whole integration's worth of live connections
// pointing at credentials that no longer exist.
describe("the credential deletion runs after the transaction commits", () => {
  it.effect("a rolled-back removal leaves every subject's credential intact", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const { alice, bob } = yield* setup(inspectableProvider(store));
      yield* connectPersonal(alice, INTEG, "aliceDd", "alice-token");
      yield* connectPersonal(bob, INTEG, "bobDd", "bob-token");
      const aliceId = idOf(store, "alice-token");
      const bobId = idOf(store, "bob-token");

      // A caller wraps the removal in its own transaction and then fails, so
      // the catalog row and the whole cascade roll back.
      const outcome = yield* Effect.exit(
        alice.demo.inTransaction(
          Effect.gen(function* () {
            yield* alice.integrations.remove(INTEG);
            return yield* Effect.fail("rollback" as const);
          }),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);

      // The connections came back...
      const bobConnections = yield* bob.connections.list();
      expect(bobConnections.map((connection) => String(connection.integration))).toEqual([
        String(INTEG),
      ]);
      // ...so their credentials MUST still be there. A restored row pointing at
      // a destroyed secret is the one outcome that cannot be repaired.
      expect(store.get(aliceId)).toBe("alice-token");
      expect(store.get(bobId)).toBe("bob-token");

      // And the rollback is what spared them, not an inert fixture: the same
      // removal, committed this time, takes both.
      yield* alice.integrations.remove(INTEG);
      expect(store.has(aliceId)).toBe(false);
      expect(store.has(bobId)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
