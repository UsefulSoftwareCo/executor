import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { createExecutor } from "./executor";
import { StorageError, type FumaDb } from "./fuma-runtime";
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
import { makeTestConfig, makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// An in-flight authorization flow parks its PKCE verifier in `oauth_session` in
// plaintext, which is fine while the flow can still spend it. What is not fine is
// leaving it there after the flow has died: the happy path and `cancel` delete the
// row, but a completion that FAILED did not, and nothing sweeps the table, so the
// verifier outlived the flow indefinitely.
//
// Paired, like every deletion test: an unredeemable session must go, and a
// perfectly good one sitting beside it must not.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

const memoryCredentialsPlugin = definePlugin(() => {
  const store = new Map<string, string>();
  return {
    id: "memory-credentials" as const,
    storage: () => ({}),
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
  };
})();

const acmePlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth2",
      kind: "oauth" as const,
      template: String(TEMPLATE),
      oauth: { scopes: [] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
  }),
}))();

interface SessionRow {
  readonly pkce_verifier?: string | null;
  readonly expires_at?: number | null;
}

/** Read a session straight from storage through the given executor's own db
 *  handle, so the read is scoped exactly like that executor's writes. */
const readSession = (db: FumaDb, state: string) =>
  Effect.promise(
    () =>
      db.findFirst("oauth_session", {
        where: (b) => b("state", "=", state),
      }) as Promise<SessionRow | null>,
  );

/** A test db whose `deleteMany` on ONE table always rejects — the storage fault
 *  the sweep has to survive. `withContext` is forwarded through the wrapper
 *  because the executor re-derives its own owner context from whatever db it is
 *  handed; without that the fault would be unwrapped away on construction. */
const withFailingDeletes = (db: FumaDb, table: string): FumaDb =>
  new Proxy(db, {
    get(target, property) {
      if (property === "withContext") {
        return (context: unknown) => withFailingDeletes(withQueryContext(target, context), table);
      }
      if (property === "deleteMany") {
        return async (name: string, ...rest: readonly unknown[]) => {
          if (name === table) {
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a FumaDB query reports failure by rejecting, which is the fault being simulated
            throw new StorageError({
              message: `simulated storage failure deleting from "${table}"`,
              cause: undefined,
            });
          }
          const forward = Reflect.get(target, property) as (
            ...args: readonly unknown[]
          ) => Promise<unknown>;
          return forward.call(target, name, ...rest);
        };
      }
      return Reflect.get(target, property);
    },
  });

describe("a dead authorization flow does not keep its PKCE verifier", () => {
  it.effect("sweeps an expired verifier the next time authorization starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({});
        const { executor, config } = yield* makeTestWorkspaceHarness({
          plugins: [memoryCredentialsPlugin, acmePlugin] as const,
        });
        yield* executor.acme.seed();
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        // An abandoned flow: started, never returned to. Nothing completes it, so
        // the lazy expiry check in `complete` never runs for it.
        const abandoned = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("abandoned"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (abandoned.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        // A live flow started beside it, which must survive the sweep.
        const live = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("live"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (live.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }

        // Age only the abandoned one past its expiry.
        yield* Effect.promise(() =>
          config.db.updateMany("oauth_session", {
            where: (b) => b("state", "=", String(abandoned.state)),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        expect((yield* readSession(config.db, String(abandoned.state)))?.pkce_verifier).toEqual(
          expect.any(String),
        );

        // Starting any authorization is what tidies up.
        const third = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("third"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (third.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }

        expect(yield* readSession(config.db, String(abandoned.state))).toBeNull();
        // The unexpired flow is untouched — a sweep must not cancel someone
        // else's authorization mid-flight.
        expect((yield* readSession(config.db, String(live.state)))?.pkce_verifier).toEqual(
          expect.any(String),
        );
      }),
    ),
  );

  it.effect("drops the session when the completion cannot be retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({});
        const { executor, config } = yield* makeTestWorkspaceHarness({
          plugins: [memoryCredentialsPlugin, acmePlugin] as const,
        });
        yield* executor.acme.seed();
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const dying = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("dying"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (dying.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        const dyingCallback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: dying.authorizationUrl,
        });

        const bystander = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("bystander"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (bystander.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }

        // The verifier really is sitting there in plaintext.
        const before = yield* readSession(config.db, String(dying.state));
        expect(before?.pkce_verifier).toEqual(expect.any(String));

        // Remove the app this flow was started against, so completion fails with
        // restartRequired — this state can never be redeemed again.
        yield* executor.oauth.removeClient("org", CLIENT);
        const failed = yield* Effect.flip(
          executor.oauth.complete({ state: dying.state, code: dyingCallback.code }),
        );
        expect(JSON.stringify(failed)).toContain("restartRequired");

        expect(yield* readSession(config.db, String(dying.state))).toBeNull();
        // The other flow is still live and untouched — a cleanup must not sweep
        // sessions it was not asked about.
        const survivor = yield* readSession(config.db, String(bystander.state));
        expect(survivor?.pkce_verifier).toEqual(expect.any(String));
      }),
    ),
  );

  // The sweep runs with no owner clause of its own — it trusts the table's
  // delete policy to scope it. That trust is the whole safety argument, and it
  // is invisible at the call site, so it is pinned here: one member starting an
  // authorization must never reach into another member's rows, however stale
  // they are. Two subjects on ONE database is the only way to observe it.
  it.effect("one member's sweep leaves another member's expired session alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({});
        const dataDir = mkdtempSync(join(tmpdir(), "oauth-session-sweep-"));
        const tenant = "shared-tenant";
        const plugins = [memoryCredentialsPlugin, acmePlugin] as const;

        const a = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "subject-a",
          dataDir,
        });
        yield* a.executor.acme.seed();
        yield* a.executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        // A second member of the same tenant, on the same database.
        const b = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "subject-b",
          dataDir,
        });

        // Both members abandon a USER-owned flow. `owner: "user"` is what makes
        // the rows private to each subject; an org row is tenant-shared by
        // design and its removal by any member is correct.
        const startUserFlow = (harness: typeof a, name: string) =>
          Effect.gen(function* () {
            const started = yield* harness.executor.oauth.start({
              owner: "user",
              client: CLIENT,
              clientOwner: "org",
              name: ConnectionName.make(name),
              integration: INTEG,
              template: TEMPLATE,
            });
            if (started.status !== "redirect") {
              return yield* Effect.die("expected a redirect-status OAuth start");
            }
            return started;
          });

        const expire = (db: FumaDb, state: string) =>
          Effect.promise(() =>
            db.updateMany("oauth_session", {
              where: (builder) => builder("state", "=", state),
              set: { expires_at: Date.now() - 60_000 },
            }),
          );

        const bStale = yield* startUserFlow(b, "b-stale");
        yield* expire(b.config.db, String(bStale.state));

        const aStale = yield* startUserFlow(a, "a-stale");
        yield* expire(a.config.db, String(aStale.state));

        // B's row really is a sweep candidate — otherwise surviving would prove
        // nothing about scoping.
        const bBefore = yield* readSession(b.config.db, String(bStale.state));
        expect(Number(bBefore?.expires_at)).toBeLessThan(Date.now());

        // A starts again. Its sweep must reach its OWN expired row and no
        // further.
        yield* startUserFlow(a, "a-fresh");

        expect(yield* readSession(a.config.db, String(aStale.state))).toBeNull();
        expect((yield* readSession(b.config.db, String(bStale.state)))?.pkce_verifier).toEqual(
          expect.any(String),
        );
      }),
    ),
  );

  // Best-effort must not mean silent. The sweep is the only thing keeping this
  // table bounded, and `start` is the only caller that runs it, so a sweep that
  // fails every time would otherwise reinstate the original leak with nothing
  // anywhere to say so.
  it.effect("warns when the sweep fails, and starts the authorization anyway", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({});
        const base = makeTestConfig({
          plugins: [memoryCredentialsPlugin, acmePlugin] as const,
        });
        const executor = yield* createExecutor({
          ...base,
          db: withFailingDeletes(base.db, "oauth_session"),
        });
        yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));
        yield* executor.acme.seed();
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const warnings: string[] = [];
        const capture = Logger.make<unknown, void>(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(JSON.stringify(message));
        });

        const started = yield* executor.oauth
          .start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("undeterred"),
            integration: INTEG,
            template: TEMPLATE,
          })
          .pipe(Effect.provide(Logger.layer([capture])));

        // The authorization is unharmed: the caller still gets somewhere to go.
        expect(started.status).toBe("redirect");
        expect(warnings.join("\n")).toContain("expired-session sweep failed");
      }),
    ),
  );
});
