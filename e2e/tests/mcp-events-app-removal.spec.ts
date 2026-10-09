/**
 * Removing an app removes its event subscriptions. A client that subscribes again by the same
 * name after the app was re-created under that name gets a subscription bound to the new app,
 * with the same id, and receives the new app's events.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Granted, emitterFiles, eventFixtures, secrets } from "../support/events.ts";

layer(HostedLive, { excludeTestServices: true })("MCP event app removal", (it) => {
  it.effect(
    scenarios.mcpEventsAppRemoval.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const {
            prefix,
            suffix,
            emitter,
            callbackUrl,
            awaitDeliveries,
            events,
            emit,
            rpcAs,
            ok,
            createKey,
            name,
          } = yield* eventFixtures;
          const key = yield* createKey(`Event app removal ${suffix}`);
          const subscribe = () =>
            rpcAs(key.key, "events/subscribe", {
              name,
              arguments: {},
              delivery: { mode: "webhook", url: callbackUrl, secret: secrets[0] },
              ttlMs: 60 * 60_000,
            });

          const first = yield* ok(Granted, yield* subscribe());
          const before = yield* emit("acme/widgets", 1);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === before && delivery.subscription === first.id,
            ),
          );

          const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${emitter.id}`);
          expect(removed.status, JSON.stringify(removed.body)).toBe(200);

          // The same name gives the same slug, so the event name the client holds resolves again.
          const created: { app?: string } = {};
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (created.app)
                yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${created.app}`);
            }).pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Issue events ${suffix}`,
            files: emitterFiles,
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const fresh = yield* body(App, deployed);
          created.app = fresh.id;
          expect(fresh.id).not.toBe(emitter.id);
          expect(fresh.slug).toBe(emitter.slug);

          const second = yield* ok(Granted, yield* subscribe());
          expect(second.id).toBe(first.id);

          const after = randomUUID();
          const emitted = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${fresh.id}/tools/call`,
            {
              tool: "open",
              kind: "mutation",
              input: { repo: "acme/widgets", title: "Issue 2", number: 2, id: after },
            },
          );
          expect(emitted.status, JSON.stringify(emitted.body)).toBe(200);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === after && delivery.subscription === second.id,
            ),
          );

          yield* ok(
            Schema.Struct({}),
            yield* rpcAs(key.key, "events/unsubscribe", {
              name,
              arguments: {},
              delivery: { mode: "webhook", url: callbackUrl },
            }),
          );
        }),
      ),
    { timeout: 240_000 },
  );
});
