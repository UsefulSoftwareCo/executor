import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { StorageError } from "./fuma-runtime";
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

// Removing a connection has to remove the SECRET, not just the row that points
// at it — an item left behind in the store is still decryptable, which is the
// one thing a user deleting a credential is asking us to stop being true.
//
// The hard half is the opposite case. A connection can REFERENCE an item the
// user already had rather than minting one, and destroying that is
// unrecoverable. So these tests are written in pairs: every "it is gone" has a
// matching "it is still there", because a change that deleted everything would
// pass the first alone.

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** A provider whose store the test can inspect directly, so an assertion reads
 *  the actual item rather than a resolution a removed connection can no longer
 *  perform. */
const inspectableProvider = (
  store: Map<string, string>,
  options: {
    /** An ACCESSOR, not a literal, because one case needs a provider that stops
     *  being writable after it has already minted — the only state in which the
     *  writability gate is reachable. The executor wraps a registered provider
     *  with `Object.create`, so the accessor survives the wrap and stays live. */
    readonly isWritable?: () => boolean;
    readonly deleteFails?: boolean;
  } = {},
): CredentialProvider => ({
  key: ProviderKey.make("memory"),
  get writable() {
    return options.isWritable?.() ?? true;
  },
  get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
  set: (id, value) =>
    Effect.sync(() => {
      store.set(String(id), value);
    }),
  has: (id) => Effect.sync(() => store.has(String(id))),
  delete: (id) =>
    options.deleteFails === true
      ? Effect.fail(new StorageError({ message: "credential store is offline", cause: undefined }))
      : Effect.sync(() => {
          store.delete(String(id));
        }),
});

const demoPlugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [provider],
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

const setup = (provider: CredentialProvider) =>
  makeTestExecutor({ plugins: [demoPlugin(provider)] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

/** The one id in the store, asserted to be the only one. Minted ids carry a
 *  per-attempt uuid, so a test cannot spell one out; it reads back what the
 *  mint actually wrote. */
const onlyItemId = (store: ReadonlyMap<string, string>): string => {
  const keys = [...store.keys()];
  expect(keys).toHaveLength(1);
  const [only = ""] = keys;
  return only;
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

describe("removing a connection removes the credential it minted", () => {
  // The premise the whole design rests on. A minted item id is NOT derivable
  // from the row: it carries a uuid unique to the write attempt, so the
  // connection's own columns cannot reproduce it. That is why ownership is read
  // from the `credential_write` marker instead of by rebuilding a deterministic
  // id and comparing — a rebuild would match nothing and delete nothing.
  it.effect("mints an item id the row cannot reproduce", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(inspectableProvider(store));
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });

      const mintedId = onlyItemId(store);
      expect(mintedId).not.toBe("connection:org:vercel:main:token");
      expect(mintedId.startsWith("connection:org:vercel:main:")).toBe(true);
      expect(mintedId.endsWith(":token")).toBe(true);
    }),
  );

  it.effect("deletes the item a pasted connection minted", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(inspectableProvider(store));
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      const mintedId = onlyItemId(store);
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
      const executor = yield* setup(inspectableProvider(store));
      // The user already had this, in their own store, under their own id. We
      // never wrote it, and deleting it would destroy a credential that has
      // nothing to do with this connection. The row records that by leaving
      // `credential_write` null.
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

  // The writability gate, exercised the only way it is reachable: the item was
  // minted while the provider was writable, and the provider stopped being
  // writable before the removal. `writable: false` means we never write there,
  // and by the same contract we never delete there either.
  it.effect("LEAVES a minted item once its provider stops being writable", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      let writable = true;
      const executor = yield* setup(inspectableProvider(store, { isWritable: () => writable }));
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      const mintedId = onlyItemId(store);

      writable = false;
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });

      expect(store.get(mintedId)).toBe("secret-token");
    }),
  );

  it.effect("LEAVES a minted item that another connection has aliased", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(inspectableProvider(store));
      // `first` mints its own item.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("first"),
        integration: INTEG,
        template: TEMPLATE,
        value: "shared-token",
      });
      const mintedId = onlyItemId(store);
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

      // Removing the minting connection must not pull the credential out from
      // under the one still using it — that would break a live connection.
      expect(store.get(mintedId)).toBe("shared-token");
    }),
  );

  it.effect("removing one connection does not touch another's credential", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(inspectableProvider(store));
      for (const name of ["first", "second"]) {
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make(name),
          integration: INTEG,
          template: TEMPLATE,
          value: `${name}-token`,
        });
      }
      const idOf = (value: string): string => {
        const entry = [...store.entries()].find(([, stored]) => stored === value);
        expect(entry).toBeDefined();
        return entry?.[0] ?? "";
      };
      const firstId = idOf("first-token");
      const secondId = idOf("second-token");

      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("first"),
      });

      expect(store.has(firstId)).toBe(false);
      expect(store.get(secondId)).toBe("second-token");
    }),
  );

  // Best effort, and deliberately so. A provider that cannot delete must not
  // resurrect a connection the user has already removed: a failure here leaves
  // the orphan that existed before, which is recoverable, rather than failing a
  // removal whose rows are already gone.
  it.effect("a provider whose delete fails does not fail the removal", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(inspectableProvider(store, { deleteFails: true }));
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      const mintedId = onlyItemId(store);

      const outcome = yield* Effect.exit(
        executor.connections.remove({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        }),
      );

      expect(Exit.isSuccess(outcome)).toBe(true);
      // The row is gone even though the item could not be deleted.
      const gone = yield* executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });
      expect(gone).toBeNull();
      expect(store.get(mintedId)).toBe("secret-token");
    }),
  );

  it.effect("deletes BOTH the access and the refresh token of an OAuth connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The OAuth mint is the security-relevant half: it parks a long-lived
        // REFRESH token, and leaving that behind is far worse than leaving an
        // access token. Nothing else in the suite exercises an `oauth:` item id
        // or a `refresh_item_id`, so without this the refresh half is unpinned.
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

        yield* executor.connections.remove({
          owner: "org",
          integration: OAUTH_INTEG,
          name: ConnectionName.make("main"),
        });

        expect(store.has(accessId)).toBe(false);
        // The long-lived half. Leaving this behind is the worst outcome here.
        expect(store.has(refreshId)).toBe(false);
      }),
    ),
  );
});

// The deletion reaches OUTSIDE the database, so it must not run inside the
// transaction that removes the rows. Nothing in a provider — a sealed store, a
// keychain, someone else's API — enlists in that transaction or rolls back with
// it. If an abort restores the connection row after its secret has already been
// destroyed, the result is a live connection pointing at a credential that no
// longer exists: worse than the orphan this whole feature removes, and unlike
// the orphan, unrepairable.
describe("the credential deletion runs after the transaction commits", () => {
  it.effect("a rolled-back removal leaves the credential intact", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(inspectableProvider(store));
      const ref = {
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      } as const;
      yield* executor.connections.create({ ...ref, template: TEMPLATE, value: "secret-token" });
      const mintedId = onlyItemId(store);

      // A caller wraps the removal in its own transaction and then fails, so
      // the row deletions roll back.
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
