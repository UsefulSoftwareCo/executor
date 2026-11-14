/**
 * A webhook subscription depends on its source account and on every account its registration ran
 * with. Deleting an account those subscriptions still use is refused, naming them; a subscription
 * that no longer uses the account does not hold it. Each case is its own scenario with its own app,
 * so each waits only on its own registrations.
 */
import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appLinksFixture, keyProvider, ok, okBody } from "../support/app-links.ts";
import {
  confirmWebhookRemoval,
  settleWebhookSubscriptions,
  webhookSubscriptions,
  type WebhookSubscriptionRow,
} from "../support/webhook-sources.ts";
import { McpClient } from "../support/mcp-client.ts";
import { managementApp } from "../support/management-app.ts";
import { scenarios } from "../test-plan.ts";

/**
 * A registered webhook on the `source` requirement whose registration also runs with the `token`
 * requirement's accounts, and a webhook on `manualSource` set up by hand.
 */
const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("Webhook dependency fixture")};
const incoming = { account: { app: "source" }, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {},
  handle: async (ctx) => Response.json({ token: ctx.app.accounts.token.map((item) => item.id) }) };
const manual = { account: { app: "manualSource" }, config: object({}), state: object({}),
  setup: { instructions: "Paste the callback URL into the provider's webhook settings.", signingSecret: "executor" },
  handle: async () => Response.json({ received: true }) };
export default defineApp({ app: { accounts: { source: team.many(), token: team.many(), manualSource: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { incoming, manual } }));`;
/** A webhook on each person's `source`, registered with the app's `token` accounts. */
const memberSource = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("Hidden webhook dependency fixture")};
const incoming = { account: { user: "source" }, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {}, handle: async () => Response.json({}) };
export default defineApp({ app: { accounts: { token: team.many() } }, user: { accounts: { source: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { incoming } }));`;
/** The body clients decoded before the refusal named its subscriptions; it is closed. */
const EarlierRefusal = Schema.Struct({
  _tag: Schema.Literal("AccountWebhooksActive"),
  account: Schema.String,
  message: Schema.String,
});
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const Members = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({ id: Schema.String, user: Schema.Struct({ email: Schema.String }) }),
  ),
});
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

/** The fixture's app and the waits and refusals each scenario reads it through. */
const dependencies = Effect.gen(function* () {
  const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
  const { api, actors, prefix, app, path } = fixture;
  const subscription = (name: string, account: string, status: string) =>
    settleWebhookSubscriptions(actors.owner, path, (hooks) =>
      hooks.some(
        (hook) =>
          hook.name === name &&
          hook.sourceAccount === account &&
          hook.status === status &&
          hook.failure === null,
      ),
    ).pipe(
      Effect.map((hooks) =>
        hooks.find(
          (hook) => hook.name === name && hook.sourceAccount === account && hook.status === status,
        ),
      ),
      Effect.flatMap((hook) =>
        hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
      ),
    );
  const remove = (actor: Session, account: string) =>
    api.request(actor, "DELETE", `${prefix}/accounts/${account}`);
  /** Deleting the account is refused, naming exactly these subscriptions. */
  const refusedFor = (
    account: string,
    blocking: ReadonlyArray<{ hook: WebhookSubscriptionRow; status: string }>,
  ) =>
    Effect.gen(function* () {
      const response = yield* remove(actors.owner, account);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      // Clients and Executor apps holding the earlier document decode a closed object.
      const refusal = yield* Schema.decodeUnknownEffect(EarlierRefusal)(response.body, {
        onExcessProperty: "error",
      });
      expect(refusal.account).toBe(account);
      for (const { hook, status } of blocking)
        expect(refusal.message).toContain(`${app.id}/${hook.id} (${status})`);
      expect(refusal.message.match(/whk_/g)?.length ?? 0).toBe(blocking.length);
      return refusal.message;
    });
  /**
   * An API token for the app's own requirement, then a source account: the source's registration
   * runs with both. Unlinking the token leaves the registration depending on it: removing the
   * subscription at the provider runs with the accounts it registered with.
   */
  const liveRegistration = Effect.gen(function* () {
    const token = yield* fixture.connect(actors.owner, "app", "token", "api-token");
    const own = yield* fixture.connect(actors.owner, "app", "source", "owner-source");
    const registered = yield* subscription("incoming", own, "active");
    yield* ok(yield* fixture.unlink(actors.owner, "token", token));
    return { token, own, registered };
  });
  return { ...fixture, subscription, remove, refusedFor, liveRegistration };
});

layer(HostedLive, { excludeTestServices: true })("Account webhook dependencies", (it) => {
  it.effect(scenarios.hostedAccountWebhookDependencies.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, unlink, subscription, remove, refusedFor, liveRegistration } =
          yield* dependencies;
        const { token, own, registered } = yield* liveRegistration;
        // No subscription names the token as its source, as the reporter saw.
        expect(
          (yield* webhookSubscriptions(actors.owner, path)).filter(
            (hook) => hook.sourceAccount === token,
          ),
        ).toEqual([]);
        const message = yield* refusedFor(token, [{ hook: registered, status: "active" }]);
        expect(message).toContain("webhooks.remove");

        // Unlinking the source removes its registration with the token; then the token goes.
        yield* ok(yield* unlink(actors.owner, "source", own));
        yield* subscription("incoming", own, "stopped");
        yield* ok(yield* remove(actors.owner, token));
      }),
    ),
  );

  it.effect(scenarios.hostedAccountWebhookDependenciesAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, app, liveRegistration } = yield* dependencies;
        const mcp = yield* McpClient;
        const { token, registered } = yield* liveRegistration;

        // An agent deleting the account through the Executor app reads the same subscriptions.
        const key = yield* body(
          Token,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Account webhook dependencies",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        yield* managementApp(actors.owner);
        const client = yield* mcp.connect(key.key, "account-webhook-dependencies", {
          organization: actors.organization.id,
        });
        const disconnect = `return await tools.executor.accounts.disconnect(${JSON.stringify({ path: { organization: actors.organization.id, account: token } })})`;
        const attempted = yield* Schema.decodeUnknownEffect(Execution)(
          (yield* client.use("An agent deletes the API token account", (mcpClient, signal) =>
            mcpClient.callTool({ name: "execute", arguments: { code: disconnect } }, undefined, {
              signal,
            }),
          )).structuredContent,
        );
        expect(attempted.execution.ok, JSON.stringify(attempted.execution)).toBe(false);
        expect(JSON.stringify(attempted.execution.error)).toContain(
          `${app.id}/${registered.id} (active)`,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.hostedAccountWebhookStrandedRegistration.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, connect, unlink, subscription, remove } = yield* dependencies;
        // A registration Executor could not remove waits, disabled, for a person to remove it at
        // the provider. That needs none of its accounts, so it does not hold the token it ran with.
        const token = yield* connect(actors.owner, "app", "token", "api-token");
        const departed = yield* connect(actors.admin, "app", "source", "admin-source");
        const stranded = yield* subscription("incoming", departed, "active");
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        yield* ok(
          yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: user.email,
          }),
        );
        yield* ok(yield* unlink(actors.owner, "source", departed));
        expect((yield* subscription("incoming", departed, "disabled")).id).toBe(stranded.id);
        yield* ok(yield* unlink(actors.owner, "token", token));
        yield* ok(yield* remove(actors.owner, token));
        // Confirming its removal stops it.
        expect(
          yield* okBody(
            Schema.Struct({ status: Schema.String }),
            yield* api.request(
              actors.owner,
              "POST",
              `${path}/webhooks/${stranded.id}/confirm-removal`,
            ),
          ),
        ).toEqual({ status: "stopped" });
      }),
    ),
  );

  it.effect(scenarios.hostedAccountWebhookManualSource.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, connect, unlink, subscription, remove, refusedFor } =
          yield* dependencies;
        // A disabled subscription still holds its source: confirming its removal in the
        // dashboard needs access to that account. Once confirmed, the source can go.
        const manualAccount = yield* connect(actors.owner, "app", "manualSource", "manual-source");
        const manual = yield* subscription("manual", manualAccount, "setup-required");
        yield* ok(yield* unlink(actors.owner, "manualSource", manualAccount));
        yield* subscription("manual", manualAccount, "disabled");
        expect(yield* refusedFor(manualAccount, [{ hook: manual, status: "disabled" }])).toContain(
          "webhooks.confirmRemoval",
        );
        expect(
          yield* okBody(
            Schema.Struct({ status: Schema.String }),
            yield* api.request(
              actors.owner,
              "POST",
              `${path}/webhooks/${manual.id}/confirm-removal`,
            ),
          ),
        ).toEqual({ status: "stopped" });
        yield* ok(yield* remove(actors.owner, manualAccount));

        // Confirming while the subscription is still held answers a conflict, which the fixture's
        // clean-up waits out: a confirmation started before the unlink has disabled the
        // subscription is retried until it can stop it.
        const laterAccount = yield* connect(actors.owner, "app", "manualSource", "later-source");
        const later = yield* subscription("manual", laterAccount, "setup-required");
        const conflicted = yield* Deferred.make<void>();
        const confirming = yield* Effect.forkChild(
          confirmWebhookRemoval(actors.owner, path, later.id, conflicted),
        );
        yield* Deferred.await(conflicted);
        yield* ok(yield* unlink(actors.owner, "manualSource", laterAccount));
        const confirmed = yield* Fiber.join(confirming);
        expect(confirmed.conflicts, "conflicts the confirmation waited out").toBeGreaterThan(0);
        expect(confirmed.response.status, JSON.stringify(confirmed.response.body)).toBe(200);
        expect(yield* body(Schema.Struct({ status: Schema.String }), confirmed.response)).toEqual({
          status: "stopped",
        });
        yield* ok(yield* remove(actors.owner, laterAccount));
      }),
    ),
  );

  it.effect(scenarios.hostedAccountWebhookHiddenDependents.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, app, path, connect, unlink } = yield* appLinksFixture([
          { path: "index.ts", content: memberSource },
        ]);
        const remove = (token: string) =>
          api.request(actors.admin, "DELETE", `${prefix}/accounts/${token}`);
        const refusal = (token: string) =>
          Effect.gen(function* () {
            const response = yield* remove(token);
            expect(response.status, JSON.stringify(response.body)).toBe(409);
            return {
              text: JSON.stringify(response.body),
              message: (yield* Schema.decodeUnknownEffect(EarlierRefusal)(response.body)).message,
            };
          });
        const registered = (actor: Session, account: string, status: string) =>
          settleWebhookSubscriptions(actor, path, (hooks) =>
            hooks.some((hook) => hook.sourceAccount === account && hook.status === status),
          ).pipe(
            Effect.map((hooks) => hooks.find((hook) => hook.sourceAccount === account)),
            Effect.flatMap((hook) =>
              hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
            ),
          );

        // The admin's own token, linked by the admin for the app's own requirement, and a source
        // account each for the owner and the admin: both registrations run with the token.
        const token = yield* connect(actors.admin, "app", "token", "admin-token");
        const ownerSource = yield* connect(actors.owner, "user", "source", "owner-source");
        const memberAccount = yield* connect(actors.admin, "user", "source", "admin-source");
        // Both registrations run in the background at once; wait for them together.
        const [hidden, own] = yield* Effect.all(
          [
            registered(actors.owner, ownerSource, "active"),
            registered(actors.admin, memberAccount, "active"),
          ],
          { concurrency: "unbounded" },
        );
        yield* ok(yield* unlink(actors.admin, "token", token));

        const removers =
          "Ask the person it runs as, or a manager of its app who can use its source account, to remove it.";
        // The admin sees only their own subscription, since the owner's runs with the owner's
        // account; the refusal names only that one and counts the owner's.
        expect((yield* webhookSubscriptions(actors.admin, path)).map((hook) => hook.id)).toEqual([
          own.id,
        ]);
        const partly = yield* refusal(token);
        expect(partly.message).toContain(`${app.id}/${own.id} (active)`);
        expect(partly.text).not.toContain(hidden.id);
        expect(partly.message).toContain(
          `1 webhook subscription you can't see also uses it. ${removers}`,
        );

        // Once the admin, demoted to a member, can't see the app, the refusal names neither it nor
        // its subscriptions.
        yield* ok(
          yield* api.request(
            actors.admin,
            "DELETE",
            `${path}/accounts/user/source/${memberAccount}`,
          ),
        );
        yield* registered(actors.admin, memberAccount, "stopped");
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        const membership = (yield* okBody(
          Members,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${actors.organization.id}`,
          ),
        )).members.find((item) => item.user.email === user.email);
        if (membership === undefined) return yield* Effect.die("The admin's membership is missing");
        const setRole = (role: "admin" | "member") =>
          api
            .request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
              organizationId: actors.organization.id,
              memberId: membership.id,
              role,
            })
            .pipe(Effect.flatMap(ok));
        yield* Effect.addFinalizer(() => setRole("admin").pipe(Effect.orDie));
        yield* setRole("member");
        const access = yield* okBody(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        yield* ok(
          yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "groups", groups: [] },
          }),
        );
        expect((yield* api.request(actors.admin, "GET", `${path}/webhooks`)).status).toBe(403);
        const hiddenApp = yield* refusal(token);
        expect(hiddenApp.text).not.toContain(app.id);
        expect(hiddenApp.text).not.toContain("whk_");
        expect(hiddenApp.message).toContain(
          `1 webhook subscription you can't see uses this account, so it can't be deleted. ${removers}`,
        );

        // The hidden subscription still holds the token until its owner removes it.
        yield* ok(
          yield* api.request(actors.owner, "DELETE", `${path}/accounts/user/source/${ownerSource}`),
        );
        yield* registered(actors.owner, ownerSource, "stopped");
        yield* ok(yield* remove(token));
      }),
    ),
  );
});
