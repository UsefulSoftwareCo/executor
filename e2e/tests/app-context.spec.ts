import { createProfile } from "../support/profiles.ts";
/** Real hosted HTTP checks for separately declared handlers and their invocation-owned context. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";

const files = [
  {
    path: "context.ts",
    content: `import { defineDatabase, defineProvider, secrets, table, object, string,
  type QueryContext, type MutationContext, type WebhookContext } from "apps";
const service = defineProvider({ name: "Context fixture", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
export const requirements = { accounts: { service }, database: defineDatabase({
  messages: table({ body: string(), source: string() })
}) };
export type QueryCtx = QueryContext<typeof requirements>;
export type MutationCtx = MutationContext<typeof requirements>;
export type WebhookCtx = WebhookContext<typeof requirements>;
`,
  },
  {
    path: "handlers.ts",
    content: `import { query, mutation, object, string, type Webhook } from "apps";
import type { QueryCtx, MutationCtx, WebhookCtx } from "./context.ts";
const input = object({ body: string() });
const source = (ctx: Pick<WebhookCtx, "accounts">) =>
  ctx.accounts.service.fields.token === "synthetic-context-b" ? "second" : "first";
export const list = query({ input: object({}) }, async (ctx: QueryCtx) =>
  ctx.db.messages.withIndex("by_creation").collect());
export const save = mutation({ input }, async (ctx: MutationCtx, value) =>
  ctx.db.messages.insert({ ...value, source: source(ctx) }));
export const broken = mutation({ input }, async (ctx: MutationCtx, value) => {
  await ctx.db.messages.insert({ ...value, source: source(ctx) });
  throw new Error("Synthetic rollback");
});
export const invalid = mutation({ input, output: string() }, async (ctx: MutationCtx, value) => {
  await ctx.db.messages.insert({ ...value, source: source(ctx) });
  return 123;
});
export const guarded = mutation({ input, approval: () => "denied" }, async (ctx: MutationCtx, value) =>
  ctx.db.messages.insert({ ...value, source: source(ctx) }));
export const forbidden = query({ input }, async (ctx, value) => ctx.db.messages.insert({ ...value, source: "bad" }));
const empty = object({});
export const messages = {
  account: "service", config: empty, state: empty,
  async register(ctx) {
    if ("elicit" in ctx) throw new Error("Interactive webhook context");
    await ctx.db.messages.insert({ body: "registered", source: source(ctx) });
    return {};
  },
  async handle(ctx, { request }) {
    if (request.headers.get("x-fixture-signature") !== "context-check") return new Response(null, { status: 401 });
    const value = input.parse(await request.json());
    if ("elicit" in ctx) throw new Error("Interactive webhook context");
    await ctx.db.messages.insert({ ...value, source: source(ctx) });
    return Response.json({ source: source(ctx) });
  },
  async unregister(ctx) {
    await ctx.db.messages.insert({ body: "unregistered", source: source(ctx) });
  },
} satisfies Webhook<WebhookCtx, typeof empty, typeof empty>;
`,
  },
  {
    path: "index.ts",
    content: `import { defineApp } from "apps";
import { requirements } from "./context.ts";
import { list, save, broken, invalid, guarded, forbidden, messages } from "./handlers.ts";
export default defineApp(requirements, {
  queries: { list, forbidden }, mutations: { save, broken, invalid, guarded }
});`,
  },
];

const Rows = Schema.Array(Schema.Struct({ body: Schema.String, source: Schema.String }));
const Subscription = Schema.Struct({
  id: Schema.String,
  callbackUrl: Schema.String,
  status: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("App handler context", (it) => {
  it.effect(scenarios.appContext.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Context ${randomUUID().slice(0, 8)}`;
        const created: { app?: string; account?: string; profile?: string } = {};
        const settleProfile = (
          expected:
            | { readonly status: "ready"; readonly deployment: string }
            | { readonly status: "removed" },
        ) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 15000;
            for (;;) {
              const response = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/apps/${created.app}/profiles/${created.profile}/reconcile`,
              );
              expect(response.status).toBe(200);
              const current = yield* body(
                Schema.Struct({
                  status: Schema.String,
                  reconciledDeployment: Schema.NullOr(Schema.String),
                }),
                response,
              );
              if (
                current.status === expected.status &&
                (expected.status === "removed" ||
                  current.reconciledDeployment === expected.deployment)
              )
                return;
              expect(yield* Clock.currentTimeMillis, JSON.stringify(current)).toBeLessThan(
                deadline,
              );
              yield* Effect.sleep("100 millis");
            }
          });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (created.profile) {
              expect(
                (yield* api.request(
                  actors.owner,
                  "DELETE",
                  `${prefix}/apps/${created.app}/profiles/${created.profile}`,
                )).status,
              ).toBe(200);
              yield* settleProfile({ status: "removed" });
            }
            if (created.app)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${created.app}`))
                  .status,
              ).toBe(200);
            if (created.account)
              expect(
                (yield* api.request(
                  actors.owner,
                  "DELETE",
                  `${prefix}/accounts/${created.account}`,
                )).status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = (yield* body(App, deployed)).id;
        created.app = app;
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app}`);
        created.profile = profile.id;
        const connection = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app}/connections`,
          { requirement: "service", profile: profile.id },
        );
        expect(connection.status).toBe(200);
        const submit = (id: string, token: string) =>
          api.request(actors.owner, "POST", `${prefix}/connections/${id}/submit`, {
            method: "key",
            label: name,
            fields: { token },
          });
        const saved = yield* submit((yield* body(Resource, connection)).id, "synthetic-context-a");
        expect(saved.status).toBe(200);
        created.account = (yield* body(Resource, saved)).id;
        const call = (tool: string, input: Record<string, string> = {}) =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app}/tools/call`, {
            profile: profile.id,
            tool,
            input,
          });
        expect((yield* call("mutations.save", { body: "before" })).status).toBe(200);
        const reconnected = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/accounts/${created.account}/connections`,
        );
        expect(reconnected.status).toBe(200);
        expect(
          (yield* submit((yield* body(Resource, reconnected)).id, "synthetic-context-b")).status,
        ).toBe(200);
        expect((yield* call("mutations.save", { body: "after" })).status).toBe(200);
        for (const tool of [
          "queries.forbidden",
          "mutations.broken",
          "mutations.invalid",
          "mutations.guarded",
        ]) {
          expect((yield* call(tool, { body: tool })).status).toBeGreaterThanOrEqual(400);
        }
        const list = yield* call("queries.list");
        expect(list.status).toBe(200);
        expect(yield* body(Rows, list)).toEqual([
          { body: "before", source: "first" },
          { body: "after", source: "second" },
        ]);
        // Introduce the webhook only after the mutation assertions. Profile setup
        // owns registration; racing it with manual registration creates two hooks.
        const updated = yield* api.request(actors.owner, "POST", `${prefix}/apps/${app}/deploy`, {
          files: files.map((file) =>
            file.path === "index.ts"
              ? {
                  ...file,
                  content: file.content.replace(
                    "mutations: { save, broken, invalid, guarded }",
                    "mutations: { save, broken, invalid, guarded }, webhooks: { messages }",
                  ),
                }
              : file,
          ),
        });
        expect(updated.status).toBe(200);
        const { activeDeployment } = yield* body(
          Schema.Struct({ activeDeployment: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app}`),
        );
        yield* settleProfile({ status: "ready", deployment: activeDeployment });
        const subscriptions = yield* body(
          Schema.Array(Subscription),
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app}/webhooks?profile=${profile.id}`,
          ),
        );
        expect(subscriptions).toHaveLength(1);
        const subscription = subscriptions[0];
        if (subscription === undefined) return yield* Effect.die(new Error("Webhook missing"));
        expect(subscription.status).toBe("active");
        const anonymous = yield* api.session();
        const callback = new URL(subscription.callbackUrl).pathname;
        expect(
          (yield* api.request(anonymous, "POST", callback, { body: "unauthorized" })).status,
        ).toBe(401);
        const delivered = yield* api.request(
          anonymous,
          "POST",
          callback,
          { body: "webhook" },
          { "x-fixture-signature": "context-check" },
        );
        expect(delivered.status).toBe(200);
        expect(delivered.body).toEqual({ source: "second" });
        expect(yield* body(Rows, yield* call("queries.list"))).toEqual([
          { body: "before", source: "first" },
          { body: "after", source: "second" },
          { body: "registered", source: "second" },
          { body: "webhook", source: "second" },
        ]);
      }),
    ),
  );
});
