/**
 * A user account's webhook source serves only the user requirements its account is linked to, and
 * follows its links as they change. Shared by the hosted and local scenarios: each passes its own
 * link routes and the actor its user sources run as.
 */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";
import {
  settleWebhookSources,
  settleWebhookSubscriptions,
  type WebhookSubscriptionRow,
} from "./webhook-sources.ts";

/**
 * Two plain and two many() user requirements of one provider, each with its own webhook. Each
 * handler reports its source account and the accounts its context resolved for every requirement.
 */
export const userWebhookRequirementsSource = (
  provider: string,
) => `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = ${provider};
const hook = (user) => ({ account: { user }, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {},
  handle: async (ctx, { account }) => Response.json({ source: account.id,
    first: ctx.user.accounts.first.id, second: ctx.user.accounts.second.id,
    alpha: ctx.user.accounts.alpha.map((item) => item.id), beta: ctx.user.accounts.beta.map((item) => item.id) }) });
export default defineApp({ user: { accounts: { first: service, second: service, alpha: service.many(), beta: service.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
    webhooks: { firstHook: hook("first"), secondHook: hook("second"), alphaHook: hook("alpha"), betaHook: hook("beta") } }));`;

const Delivered = Schema.Struct({
  source: Schema.String,
  first: Schema.String,
  second: Schema.String,
  alpha: Schema.Array(Schema.String),
  beta: Schema.Array(Schema.String),
});

/**
 * Drive the app deployed from {@link userWebhookRequirementsSource} at `appPath`. `add` saves a
 * new account and links it to a requirement; `link` and `unlink` change the user links of saved
 * accounts. Every source runs as `actor`, which `reader` may see. Leaves no links behind.
 */
export const userWebhookRequirements = (input: {
  readonly reader: Session;
  readonly appPath: string;
  readonly actor: string;
  readonly add: (requirement: string, token: string) => Effect.Effect<string, unknown, Api>;
  readonly link: (requirement: string, account: string) => Effect.Effect<void, unknown, Api>;
  readonly unlink: (requirement: string, account: string) => Effect.Effect<void, unknown, Api>;
}) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const { reader, appPath, actor } = input;
    /**
     * Wait until each named account is a ready source running as `actor` whose live webhooks are
     * exactly the listed ones, every one active, and return those subscriptions.
     */
    const serves = (expected: Readonly<Record<string, readonly string[]>>) =>
      Effect.gen(function* () {
        const accounts = Object.keys(expected);
        yield* settleWebhookSources(reader, appPath, (sources) =>
          accounts.every((account) =>
            sources.some(
              (source) =>
                source.account === account && source.actor === actor && source.status === "ready",
            ),
          ),
        );
        const liveOf = (hooks: readonly WebhookSubscriptionRow[], account: string) =>
          hooks.filter((hook) => hook.sourceAccount === account && hook.status !== "stopped");
        const hooks = yield* settleWebhookSubscriptions(reader, appPath, (hooks) =>
          accounts.every((account) => {
            const live = liveOf(hooks, account);
            return (
              live.every((hook) => hook.status === "active") &&
              JSON.stringify(live.map((hook) => hook.name).sort()) ===
                JSON.stringify([...(expected[account] ?? [])].sort())
            );
          }),
        );
        return hooks.filter((hook) => hook.status === "active");
      });
    const hookOf = (hooks: readonly WebhookSubscriptionRow[], name: string, account: string) => {
      const found = hooks.find((hook) => hook.name === name && hook.sourceAccount === account);
      if (found === undefined) throw new Error(`Missing ${name} for ${account}`);
      return found;
    };
    /** Deliver an anonymous callback and decode what its handler resolved. */
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

    // One account linked to both plain requirements serves both of their webhooks.
    const a = yield* input.add("first", "synthetic-user-a");
    yield* input.link("second", a);
    const both = yield* serves({ [a]: ["firstHook", "secondHook"] });
    const aSecond = hookOf(both, "secondHook", a);

    // Linking another account to the second requirement replaces that link. Each source now serves
    // only the requirement its account is linked to, though both share the provider: the first
    // account's second webhook stops and the new account registers only the second's.
    const b = yield* input.add("second", "synthetic-user-b");
    const split = yield* serves({ [a]: ["firstHook"], [b]: ["secondHook"] });
    const stopped = yield* settleWebhookSubscriptions(reader, appPath, (hooks) =>
      hooks.some((hook) => hook.id === aSecond.id && hook.status === "stopped"),
    );
    expect(stopped.find((hook) => hook.id === aSecond.id)?.status).toBe("stopped");
    // Each delivery resolves every requirement to its own link, its source only where linked.
    const plain = { first: a, second: b, alpha: [], beta: [] };
    expect(yield* deliver(hookOf(split, "firstHook", a))).toEqual({ source: a, ...plain });
    expect(yield* deliver(hookOf(split, "secondHook", b))).toEqual({ source: b, ...plain });

    // A third account follows its many() links as they change: each link registers that
    // requirement's webhook on its source, linking again changes nothing, and each unlink stops
    // only that requirement's webhook.
    const c = yield* input.add("alpha", "synthetic-user-c");
    const alpha = hookOf(yield* serves({ [c]: ["alphaHook"] }), "alphaHook", c);
    yield* input.link("beta", c);
    const linked = yield* serves({
      [a]: ["firstHook"],
      [b]: ["secondHook"],
      [c]: ["alphaHook", "betaHook"],
    });
    expect(hookOf(linked, "alphaHook", c).id).toBe(alpha.id);
    const beta = hookOf(linked, "betaHook", c);
    expect(yield* deliver(beta)).toEqual({ ...plain, source: c, alpha: [c], beta: [c] });
    yield* input.link("beta", c);
    yield* input.unlink("alpha", c);
    const after = yield* serves({ [a]: ["firstHook"], [b]: ["secondHook"], [c]: ["betaHook"] });
    expect(hookOf(after, "betaHook", c).id).toBe(beta.id);
    yield* settleWebhookSubscriptions(reader, appPath, (hooks) =>
      hooks.some((hook) => hook.id === alpha.id && hook.status === "stopped"),
    );
    expect(yield* deliver(hookOf(after, "betaHook", c))).toEqual({
      ...plain,
      source: c,
      beta: [c],
    });

    // Unlinking the rest removes every source and stops its webhooks.
    yield* input.unlink("beta", c);
    yield* input.unlink("second", b);
    yield* input.unlink("first", a);
    yield* settleWebhookSources(reader, appPath, (sources) => sources.length === 0);
    yield* settleWebhookSubscriptions(reader, appPath, (hooks) =>
      hooks.every((hook) => hook.status === "stopped"),
    );
  });
