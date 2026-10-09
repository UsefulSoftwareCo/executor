/**
 * An app with storage must answer calls while another of its calls waits: webhook registration
 * that, like Discord, completes only after the callback URL answers a verification request within
 * three seconds, and a mutation that waits before writing. The app verifies its own callback, so
 * the scenario needs no outside service and runs on deployed Cloudflare.
 */
import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Fiber, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, secrets, object, string, query, mutation, router,
  type MutationContext, type QueryContext, type Webhook, type WebhookContext } from "apps";
const service = defineProvider({ name: "Callback fixture", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
const requirements = { accounts: { service } };
const empty = object({});
const interactions = {
  account: "service", config: empty, state: empty,
  async register(ctx, { callbackUrl }) {
    const response = await ctx.fetch(callbackUrl, {
      method: "POST", headers: { "content-type": "application/json", "x-verify": "synthetic-ping" },
      body: JSON.stringify({ type: 1 }), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(3000)]),
    });
    if (!response.ok) throw new Error("The callback URL did not answer verification");
    ctx.sql.exec("INSERT INTO events (kind) VALUES ('registered')");
    return {};
  },
  async handle(ctx, { request }) {
    if (request.headers.get("x-verify") !== "synthetic-ping") return new Response(null, { status: 401 });
    ctx.sql.exec("INSERT INTO events (kind) VALUES ('verified')");
    return Response.json({ type: 1 });
  },
  async unregister() {},
} satisfies Webhook<WebhookContext<typeof requirements>, typeof empty, typeof empty>;
const slow = mutation({ input: empty }, async (ctx: MutationContext<typeof requirements>) => {
  ctx.sql.exec("INSERT INTO events (kind) VALUES ('waiting')");
  await new Promise((resolve) => setTimeout(resolve, 8000));
  ctx.sql.exec("INSERT INTO events (kind) VALUES ('slow')");
  return "done";
});
const events = query({ input: empty }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec<{ kind: string }>("SELECT kind FROM events ORDER BY seq").toArray().map((event) => event.kind));
export default defineApp(requirements, { tools: router({ slow, events }), webhooks: { interactions } });
`,
  },
  {
    path: "migrations/0001_events.sql",
    content: "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL);\n",
  },
  appsManifest,
];

const Profile = Schema.Struct({
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
  reconciledDeployment: Schema.NullOr(Schema.String),
});
const Subscription = Schema.Struct({ callbackUrl: Schema.String, status: Schema.String });
const Kinds = Schema.Array(Schema.String);

layer(HostedLive, { excludeTestServices: true })("App calls during outside waits", (it) => {
  it.effect(scenarios.appCallbacks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Callbacks ${randomUUID().slice(0, 8)}`;
        const created: { app?: string; account?: string; profile?: string } = {};
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (created.profile)
              yield* api.request(
                actors.owner,
                "DELETE",
                `${prefix}/apps/${created.app}/profiles/${created.profile}`,
              );
            if (created.app)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${created.app}`);
            if (created.account)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
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
          {
            requirement: "service",
            profile: profile.id,
          },
        );
        expect(connection.status).toBe(200);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
          { method: "key", label: name, fields: { token: "synthetic-callbacks" } },
        );
        expect(saved.status).toBe(200);
        created.account = (yield* body(Resource, saved)).id;

        // Setup registers the webhook; the provider verifies the callback while register waits.
        const deadline = (yield* Clock.currentTimeMillis) + 30_000;
        let current: typeof Profile.Type;
        for (;;) {
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app}/profiles/${profile.id}/reconcile`,
          );
          expect(response.status).toBe(200);
          current = yield* body(Profile, response);
          if (current.status === "ready" || current.status === "failed") break;
          expect(yield* Clock.currentTimeMillis, JSON.stringify(current)).toBeLessThan(deadline);
          yield* Effect.sleep("200 millis");
        }
        expect(current).toMatchObject({ status: "ready", failure: null });
        const subscriptions = yield* body(
          Schema.Array(Subscription),
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app}/webhooks?profile=${profile.id}`,
          ),
        );
        expect(subscriptions.map((subscription) => subscription.status)).toEqual(["active"]);
        // A new subscription registers on the canonical API origin (Cloud's `api.`).
        expect(
          subscriptions.map((subscription) => new URL(subscription.callbackUrl).origin),
        ).toEqual([targetHosts(target).api]);
        expect(new URL(subscriptions[0]?.callbackUrl ?? "").pathname).toMatch(
          new RegExp(`^/api/webhooks/${app}/[^/]+$`),
        );

        const call = (tool: "slow" | "events", kind: "mutation" | "query") =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app}/tools/call`, {
            profile: profile.id,
            tool,
            kind,
            input: {},
          });
        // A call that waits for eight seconds must not hold the app's other calls. Each query
        // returns well before the slow call finishes, and the first sees its committed write.
        const slow = yield* Effect.forkChild(call("slow", "mutation"));
        const waiting = (yield* Clock.currentTimeMillis) + 6_000;
        for (;;) {
          const started = yield* Clock.currentTimeMillis;
          const events = yield* call("events", "query");
          expect(events.status).toBe(200);
          expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(4_000);
          const kinds = yield* body(Kinds, events);
          if (kinds.includes("waiting")) {
            expect(kinds).toEqual(["verified", "registered", "waiting"]);
            break;
          }
          expect(yield* Clock.currentTimeMillis, JSON.stringify(kinds)).toBeLessThan(waiting);
          yield* Effect.sleep("200 millis");
        }
        expect((yield* Fiber.join(slow)).status).toBe(200);
        expect(yield* body(Kinds, yield* call("events", "query"))).toEqual([
          "verified",
          "registered",
          "waiting",
          "slow",
        ]);
      }),
    ),
  );
});
