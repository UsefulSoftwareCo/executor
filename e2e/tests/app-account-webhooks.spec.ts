/**
 * An account linked to an app's own requirements is the app's webhook source without an actor. It
 * serves the webhooks of the requirements it is linked to, also while members link it for
 * themselves, and its registrations are removed with its last app link.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  linkAccount,
  linkAccountResponse,
  unlinkAccount,
  unlinkAccountResponse,
  type LinkScope,
} from "../support/app-accounts.ts";
import { appLinksFixture, keyProvider, ok, okBody, refused } from "../support/app-links.ts";
import {
  settleWebhookSources,
  settleWebhookSubscriptions,
  type WebhookSubscriptionRow,
} from "../support/webhook-sources.ts";
import {
  userWebhookRequirements,
  userWebhookRequirementsSource,
} from "../support/user-webhook-requirements.ts";
import { scenarios } from "../test-plan.ts";

/**
 * Two app requirements with a webhook each, and a user requirement of the same provider with its
 * own webhook. Each handler reports whether its context has a caller and which accounts it got.
 */
const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("App webhook fixture")};
const hook = (account) => ({ account, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {},
  handle: async (ctx) => Response.json({ user: "user" in ctx,
    first: ctx.app.accounts.first.map((item) => item.id), second: ctx.app.accounts.second.map((item) => item.id) }) });
export default defineApp({ app: { accounts: { first: team.many(), second: team.many() } }, user: { accounts: { personal: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
    webhooks: { firstHook: hook({ app: "first" }), secondHook: hook({ app: "second" }), personalHook: hook({ user: "personal" }) } }));`;
/**
 * One app requirement whose webhook's unregistration needs the linked account, so a registration
 * is removed only while the app could still use it.
 */
const removalSource = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("App webhook removal fixture")};
const incoming = { account: { app: "team" }, config: object({}), state: object({}),
  register: async () => ({}),
  unregister: async (ctx) => { if (ctx.app.accounts.team.length === 0) throw new Error("No linked account to unregister with"); },
  handle: async (ctx) => Response.json({ accounts: ctx.app.accounts.team.map((item) => item.id) }) };
export default defineApp({ app: { accounts: { team: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { incoming } }));`;
/** An app requirement and a user requirement, each with a webhook registered by hand. */
const manualSource = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("Manual webhook fixture")};
const manual = (account) => ({ account, config: object({}), state: object({}),
  setup: { instructions: "Paste the callback URL into the provider's webhook settings.", signingSecret: "executor" },
  handle: async () => Response.json({ received: true }) });
export default defineApp({ app: { accounts: { team: team.many() } }, user: { accounts: { personal: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
    webhooks: { appHook: manual({ app: "team" }), personalHook: manual({ user: "personal" }) } }));`;
const Configure = Schema.Struct({ step: Schema.Literal("configure"), revision: Schema.String });
const Subscription = Schema.Struct({ id: Schema.String, status: Schema.String });
const Delivered = Schema.Struct({
  user: Schema.Boolean,
  first: Schema.Array(Schema.String),
  second: Schema.Array(Schema.String),
});
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

layer(HostedLive, { excludeTestServices: true })("App account webhooks", (it) => {
  it.effect(scenarios.hostedAppAccountWebhooks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, path, ids, connect } = fixture;
        /** Link or unlink an account for an app requirement, or for the actor's own. */
        const link = (actor: Session, scope: LinkScope, requirement: string, account: string) =>
          linkAccountResponse(actor, path, requirement, account, scope).pipe(Effect.flatMap(ok));
        const unlink = (actor: Session, scope: LinkScope, requirement: string, account: string) =>
          unlinkAccountResponse(actor, path, requirement, account, scope).pipe(Effect.flatMap(ok));
        /** The account's only source, once it runs as `actor` (null for its app link) and is ready. */
        const sourceRunsAs = (account: string, actor: string | null) =>
          settleWebhookSources(actors.owner, path, (sources) => {
            const of = sources.filter((item) => item.account === account);
            return of.length === 1 && of[0]?.actor === actor && of[0].status === "ready";
          });
        /** The names of the account's live subscriptions. */
        const liveNames = (account: string) =>
          settleWebhookSubscriptions(actors.owner, path, () => true).pipe(
            Effect.map((hooks) =>
              hooks
                .filter((hook) => hook.sourceAccount === account && hook.status !== "stopped")
                .map((hook) => hook.name)
                .sort(),
            ),
          );
        /** The account's live subscription to `name`, once `settled` accepts it. */
        const live = (
          name: string,
          account: string,
          settled: (hook: WebhookSubscriptionRow) => boolean,
        ) =>
          settleWebhookSubscriptions(actors.owner, path, (hooks) =>
            hooks.some(
              (hook) =>
                hook.name === name &&
                hook.sourceAccount === account &&
                hook.status !== "stopped" &&
                settled(hook),
            ),
          ).pipe(
            Effect.map((hooks) =>
              hooks.find(
                (hook) =>
                  hook.name === name && hook.sourceAccount === account && hook.status !== "stopped",
              ),
            ),
            Effect.flatMap((hook) =>
              hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
            ),
          );
        const stopped = (name: string, account: string) =>
          settleWebhookSubscriptions(
            actors.owner,
            path,
            (hooks) =>
              hooks.some(
                (hook) =>
                  hook.name === name && hook.sourceAccount === account && hook.status === "stopped",
              ) &&
              !hooks.some(
                (hook) =>
                  hook.name === name && hook.sourceAccount === account && hook.status !== "stopped",
              ),
          );
        /** Deliver an anonymous callback and decode what the handler received. */
        const deliver = (hook: WebhookSubscriptionRow) =>
          Effect.gen(function* () {
            const delivered = yield* api.request(
              yield* api.session(),
              "POST",
              new URL(hook.callbackUrl).pathname,
              {},
            );
            expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
            return yield* body(Delivered, delivered);
          });

        // Connecting a shared account for the first app requirement links it for the app, which
        // makes it the app's source without an actor. Only the first requirement's webhook
        // registers.
        const team = yield* connect(actors.owner, "app", "first", "team-key", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        yield* settleWebhookSources(
          actors.owner,
          path,
          (sources) =>
            sources.length === 1 &&
            sources[0]?.account === team &&
            sources[0].actor === null &&
            sources[0].status === "ready",
        );
        const first = yield* live("firstHook", team, (hook) => hook.status === "active");
        expect(first.actor).toBeNull();
        expect(
          (yield* settleWebhookSubscriptions(actors.owner, path, () => true)).filter(
            (hook) => hook.name !== "firstHook" && hook.status !== "stopped",
          ),
        ).toEqual([]);
        // A delivery reaches its handler without a caller, with the app's linked accounts.
        expect(yield* deliver(first)).toEqual({ user: false, first: [team], second: [] });

        // Linking the same account to the second requirement registers that webhook on the same
        // source; unlinking it from the first stops only the first requirement's webhook.
        yield* link(actors.owner, "app", "second", team);
        const second = yield* live("secondHook", team, (hook) => hook.status === "active");
        expect(second.actor).toBeNull();
        expect(yield* deliver(second)).toEqual({ user: false, first: [team], second: [team] });
        yield* unlink(actors.owner, "app", "first", team);
        yield* stopped("firstHook", team);
        const kept = yield* live("secondHook", team, (hook) => hook.status === "active");
        expect(kept.id).toBe(second.id);
        expect(yield* deliver(kept)).toEqual({ user: false, first: [], second: [team] });

        // The same account may be linked in both scopes. A member linking the app's account for
        // themselves leaves it one source, serving as its app link: no user webhook registers.
        yield* link(actors.member, "user", "personal", team);
        yield* sourceRunsAs(team, null);
        expect(yield* liveNames(team)).toEqual(["secondHook"]);
        expect(yield* deliver(kept)).toEqual({ user: false, first: [], second: [team] });
        // Linking a member's own account for the app as well moves its source to the app link:
        // the member's webhook stops and the app requirement's registers without an actor.
        const personal = yield* connect(actors.member, "user", "personal", "member-key", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        const own = yield* live("personalHook", personal, (hook) => hook.status === "active");
        expect(own.actor).toBe(ids.member);
        yield* sourceRunsAs(personal, ids.member);
        yield* link(actors.owner, "app", "first", personal);
        yield* stopped("personalHook", personal);
        yield* live(
          "firstHook",
          personal,
          (hook) => hook.status === "active" && hook.actor === null,
        );
        yield* sourceRunsAs(personal, null);
        expect(yield* liveNames(personal)).toEqual(["firstHook"]);

        // Unlinking the app link hands the source back to the member who still links the account:
        // the app requirement's webhook stops and the member's registers, running as the member.
        yield* unlink(actors.owner, "app", "first", personal);
        yield* stopped("firstHook", personal);
        const handed = yield* live(
          "personalHook",
          personal,
          (hook) => hook.status === "active" && hook.actor === ids.member,
        );
        expect(handed.id).not.toBe(own.id);
        yield* sourceRunsAs(personal, ids.member);
        expect(yield* liveNames(personal)).toEqual(["personalHook"]);
        // The app's account goes the same way when its last app link goes.
        yield* unlink(actors.owner, "app", "second", team);
        yield* stopped("secondHook", team);
        yield* live(
          "personalHook",
          team,
          (hook) => hook.status === "active" && hook.actor === ids.member,
        );
        yield* sourceRunsAs(team, ids.member);
        expect(yield* liveNames(team)).toEqual(["personalHook"]);
        // Unlinking the member's links too removes each source and stops its webhook. An app is
        // removed only once its webhooks stopped.
        yield* unlink(actors.member, "user", "personal", team);
        yield* stopped("personalHook", team);
        yield* unlink(actors.member, "user", "personal", personal);
        yield* stopped("personalHook", personal);
        yield* settleWebhookSources(actors.owner, path, (sources) => sources.length === 0);
      }),
    ),
  );
  it.effect(scenarios.hostedAppAccountWebhookRemoval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: removalSource }]);
        const { api, actors, prefix, app, path, connect, unlink } = fixture;
        const subscription = (account: string, status: string) =>
          settleWebhookSubscriptions(actors.owner, path, (hooks) =>
            hooks.some(
              (hook) =>
                hook.sourceAccount === account && hook.status === status && hook.failure === null,
            ),
          ).pipe(
            Effect.map((hooks) =>
              hooks.find((hook) => hook.sourceAccount === account && hook.status === status),
            ),
            Effect.flatMap((hook) =>
              hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
            ),
          );

        // The owner's own account: unlinking unregisters with it, since the app could still use it.
        const own = yield* connect(actors.owner, "app", "team", "owner-team");
        yield* subscription(own, "active");
        yield* ok(yield* unlink(actors.owner, "team", own));
        yield* subscription(own, "stopped");
        yield* settleWebhookSources(actors.owner, path, (sources) => sources.length === 0);

        // A shared account stays usable after it is unlinked, so its registration is removed too.
        const shared = yield* connect(actors.owner, "app", "team", "shared-team", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        yield* subscription(shared, "active");
        yield* ok(yield* unlink(actors.owner, "team", shared));
        yield* subscription(shared, "stopped");

        // The admin links their personal account and then leaves the organization. The app could
        // no longer use it, so removing its registration is refused: the subscription waits,
        // disabled, until a manager confirms it was removed at the provider.
        const departed = yield* connect(actors.admin, "app", "team", "admin-team");
        const registered = yield* subscription(departed, "active");
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
        yield* ok(yield* unlink(actors.owner, "team", departed));
        const disabled = yield* subscription(departed, "disabled");
        expect(disabled.id).toBe(registered.id);
        // The app's manager can open its setup, which asks them to remove it at the provider.
        const setup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/webhook-setup/${app.id}/${registered.id}`,
        );
        expect(setup.status, JSON.stringify(setup.body)).toBe(200);
        expect(setup.body).toMatchObject({ step: "remove", subscription: { id: registered.id } });
        const confirmed = yield* api.request(
          actors.owner,
          "POST",
          `${path}/webhooks/${registered.id}/confirm-removal`,
        );
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
        expect(confirmed.body).toMatchObject({ id: registered.id, status: "stopped" });
        yield* settleWebhookSources(actors.owner, path, (sources) => sources.length === 0);
      }),
    ),
  );
  it.effect(scenarios.hostedAppAccountWebhookManualSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: manualSource }]);
        const { api, actors, prefix, app, path, connect } = fixture;
        const setupPath = (subscription: string) =>
          `${prefix}/webhook-setup/${app.id}/${subscription}`;
        /** The subscription of `name` that `actor` sees for `account`, once it has `status`. */
        const subscription = (actor: Session, name: string, account: string, status: string) =>
          settleWebhookSubscriptions(actor, path, (hooks) =>
            hooks.some(
              (hook) =>
                hook.name === name && hook.sourceAccount === account && hook.status === status,
            ),
          ).pipe(
            Effect.map((hooks) =>
              hooks.find((hook) => hook.name === name && hook.sourceAccount === account),
            ),
            Effect.flatMap((hook) =>
              hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
            ),
          );

        // The admin links their personal account for the app, which only they may use. Its webhook
        // is the app's, without an actor, and waits for setup by hand.
        const adminAccount = yield* connect(actors.admin, "app", "team", "admin-team");
        const appHook = yield* subscription(
          actors.owner,
          "appHook",
          adminAccount,
          "setup-required",
        );
        expect(appHook.actor).toBeNull();
        // The owner manages the app without using the account, and sets the webhook up.
        const opened = yield* okBody(
          Configure,
          yield* api.request(actors.owner, "GET", setupPath(appHook.id)),
        );
        const completed = yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(appHook.id), {
            revision: opened.revision,
            state: {},
          }),
        );
        expect(completed).toMatchObject({ id: appHook.id, status: "active" });
        // They remove it, then confirm it was removed at the provider.
        const removed = yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "DELETE", setupPath(appHook.id)),
        );
        expect(removed).toMatchObject({ id: appHook.id, status: "disabled" });
        const confirmed = yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", `${setupPath(appHook.id)}/confirm-removal`),
        );
        expect(confirmed).toMatchObject({ id: appHook.id, status: "stopped" });

        // A member's own webhook stays theirs: managing the app does not open its setup without
        // use of the member's account.
        const memberAccount = yield* connect(actors.member, "user", "personal", "member-key");
        const personalHook = yield* subscription(
          actors.member,
          "personalHook",
          memberAccount,
          "setup-required",
        );
        expect(personalHook.actor).not.toBeNull();
        yield* refused(
          yield* api.request(actors.owner, "GET", setupPath(personalHook.id)),
          403,
          "OrganizationForbidden",
        );
        yield* refused(
          yield* api.request(actors.owner, "POST", setupPath(personalHook.id), {
            revision: (yield* okBody(
              Configure,
              yield* api.request(actors.member, "GET", setupPath(personalHook.id)),
            )).revision,
            state: {},
          }),
          403,
          "OrganizationForbidden",
        );
        yield* refused(
          yield* api.request(actors.owner, "DELETE", setupPath(personalHook.id)),
          403,
          "OrganizationForbidden",
        );
        yield* refused(
          yield* api.request(actors.owner, "POST", `${setupPath(personalHook.id)}/confirm-removal`),
          403,
          "OrganizationForbidden",
        );
        // The member removes their own, which lets the app be removed.
        expect(
          yield* okBody(
            Subscription,
            yield* api.request(actors.member, "DELETE", setupPath(personalHook.id)),
          ),
        ).toMatchObject({ status: "disabled" });
        expect(
          yield* okBody(
            Subscription,
            yield* api.request(
              actors.member,
              "POST",
              `${setupPath(personalHook.id)}/confirm-removal`,
            ),
          ),
        ).toMatchObject({ status: "stopped" });
      }),
    ),
  );
  it.effect(scenarios.hostedUserWebhookRequirements.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connect } = yield* appLinksFixture([
          {
            path: "index.ts",
            content: userWebhookRequirementsSource(keyProvider("User webhook fixture")),
          },
        ]);
        yield* userWebhookRequirements({
          reader: actors.member,
          appPath: path,
          actor: ids.member,
          add: (requirement, token) => connect(actors.member, "user", requirement, token),
          link: (requirement, account) =>
            linkAccount(actors.member, path, requirement, account, "user"),
          unlink: (requirement, account) =>
            unlinkAccount(actors.member, path, requirement, account, "user"),
        });
      }),
    ),
  );
});
