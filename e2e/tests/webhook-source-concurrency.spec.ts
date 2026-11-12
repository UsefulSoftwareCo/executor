/** Cloud's coordinator reconciles independent webhook sources together, not a few at a time. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { connectionsPath, requirementPath } from "../support/app-accounts.ts";
import {
  removeAppWhenStopped,
  settleWebhookSources,
  settleWebhookSubscriptions,
  webhookSubscriptions,
} from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** More sources than a Node server reconciles at once, and fewer than Cloud does. */
const sources = 8;

/**
 * An app-account webhook per linked account. `held` versions register only once the scenario
 * releases them through the app cache, so each registration stays in flight, its subscription
 * `pending`, for as long as the scenario needs; after a minute it fails.
 */
const source = (
  held: boolean,
) => `import {defineApp,defineProvider,secrets,query,mutation,object,string,boolean,router} from "apps";
const service=defineProvider({name:"Concurrency fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{app:"appService"},config:object({}),state:object({}),
  register:async(ctx)=>{${
    held
      ? `for(let attempt=0;attempt<600;attempt++){if((await ctx.cache.read("released",boolean()))===true)return {};await new Promise((resolve)=>setTimeout(resolve,100));}
    throw new Error("The registration was not released");`
      : "return {};"
  }},
  unregister:async()=>{},handle:async()=>Response.json({})};
export default defineApp({app:{accounts:{appService:service.many()}}},{tools: router({
  release:mutation({input:object({})},async ctx=>{await ctx.cache.write([{key:"released",value:true}],"10 minutes");return "released";}),
}),webhooks:{incoming}});`;

const Deployed = Schema.Struct({ ...App.fields, activeVersion: Schema.String });
const Redeployed = Schema.Struct({ app: Deployed });

layer(HostedLive, { excludeTestServices: true })("Webhook source concurrency", (it) => {
  it.effect(scenarios.webhookSourceConcurrency.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          Deployed,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Concurrency ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source(false) }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Let any registration still held finish, so its subscription can stop.
            yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "release",
              kind: "mutation",
              input: {},
            });
            for (const account of accounts)
              yield* api.request(
                actors.owner,
                "DELETE",
                `${requirementPath(path, "app", "appService")}/${account}`,
              );
            yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
              hooks.every((hook) => hook.status === "stopped"),
            );
            yield* removeAppWhenStopped(actors.owner, path);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        // Each account connected from the app is linked to it for everyone: its own source.
        for (let index = 0; index < sources; index++) {
          const connection = yield* body(
            Resource,
            yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(path, "app", "appService"),
              {},
            ),
          );
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "key", label: `Concurrency ${index}`, fields: { token: "synthetic" } },
          );
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          accounts.push((yield* body(Resource, saved)).id);
        }
        yield* settleWebhookSources(
          actors.owner,
          path,
          (rows) => rows.length === sources && rows.every((row) => row.status === "ready"),
        );
        // A new version is new intent for every source at once. Each registers again, and its
        // registration waits for the release.
        const redeployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: source(true) }, appsManifest],
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        const version = (yield* body(Redeployed, redeployed)).app.activeVersion;
        expect(version).not.toBe(app.activeVersion);
        // A held registration keeps its source's slot, so the number in flight together is the
        // coordinator's width: every source's registration must be waiting at once. Within the
        // minute a registration holds, a narrower coordinator never starts the rest.
        const observed: number[] = [];
        const deadline = (yield* Clock.currentTimeMillis) + 30_000;
        for (;;) {
          const pending = (yield* webhookSubscriptions(actors.owner, path)).filter(
            (hook) => hook.status === "pending",
          ).length;
          observed.push(pending);
          if (pending === sources) break;
          expect(
            yield* Clock.currentTimeMillis,
            `At most ${Math.max(...observed)} of ${sources} webhook source registrations were in flight at once`,
          ).toBeLessThan(deadline);
          yield* Effect.sleep("200 millis");
        }
        const released = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "release",
          kind: "mutation",
          input: {},
        });
        expect(released.status, JSON.stringify(released.body)).toBe(200);
        yield* settleWebhookSources(
          actors.owner,
          path,
          (rows) => rows.length === sources && rows.every((row) => row.status === "ready"),
        );
        const active = (yield* webhookSubscriptions(actors.owner, path)).filter(
          (hook) => hook.status === "active",
        );
        expect(active.map((hook) => hook.sourceAccount).sort()).toEqual([...accounts].sort());
      }),
    ),
  );
});
