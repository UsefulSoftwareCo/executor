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
import type { CredentialProvider } from "./provider";
import { makeTestExecutor, makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// Removing a connection has to remove the SECRET, not just the row that points at
// it — an item left behind in the store is still decryptable, which is the one
// thing a user deleting a credential is asking us to stop being true.
//
// The hard half is the opposite case. A connection can REFERENCE an item the user
// already had rather than minting one, and destroying that is unrecoverable. So
// these tests are written in pairs: every "it is gone" has a matching "it is still
// there", because a change that deleted everything would pass the first alone.

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** A provider whose store the test can inspect directly, so an assertion reads
 *  the actual item rather than a resolution that a deleted connection can no
 *  longer perform. */
const inspectableProvider = (
  store: Map<string, string>,
  writable: boolean,
): CredentialProvider => ({
  key: ProviderKey.make("memory"),
  writable,
  get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
  set: (id, value) =>
    Effect.sync(() => {
      store.set(String(id), value);
    }),
  delete: (id) =>
    Effect.sync(() => {
      store.delete(String(id));
    }),
  has: (id) => Effect.sync(() => store.has(String(id))),
});

const demoPlugin = (store: Map<string, string>, writable = true) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [inspectableProvider(store, writable)],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
    }),
  }))();

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

const setup = (store: Map<string, string>, writable = true) =>
  makeTestExecutor({ plugins: [demoPlugin(store, writable)] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

describe("removing a connection removes the credential it minted", () => {
  it.effect("deletes a pasted value from the provider", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      // The id this connection mints is deterministic, and the value is really there.
      const mintedId = "connection:org:vercel:main:token";
      expect(store.get(mintedId)).toBe("secret-token");

      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });

      expect(store.has(mintedId)).toBe(false);
      // Nothing else was swept up on the way past.
      expect([...store.keys()]).toEqual([]);
    }),
  );

  it.effect("LEAVES an item the connection only referenced", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      // The user already had this, in their own store, under their own id. We
      // never wrote it, and deleting it would destroy a credential that has
      // nothing to do with this connection.
      store.set("ext-item", "user-owned-secret");

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("ext-item") },
      });
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("byo"),
      });

      expect(store.get("ext-item")).toBe("user-owned-secret");
    }),
  );

  it.effect("leaves everything alone when the provider is not writable", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store, false);
      store.set("ext-item", "user-owned-secret");

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("ext-item") },
      });
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("byo"),
      });

      // `writable: false` means we never write there, and by the same contract
      // we never delete there either.
      expect(store.get("ext-item")).toBe("user-owned-secret");
    }),
  );

  it.effect("LEAVES a minted item that another connection has aliased", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      // `first` mints its own item.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("first"),
        integration: INTEG,
        template: TEMPLATE,
        value: "shared-token",
      });
      const mintedId = "connection:org:vercel:first:token";
      expect(store.get(mintedId)).toBe("shared-token");

      // `second` points AT that same item instead of minting its own. Nothing
      // stops this: the reference path stores whatever id it is handed.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("second"),
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make(mintedId) },
      });

      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("first"),
      });

      // Deleting the minting connection must not pull the credential out from
      // under the one still using it — that would break a live connection.
      expect(store.get(mintedId)).toBe("shared-token");
    }),
  );

  it.effect("deletes BOTH the access and the refresh token of an OAuth connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The OAuth mint is the security-relevant half: it parks a long-lived
        // REFRESH token, and leaving that behind is far worse than leaving an
        // access token. Nothing else in the suite exercises an `oauth:` item id,
        // so without this the `:refresh` half of the rebuild is unpinned.
        const store = new Map<string, string>();
        const server = yield* serveOAuthTestServer({});
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins: [demoPlugin(store), oauthIntegrationPlugin] as const,
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

        const accessId = "oauth:org:oauthdemo:main";
        expect(store.get(accessId)).toEqual(expect.any(String));
        expect(store.get(`${accessId}:refresh`)).toEqual(expect.any(String));

        yield* executor.connections.remove({
          owner: "org",
          integration: OAUTH_INTEG,
          name: ConnectionName.make("main"),
        });

        expect(store.has(accessId)).toBe(false);
        // The long-lived half. Leaving this behind is the worst outcome here.
        expect(store.has(`${accessId}:refresh`)).toBe(false);
      }),
    ),
  );

  it.effect("removing one connection does not touch another's credential", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      for (const name of ["first", "second"]) {
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make(name),
          integration: INTEG,
          template: TEMPLATE,
          value: `${name}-token`,
        });
      }

      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("first"),
      });

      expect(store.has("connection:org:vercel:first:token")).toBe(false);
      expect(store.get("connection:org:vercel:second:token")).toBe("second-token");
    }),
  );
});

// The deletion reaches OUTSIDE the database, so it must not run inside the
// transaction that removes the rows. Nothing in a provider — a sealed store, a
// keychain, someone else's API — enlists in that transaction or rolls back with
// it. If an abort restores the connection row after its secret has already been
// destroyed, the result is a live connection pointing at a credential that no
// longer exists: worse than the orphan this whole feature removes, and unlike
// the orphan, unrepairable.
const txPlugin = (store: Map<string, string>) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [inspectableProvider(store, true)],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
      /** The plugin-owned OUTER transaction the removal can find itself inside. */
      inTransaction: <A, E>(effect: Effect.Effect<A, E>) => ctx.transaction(effect),
    }),
  }))();

describe("the credential deletion runs after the transaction commits", () => {
  it.effect("a rolled-back removal leaves the credential intact", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* makeTestExecutor({ plugins: [txPlugin(store)] as const }).pipe(
        Effect.tap((e) => e.demo.seed()),
      );
      const ref = {
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      } as const;
      yield* executor.connections.create({ ...ref, template: TEMPLATE, value: "secret-token" });
      const mintedId = "connection:org:vercel:main:token";
      expect(store.get(mintedId)).toBe("secret-token");

      // A caller wraps the removal in its own transaction and then fails, so the
      // row deletions roll back.
      const outcome = yield* Effect.exit(
        executor.demo.inTransaction(
          Effect.gen(function* () {
            yield* executor.connections.remove(ref);
            return yield* Effect.fail("rollback" as const);
          }),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);

      // The connection came back...
      const stillThere = yield* executor.connections.get(ref);
      expect(String(stillThere?.name)).toBe("main");
      // ...so its credential MUST still be there. A restored row pointing at a
      // destroyed secret is the one outcome that cannot be repaired.
      expect(store.get(mintedId)).toBe("secret-token");
    }),
  );
});

// Removing the INTEGRATION takes the same connection rows out, in bulk. It left
// every secret those connections had minted behind — the identical orphan the
// per-connection removal above exists to prevent, reachable through a different
// door and stranding many at once instead of one. Paired the same way: what we
// minted goes, what the user already had stays.
describe("removing an integration removes the credentials its connections minted", () => {
  it.effect("deletes the minted items of every connection it drops", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("one"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-one",
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("two"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-two",
      });
      expect(store.get("connection:org:vercel:one:token")).toBe("secret-one");
      expect(store.get("connection:org:vercel:two:token")).toBe("secret-two");

      yield* executor.integrations.remove(INTEG);

      // Both, not just the first — the bulk delete is the whole point.
      expect(store.has("connection:org:vercel:one:token")).toBe(false);
      expect(store.has("connection:org:vercel:two:token")).toBe(false);
    }),
  );

  it.effect("keeps an item the connection only referenced", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      store.set("ext-item", "user-owned-secret");
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("ext-item") },
      });

      yield* executor.integrations.remove(INTEG);

      // Widening a delete to a whole integration must not widen WHAT it deletes.
      expect(store.get("ext-item")).toBe("user-owned-secret");
    }),
  );

  it.effect("a rolled-back integration removal leaves the credentials intact", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* makeTestExecutor({ plugins: [txPlugin(store)] as const }).pipe(
        Effect.tap((e) => e.demo.seed()),
      );
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("one"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-one",
      });

      const outcome = yield* Effect.exit(
        executor.demo.inTransaction(
          Effect.gen(function* () {
            yield* executor.integrations.remove(INTEG);
            return yield* Effect.fail("rollback" as const);
          }),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(store.get("connection:org:vercel:one:token")).toBe("secret-one");
    }),
  );
});

// The dangerous direction of the bulk delete: a connection on a DIFFERENT
// integration can reference an item this integration's connection minted. That
// connection survives the removal and is still using the credential, so
// deleting it would destroy a secret belonging to something still alive — the
// same "it is still there" pairing the single-connection path already carries,
// asked of the wider blast radius.
const OTHER = IntegrationSlug.make("netlify");

const twoIntegrationPlugin = (store: Map<string, string>) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [inspectableProvider(store, true)],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        Effect.gen(function* () {
          yield* ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} });
          yield* ctx.core.integrations.register({
            slug: OTHER,
            description: "Netlify",
            config: {},
          });
        }),
    }),
  }))();

describe("removing an integration respects connections that outlive it", () => {
  it.effect("keeps a minted item another integration's connection still points at", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* makeTestExecutor({
        plugins: [twoIntegrationPlugin(store)] as const,
      }).pipe(Effect.tap((e) => e.demo.seed()));

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("a"),
        integration: INTEG,
        template: TEMPLATE,
        value: "shared-secret",
      });
      const mintedId = "connection:org:vercel:a:token";
      expect(store.get(mintedId)).toBe("shared-secret");

      // A live connection on a different integration, pointing at that item.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("b"),
        integration: OTHER,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make(mintedId) },
      });

      yield* executor.integrations.remove(INTEG);

      // "b" is untouched by this removal and is still using the credential.
      // Deleting it would break a connection that nobody asked to remove.
      expect(store.get(mintedId)).toBe("shared-secret");
    }),
  );
});
