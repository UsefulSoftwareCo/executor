/**
 * An account linked to an app's own requirements is the app's webhook source without an actor. It
 * serves the webhooks of the requirements it is linked to, also while its owner links it for
 * themselves, and its registrations are removed with its last app link.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Option, Schedule, Schema } from "effect";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
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
import { appsManifest } from "../support/apps-release.ts";
import { webhookRegistrationFixture } from "../support/webhook-registration.ts";
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
/** Provider registration URLs for webhooks that register before and after the manual one. */
interface Around {
  readonly before: string;
  readonly after: string;
}
/**
 * One app-account webhook registered by hand, whose handler reports its code's `release` and
 * whether the request carried the subscription's secret. `signingSecret` is the setup's, and
 * `state` the source of the schema of the fields a person enters during setup, and `config` of its
 * configuration's. With `around`, it is declared between two webhooks whose registrations call
 * those URLs, so a scenario can hold a source's reconciliation before and after it reaches the
 * manual one; their handlers report `release` too.
 */
const carriedSource = (
  release: string,
  signingSecret: "executor" | "provider",
  state = "object({})",
  around?: Around,
  config = "object({})",
) =>
  `import { defineApp, defineProvider, secrets, query, object, string, number, json, jsonSchema, router } from "apps";
const team = ${keyProvider("Carried webhook fixture")};
const inbound = { account: { app: "team" }, config: ${config}, state: ${state},
  setup: { instructions: ${JSON.stringify(`Paste the callback URL into the provider (${release}).`)}, signingSecret: ${JSON.stringify(signingSecret)} },
  handle: async (ctx, { request, secret }) => Response.json({ release: ${JSON.stringify(release)}, signed: request.headers.get("x-secret") === secret }) };
const registered = (url) => ({ account: { app: "team" }, config: object({}), state: object({}),
  register: async (ctx) => { const response = await ctx.fetch(url, { method: "POST" }); if (!response.ok) throw new Error("Registration failed"); return {}; },
  unregister: async () => {},
  handle: async () => Response.json({ release: ${JSON.stringify(release)} }) });
export default defineApp({ app: { accounts: { team: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
    webhooks: ${around === undefined ? "{ inbound }" : `{ before: registered(${JSON.stringify(around.before)}), inbound, after: registered(${JSON.stringify(around.after)}) }`} }));`;
const Configure = Schema.Struct({ step: Schema.Literal("configure"), revision: Schema.String });
const ConfigureWithSecret = Schema.Struct({
  step: Schema.Literal("configure"),
  revision: Schema.String,
  signingSecret: Schema.Struct({ source: Schema.Literal("executor"), value: Schema.String }),
});
const StateSchemaSetup = Schema.Struct({
  ...ConfigureWithSecret.fields,
  stateSchema: Schema.Json,
});
const Pinned = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  status: Schema.String,
  callbackUrl: Schema.String,
});
const Deployed = Schema.Struct({ version: Schema.Struct({ id: Schema.String }) });
const Released = Schema.Struct({ release: Schema.String, signed: Schema.Boolean });
const RegisteredRelease = Schema.Struct({ release: Schema.String });
/** `WebhookFailed` as clients and Executor apps holding an earlier API document decode it. */
const EarlierWebhookFailed = Schema.Struct({
  _tag: Schema.Literal("WebhookFailed"),
  reason: Schema.Literals(["unavailable", "definition", "input", "delivery", "inactive"]),
  message: Schema.String,
});
const ActiveVersion = Schema.Struct({ activeVersion: Schema.String });
const Subscription = Schema.Struct({ id: Schema.String, status: Schema.String });
const Delivered = Schema.Struct({
  user: Schema.Boolean,
  first: Schema.Array(Schema.String),
  second: Schema.Array(Schema.String),
});
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

/** Deploys of the carried-webhook app, and reads and deliveries of its subscriptions. */
const carriedWebhook = (fixture: Effect.Success<ReturnType<typeof appLinksFixture>>) => {
  const { api, actors, prefix, app, path } = fixture;
  const setupPath = (subscription: string) => `${prefix}/webhook-setup/${app.id}/${subscription}`;
  const subscriptions = Effect.gen(function* () {
    return (yield* okBody(
      Schema.Array(Pinned),
      yield* api.request(actors.owner, "GET", `${path}/webhooks`),
    )).filter((row) => row.status !== "stopped");
  });
  const deploy = (
    release: string,
    signingSecret: "executor" | "provider",
    state?: string,
    around?: Around,
    config?: string,
  ) =>
    api
      .request(actors.owner, "POST", `${path}/deploy`, {
        files: [
          {
            path: "index.ts",
            content: carriedSource(release, signingSecret, state, around, config),
          },
          appsManifest,
        ],
      })
      .pipe(
        Effect.flatMap((response) => okBody(Deployed, response)),
        Effect.map(({ version }) => version.id),
      );
  /**
   * The app's subscriptions that are not stopped, once one is `status` (or any status) on `version`
   * and every one still delivering is pinned to it: reconciliation creates or moves a version's
   * subscription before it disables the ones that version replaced.
   */
  const pinnedTo = (version: string, status?: string) =>
    Effect.gen(function* () {
      for (;;) {
        const rows = yield* subscriptions;
        if (
          rows.some(
            (row) => row.version === version && (status === undefined || row.status === status),
          ) &&
          rows.every((row) => row.status === "disabled" || row.version === version)
        )
          return rows;
        yield* Effect.sleep("100 millis");
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.die(new Error(`No subscription is ${status ?? "pinned"} on ${version}`)),
      }),
    );
  /** A provider's delivery to a callback URL, signed with `secret`. */
  const post = (callbackUrl: string, secret: string) =>
    Effect.gen(function* () {
      return yield* api.request(
        yield* api.session(),
        "POST",
        new URL(callbackUrl).pathname,
        {},
        { "x-secret": secret },
      );
    });
  const deliver = (callbackUrl: string, secret: string) =>
    post(callbackUrl, secret).pipe(Effect.flatMap((response) => okBody(Released, response)));
  /** Activate `version` while `expectedVersion` is active. */
  const activate = (version: string, expectedVersion: string) =>
    Effect.gen(function* () {
      yield* ok(
        yield* api.request(actors.owner, "POST", `${path}/activate`, { version, expectedVersion }),
      );
    });
  /** Removing every subscription by hand, and confirming it at the provider, lets the app go. */
  const removeAll = Effect.gen(function* () {
    for (const row of yield* subscriptions) {
      if (row.status !== "disabled")
        expect(
          yield* okBody(
            Subscription,
            yield* api.request(actors.owner, "DELETE", setupPath(row.id)),
          ),
        ).toMatchObject({ status: "disabled" });
      expect(
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", `${setupPath(row.id)}/confirm-removal`),
        ),
      ).toMatchObject({ status: "stopped" });
    }
  });
  /**
   * Deploys `state` and `config` twice, the second time with only the handler changed, and expects
   * the second deploy to replace the subscription the first gave instead of keeping it: a setup too
   * deep or too long to compare counts as changed, as every deploy did before setups were carried.
   * The source settles instead of staying pending.
   */
  const redeployReplaces = (release: string, state: string, config?: string) =>
    Effect.gen(function* () {
      const [replaced] = (yield* pinnedTo(
        yield* deploy(`${release}-before`, "executor", state, undefined, config),
        "setup-required",
      )).filter((row) => row.status === "setup-required");
      if (replaced === undefined) return yield* Effect.die(new Error("Webhook missing"));
      const redeployed = yield* pinnedTo(
        yield* deploy(release, "executor", state, undefined, config),
        "setup-required",
      );
      expect(redeployed.find((row) => row.id === replaced.id)?.status).toBe("disabled");
      const live = redeployed.filter((row) => row.status !== "disabled");
      expect(live.map((row) => row.status)).toEqual(["setup-required"]);
      const [replacement] = live;
      if (replacement === undefined) return yield* Effect.die(new Error("Replacement missing"));
      expect(replacement.id).not.toBe(replaced.id);
      yield* settleWebhookSources(
        actors.owner,
        path,
        (sources) =>
          sources.length === 1 &&
          sources[0]?.status === "failed" &&
          sources[0]?.failure === "cleanup",
      );
      const opened = yield* okBody(
        ConfigureWithSecret,
        yield* api.request(actors.owner, "GET", setupPath(replacement.id)),
      );
      expect(yield* deliver(replacement.callbackUrl, opened.signingSecret.value)).toEqual({
        release,
        signed: true,
      });
      expect((yield* post(replaced.callbackUrl, opened.signingSecret.value)).status).toBe(410);
    });
  return {
    setupPath,
    subscriptions,
    deploy,
    pinnedTo,
    post,
    deliver,
    activate,
    removeAll,
    redeployReplaces,
  };
};

/**
 * The first webhook app with its fixture, and the waits and steps its scenarios read webhooks
 * through: a link or unlink in either scope, an account's one source and live subscriptions, and
 * an anonymous delivery.
 */
const appAccountHooks = Effect.gen(function* () {
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
  return {
    fixture,
    api,
    actors,
    path,
    ids,
    connect,
    link,
    unlink,
    sourceRunsAs,
    liveNames,
    live,
    stopped,
    deliver,
  };
});

layer(HostedLive, { excludeTestServices: true })("App account webhooks", (it) => {
  it.effect(scenarios.hostedAppAccountWebhooks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, connect, link, live, deliver } = yield* appAccountHooks;
        // Connecting the owner's account for the first app requirement links it for the app, which
        // makes it the app's source without an actor. Only the first requirement's webhook
        // registers.
        const team = yield* connect(actors.owner, "app", "first", "team-key");
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
        // source.
        yield* link(actors.owner, "app", "second", team);
        const second = yield* live("secondHook", team, (hook) => hook.status === "active");
        expect(second.actor).toBeNull();
        expect(yield* deliver(second)).toEqual({ user: false, first: [team], second: [team] });
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountWebhookUnlinkOne.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, connect, link, unlink, live, stopped, deliver } = yield* appAccountHooks;
        // One account linked for both app requirements, both webhooks registered on its source.
        const team = yield* connect(actors.owner, "app", "first", "team-key");
        yield* link(actors.owner, "app", "second", team);
        const [, second] = yield* Effect.all(
          [
            live("firstHook", team, (hook) => hook.status === "active"),
            live("secondHook", team, (hook) => hook.status === "active"),
          ],
          { concurrency: "unbounded" },
        );
        // Unlinking it from the first requirement stops only that requirement's webhook.
        yield* unlink(actors.owner, "app", "first", team);
        yield* stopped("firstHook", team);
        const kept = yield* live("secondHook", team, (hook) => hook.status === "active");
        expect(kept.id).toBe(second.id);
        expect(yield* deliver(kept)).toEqual({ user: false, first: [], second: [team] });
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountWebhookCommandSpans.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { fixture, actors, connect, unlink, live, stopped, deliver } = yield* appAccountHooks;
        // One registration, one delivery and one unregistration.
        const team = yield* connect(actors.owner, "app", "first", "team-key");
        const first = yield* live("firstHook", team, (hook) => hook.status === "active");
        expect(yield* deliver(first)).toEqual({ user: false, first: [team], second: [] });
        yield* unlink(actors.owner, "app", "first", team);
        yield* stopped("firstHook", team);

        // Each webhook command's runtime span names its app and the part of the webhook's life it
        // ran, so one app's failing handler can be told from the runtime's failures.
        const telemetry = yield* Telemetry,
          evidence = yield* Evidence,
          target = yield* Target;
        const runtime = target.metadata.target === "cloud" ? "runtime.cloud" : "runtime.workerd";
        const operations = yield* telemetry
          .spans(`${runtime}.webhook`, { app: fixture.app.id })
          .pipe(
            Effect.map((spans) => spans.map((tags) => tags["executor.webhook.operation"])),
            Effect.flatMap((operations) =>
              operations.filter((operation) => operation === "handle").length >= 1 &&
              operations.includes("register") &&
              operations.includes("unregister")
                ? Effect.succeed(operations)
                : Effect.fail(new Error("The webhook commands' spans have not all arrived")),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
        yield* evidence.json("webhook-commands.json", operations);
        expect(
          operations.filter((operation) => operation === "handle"),
          "One span for each delivery",
        ).toHaveLength(1);
        for (const operation of operations)
          expect([
            "definitions",
            "validate",
            "complete",
            "register",
            "unregister",
            "handle",
          ]).toContain(operation);
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountWebhookBothScopes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, connect, link, unlink, sourceRunsAs, liveNames, live, deliver } =
          yield* appAccountHooks;
        // An app link of the owner's key for the second requirement, its webhook registered.
        const team = yield* connect(actors.owner, "app", "second", "team-key");
        const kept = yield* live("secondHook", team, (hook) => hook.status === "active");
        // Only the account's owner links it for themselves: a member cannot link it.
        yield* refused(
          yield* linkAccountResponse(actors.member, path, "personal", team, "user"),
          403,
          "OrganizationForbidden",
        );
        // The same account may be linked in both scopes. The owner linking the app's account for
        // themselves leaves it one source, serving as its app link: no user webhook registers.
        yield* link(actors.owner, "user", "personal", team);
        yield* sourceRunsAs(team, null);
        expect(yield* liveNames(team)).toEqual(["secondHook"]);
        expect(yield* deliver(kept)).toEqual({ user: false, first: [], second: [team] });
        // The owner's own link goes too, so only the app link remains for the fixture to release.
        yield* unlink(actors.owner, "user", "personal", team);
        expect(yield* liveNames(team)).toEqual(["secondHook"]);
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountWebhookMovesSource.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, ids, connect, link, unlink, sourceRunsAs, liveNames, live, stopped } =
          yield* appAccountHooks;
        // Linking an account the owner linked for themselves for the app as well moves its source
        // to the app link: the owner's webhook stops and the app requirement's registers without
        // an actor.
        const personal = yield* connect(actors.owner, "user", "personal", "owner-key");
        const own = yield* live("personalHook", personal, (hook) => hook.status === "active");
        expect(own.actor).toBe(ids.owner);
        yield* sourceRunsAs(personal, ids.owner);
        yield* link(actors.owner, "app", "first", personal);
        yield* stopped("personalHook", personal);
        yield* live(
          "firstHook",
          personal,
          (hook) => hook.status === "active" && hook.actor === null,
        );
        yield* sourceRunsAs(personal, null);
        expect(yield* liveNames(personal)).toEqual(["firstHook"]);

        // Unlinking the app link hands the source back to the owner, who still links the account:
        // the app requirement's webhook stops and the owner's registers, running as the owner.
        yield* unlink(actors.owner, "app", "first", personal);
        yield* stopped("firstHook", personal);
        const handed = yield* live(
          "personalHook",
          personal,
          (hook) => hook.status === "active" && hook.actor === ids.owner,
        );
        expect(handed.id).not.toBe(own.id);
        yield* sourceRunsAs(personal, ids.owner);
        expect(yield* liveNames(personal)).toEqual(["personalHook"]);
        // The owner's own link goes too, so nothing remains for the fixture to release.
        yield* unlink(actors.owner, "user", "personal", personal);
        yield* stopped("personalHook", personal);
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountWebhookHandBack.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connect, link, unlink, sourceRunsAs, liveNames, live, stopped } =
          yield* appAccountHooks;
        // An app link of the owner's key for the second requirement, its webhook registered.
        const team = yield* connect(actors.owner, "app", "second", "team-key");
        yield* live("secondHook", team, (hook) => hook.status === "active");
        // The owner links it for themselves too; it stays one source, serving its app link.
        yield* link(actors.owner, "user", "personal", team);
        yield* sourceRunsAs(team, null);
        // The app's account goes the same way when its last app link goes.
        yield* unlink(actors.owner, "app", "second", team);
        yield* stopped("secondHook", team);
        yield* live(
          "personalHook",
          team,
          (hook) => hook.status === "active" && hook.actor === ids.owner,
        );
        yield* sourceRunsAs(team, ids.owner);
        expect(yield* liveNames(team)).toEqual(["personalHook"]);
        // Unlinking the owner's own links too removes each source and stops its webhook. An app is
        // removed only once its webhooks stopped.
        yield* unlink(actors.owner, "user", "personal", team);
        yield* stopped("personalHook", team);
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
        // Finishing the setup runs the admin's source, which is ready once it finds it active.
        yield* settleWebhookSources(actors.owner, path, (sources) =>
          sources.some((source) => source.account === adminAccount && source.status === "ready"),
        );
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
  it.effect(scenarios.hostedManualWebhookAcrossDeploys.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: carriedSource("first", "executor") },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver, removeAll } = carriedWebhook(fixture);

        // Linking an account for the app creates its manual subscription, waiting for setup.
        const account = yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );

        // A deploy that keeps the setup keeps the subscription waiting for it: the same callback
        // URL and generated secret, so a setup the person already started at the provider holds,
        // and the page they opened before the deploy still completes it.
        const second = yield* deploy("second", "executor");
        const waiting = yield* pinnedTo(second, "setup-required");
        expect(waiting.map((row) => row.id)).toEqual([first.id]);
        const reopened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );
        expect(reopened.signingSecret.value).toBe(opened.signingSecret.value);
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: {},
          }),
        );
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "second",
          signed: true,
        });

        // A completed setup stays active on the next deploy, and the new code handles its
        // deliveries at the URL the provider already has.
        const third = yield* deploy("third", "executor");
        const active = yield* pinnedTo(third, "active");
        expect(active.map((row) => row.id)).toEqual([first.id]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "third",
          signed: true,
        });

        // A caller cannot create an app-account webhook's subscription; the refusal says the
        // app's link creates it instead of reporting a generic mismatch.
        const explicit = yield* api.request(actors.owner, "POST", `${path}/webhooks`, {
          key: "explicit",
          name: "inbound",
          sourceAccount: account,
          config: {},
        });
        const created = yield* refused(explicit, 422, "WebhookFailed");
        expect(created.reason).toBe("input");
        // Clients and Executor apps holding an earlier document still decode the refusal, which
        // they check as a closed object, and get its explanation.
        const earlier = Schema.decodeUnknownOption(EarlierWebhookFailed, {
          onExcessProperty: "error",
        })(explicit.body);
        expect(Option.getOrUndefined(earlier)?.message).toMatch(
          /source is an app account, so a caller cannot create its subscription/,
        );

        // A deploy whose setup takes the secret from the provider instead cannot keep the setup:
        // it needs a new one, and the old subscription waits for removal at the provider.
        const fourth = yield* deploy("fourth", "provider");
        const replaced = yield* pinnedTo(fourth, "setup-required");
        expect(replaced.find((row) => row.id === first.id)?.status).toBe("disabled");
        expect(replaced.filter((row) => row.id !== first.id).map((row) => row.status)).toEqual([
          "setup-required",
        ]);
        yield* removeAll;
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookRollback.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: carriedSource("first", "executor") },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver, activate, removeAll } =
          carriedWebhook(fixture);
        const original = yield* okBody(
          ActiveVersion,
          yield* api.request(actors.owner, "GET", path),
        );
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: {},
          }),
        );
        yield* deploy("second", "executor");
        const third = yield* deploy("third", "executor");
        expect((yield* pinnedTo(third, "active")).map((row) => row.id)).toEqual([first.id]);

        // Activating the first version again moves the subscription back to it: the provider's
        // deliveries reach the code that is active, not the later code that carried it.
        yield* activate(original.activeVersion, third);
        const rolledBack = yield* pinnedTo(original.activeVersion, "active");
        expect(rolledBack.map((row) => row.id)).toEqual([first.id]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "first",
          signed: true,
        });

        // And forward again, to the version that carried it before.
        yield* activate(third, original.activeVersion);
        const restored = yield* pinnedTo(third, "active");
        expect(restored.map((row) => row.id)).toEqual([first.id]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "third",
          signed: true,
        });
        yield* removeAll;
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookStateSchema.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const declared = "object({ alpha: string(), beta: string() })";
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: carriedSource("first", "executor", declared) },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver, removeAll } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );

        // Declaring the same fields in another order accepts the same entries, so the setup holds.
        const reordered = yield* deploy(
          "reordered",
          "executor",
          "object({ beta: string(), alpha: string() })",
        );
        expect((yield* pinnedTo(reordered, "setup-required")).map((row) => row.id)).toEqual([
          first.id,
        ]);
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: { alpha: "a", beta: "b" },
          }),
        );
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "reordered",
          signed: true,
        });

        // A change to what the fields accept needs a new setup, in either direction: each of these
        // replaces the subscription, and the one it replaces waits for removal at the provider.
        let current = first.id;
        for (const [release, state] of [
          ["optional", "object({ alpha: string(), beta: string().optional() })"],
          ["required", declared],
          ["retyped", "object({ alpha: number(), beta: string() })"],
          ["retyped-back", declared],
          ["added", "object({ alpha: string(), beta: string(), gamma: string() })"],
          ["removed", declared],
        ] as const) {
          const rows = yield* pinnedTo(yield* deploy(release, "executor", state), "setup-required");
          expect(rows.find((row) => row.id === current)?.status, release).toBe("disabled");
          const live = rows.filter((row) => row.status !== "disabled");
          expect(live.length, release).toBe(1);
          expect(live[0]?.id, release).not.toBe(current);
          current = live[0]?.id ?? current;
        }
        yield* removeAll;
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookStateReference.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        /** A state field whose schema is the first branch of an `anyOf`, named by its position. */
        const referenced = (branches: ReadonlyArray<string>) =>
          `jsonSchema(${JSON.stringify({
            type: "object",
            properties: { value: { $ref: "#/$defs/choice/anyOf/0" } },
            required: ["value"],
            additionalProperties: false,
            $defs: { choice: { anyOf: branches.map((type) => ({ type })) } },
          })})`;
        const fixture = yield* appLinksFixture([
          {
            path: "index.ts",
            content: carriedSource("first", "executor", referenced(["string", "number"])),
          },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, post, deliver } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: { value: "saved-text" },
          }),
        );
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "first",
          signed: true,
        });

        // Reversing the branches keeps the same set of schemas, but the reference now names the
        // number branch, so the entered text no longer fits: the deploy needs a new setup.
        const reordered = yield* deploy("reordered", "executor", referenced(["number", "string"]));
        const rows = yield* pinnedTo(reordered, "setup-required");
        expect(rows.find((row) => row.id === first.id)?.status).toBe("disabled");
        expect(rows.filter((row) => row.id !== first.id).map((row) => row.status)).toEqual([
          "setup-required",
        ]);
        expect((yield* post(first.callbackUrl, opened.signingSecret.value)).status).toBe(410);
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookNestedRequired.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        /** A Draft 7 state schema: once `trigger` is entered, `alpha` and `beta` are required too. */
        const dependent = (required: ReadonlyArray<string>) =>
          `jsonSchema(${JSON.stringify({
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              trigger: { type: "boolean" },
              alpha: { type: "string" },
              beta: { type: "string" },
            },
            required: ["trigger"],
            dependencies: { trigger: { required } },
            additionalProperties: false,
          })})`;
        const fixture = yield* appLinksFixture([
          {
            path: "index.ts",
            content: carriedSource("first", "executor", dependent(["alpha", "beta"])),
          },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );
        // The dependency is evaluated: without `beta` the setup is refused.
        expect(
          (yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: { trigger: true, alpha: "a" },
          })).status,
        ).toBe(422);
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: { trigger: true, alpha: "a", beta: "b" },
          }),
        );
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "first",
          signed: true,
        });

        // Listing the dependency's fields in another order accepts the same entries, so the
        // provider keeps delivering to the same callback URL, now answered by the new code.
        const reordered = yield* deploy("reordered", "executor", dependent(["beta", "alpha"]));
        expect((yield* pinnedTo(reordered)).map((row) => [row.id, row.status])).toEqual([
          [first.id, "active"],
        ]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "reordered",
          signed: true,
        });

        // The same holds wherever a schema can hold a list of field names: one schema puts a
        // `required` list in every keyword position that holds a schema, and every other list of
        // names, so reversing all of them at once keeps the setup.
        const everywhere = (names: ReadonlyArray<string>) => {
          const inner = { required: names };
          const schema = [
            "additionalItems",
            "additionalProperties",
            "contains",
            "contentSchema",
            "else",
            "if",
            "items",
            "not",
            "propertyNames",
            "then",
            "unevaluatedItems",
            "unevaluatedProperties",
          ];
          const list = ["allOf", "anyOf", "items", "oneOf", "prefixItems"];
          const map = [
            "definitions",
            "dependencies",
            "dependentSchemas",
            "patternProperties",
            "properties",
          ];
          const positions = Object.fromEntries([
            ...schema.map((keyword) => [keyword, { [keyword]: inner }]),
            ...list.map((keyword) => [`${keyword}List`, { [keyword]: [inner] }]),
            ...map.map((keyword) => [`${keyword}Map`, { [keyword]: { member: inner } }]),
            ["dependencyNames", { dependencies: { member: names } }],
            ["dependentRequired", { dependentRequired: { member: names } }],
            ["required", inner],
          ]);
          return `jsonSchema(${JSON.stringify({
            type: "object",
            properties: { alpha: { type: "string" }, beta: { type: "string" } },
            $defs: positions,
          })})`;
        };
        const listed = yield* pinnedTo(
          yield* deploy("everywhere", "executor", everywhere(["alpha", "beta"])),
          "setup-required",
        );
        const replacement = listed.find((row) => row.status === "setup-required");
        if (replacement === undefined) return yield* Effect.die(new Error("Replacement missing"));
        const reversed = yield* deploy("reversed", "executor", everywhere(["beta", "alpha"]));
        expect(
          (yield* pinnedTo(reversed))
            .filter((row) => row.status !== "disabled")
            .map((row) => [row.id, row.status]),
        ).toEqual([[replacement.id, "setup-required"]]);
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookDeepStateSchema.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        /**
         * A state schema `2 * wraps + 4` objects and lists deep through Draft 7 dependencies, one
         * more with `odd`. The app builds it, since a literal this deep is more than a Worker parses.
         */
        const nested = (wraps: number, odd = false) =>
          `jsonSchema((() => { let deep = ${odd ? `{ not: { required: ["alpha", "beta"] } }` : `{ required: ["alpha", "beta"] }`};
  for (let wrap = 0; wrap < ${wraps}; wrap++) deep = { dependencies: { member: deep } };
  return { type: "object", $defs: { deep } }; })())`;
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: carriedSource("first", "executor", nested(30)) },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver, redeployReplaces } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );

        // 64 levels is as deep as a schema is compared, so the unchanged setup is kept.
        const carried = yield* deploy("carried", "executor", nested(30));
        expect((yield* pinnedTo(carried)).map((row) => [row.id, row.status])).toEqual([
          [first.id, "setup-required"],
        ]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "carried",
          signed: true,
        });

        // One level deeper is not compared: redeploying it unchanged gives a new setup. So does a
        // schema 2,004 levels deep, past what recursion over it could reach.
        yield* redeployReplaces("past", nested(30, true));
        yield* redeployReplaces("deeper", nested(1000));
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookDeepConfiguration.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        /**
         * A configuration whose default nests `levels` objects deep with its own, built by the app
         * as a default, so the source's submitted configuration stays empty.
         */
        const nested = (levels: number) =>
          `object({ payload: json().default((() => { let deep = "synthetic";
  for (let level = 1; level < ${levels}; level++) deep = { member: deep };
  return deep; })()) })`;
        const fixture = yield* appLinksFixture([
          {
            path: "index.ts",
            content: carriedSource("first", "executor", undefined, undefined, nested(64)),
          },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver, redeployReplaces } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );

        // A configuration is compared to the same depth as a state schema.
        const carried = yield* deploy("carried", "executor", undefined, undefined, nested(64));
        expect((yield* pinnedTo(carried)).map((row) => [row.id, row.status])).toEqual([
          [first.id, "setup-required"],
        ]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "carried",
          signed: true,
        });

        // One level deeper, and about 1,800 levels with a shallow state schema, give a new setup
        // instead of leaving the source pending on the old code.
        yield* redeployReplaces("past", "object({})", nested(65));
        yield* redeployReplaces("deeper", "object({})", nested(1802));
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookWideSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const state = `jsonSchema({ type: "object" })`;
        /**
         * A configuration whose default is a list of zeros and one padding string, so that the
         * setup's compared text is `length` characters long: the JSON of its configuration, the
         * source of its secret and its state schema, with members in name order.
         */
        const wide = (length: number) => {
          const text = (zeros: number) =>
            JSON.stringify({
              config: { payload: [...Array.from({ length: zeros }, () => 0), ""] },
              signingSecret: "executor",
              stateSchema: { type: "object" },
            }).length;
          const zeros = Math.floor((length - text(0)) / 2);
          return `object({ payload: json().default([...Array.from({ length: ${zeros} }, () => 0), "x".repeat(${length - text(zeros)})]) })`;
        };
        // The longest compared text: the largest declaration a Cloud isolate keeps, 2 MiB of
        // UTF-16.
        const longest = 1024 * 1024;
        const fixture = yield* appLinksFixture([
          {
            path: "index.ts",
            content: carriedSource("first", "executor", state, undefined, wide(longest)),
          },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, deploy, pinnedTo, deliver, redeployReplaces } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          StateSchemaSetup,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );
        // The state schema is compared as declared.
        expect(opened.stateSchema).toEqual({ type: "object" });

        const carried = yield* deploy("carried", "executor", state, undefined, wide(longest));
        expect((yield* pinnedTo(carried)).map((row) => [row.id, row.status])).toEqual([
          [first.id, "setup-required"],
        ]);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "carried",
          signed: true,
        });

        // One character longer is not compared.
        yield* redeployReplaces("longer", state, wide(longest + 1));
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookNestedWideSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: carriedSource("first", "executor") },
        ]);
        const { actors, path, connect } = fixture;
        const { redeployReplaces } = carriedWebhook(fixture);
        yield* connect(actors.owner, "app", "team", "team-key");
        yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        // 32 lists of 60,000 zeros, each the first element of the one around it, about 3.8 million
        // characters. Every list fits the comparison on its own; together they are refused before
        // the levels below are queued, instead of each level spending the same allowance again.
        yield* redeployReplaces(
          "nested",
          "object({})",
          `object({ payload: json().default((() => { let nested = 0;
  for (let level = 0; level < 32; level++) {
    const zeros = Array.from({ length: 60000 }, () => 0);
    zeros[0] = nested;
    nested = zeros;
  }
  return nested; })()) })`,
        );
      }),
    ),
  );
  it.effect(scenarios.hostedManualWebhookConcurrentActivations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // The provider registrations of the webhooks declared before and after the manual one,
        // each held until the scenario lets it answer.
        const before = yield* webhookRegistrationFixture;
        const after = yield* webhookRegistrationFixture;
        const around = { before: before.url, after: after.url };
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: carriedSource("first", "executor") },
        ]);
        const { api, actors, path, connect } = fixture;
        const { setupPath, subscriptions, deploy, post, deliver, activate } =
          carriedWebhook(fixture);
        // The providers answer again before the fixture's cleanup unlinks the account and removes
        // the webhooks.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const provider of [before, after]) {
              yield* provider.recover;
              yield* provider.fail;
            }
          }),
        );
        yield* connect(actors.owner, "app", "team", "team-key");
        const [first] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.status === "setup-required"),
        );
        if (first === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const opened = yield* okBody(
          ConfigureWithSecret,
          yield* api.request(actors.owner, "GET", setupPath(first.id)),
        );
        yield* okBody(
          Subscription,
          yield* api.request(actors.owner, "POST", setupPath(first.id), {
            revision: opened.revision,
            state: {},
          }),
        );

        // The source starts reconciling version A and waits on its first registration while B
        // activates. It then reaches the last registration with the manual webhook on B, and A
        // activates again before that registration answers.
        const raceA = yield* deploy("raceA", "executor", undefined, around);
        yield* before.requested;
        const raceB = yield* deploy("raceB", "executor", undefined, around);
        yield* before.recover;
        yield* before.fail;
        yield* after.requested;
        expect((yield* subscriptions).find((row) => row.id === first.id)?.version).toBe(raceB);
        yield* activate(raceA, raceB);
        yield* after.recover;
        yield* after.fail;

        // Work for a superseded activation, even one of the version active again, does not count:
        // the source is ready only once it reconciled for A, and every subscription it delivers to
        // runs A's code, the manual one at the URL and with the secret the provider has.
        yield* settleWebhookSources(
          actors.owner,
          path,
          (sources) => sources.length === 1 && sources[0]?.status === "ready",
        );
        expect(
          (yield* okBody(ActiveVersion, yield* api.request(actors.owner, "GET", path)))
            .activeVersion,
        ).toBe(raceA);
        expect(yield* deliver(first.callbackUrl, opened.signingSecret.value)).toEqual({
          release: "raceA",
          signed: true,
        });
        const live = yield* subscriptions;
        expect(
          live
            .map((row) => [row.name, row.version, row.status])
            .sort(([left = ""], [right = ""]) => left.localeCompare(right)),
        ).toEqual([
          ["after", raceA, "active"],
          ["before", raceA, "active"],
          ["inbound", raceA, "active"],
        ]);
        for (const row of live.filter((item) => item.id !== first.id))
          expect(
            yield* okBody(RegisteredRelease, yield* post(row.callbackUrl, "unsigned")),
            row.name,
          ).toEqual({ release: "raceA" });
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
