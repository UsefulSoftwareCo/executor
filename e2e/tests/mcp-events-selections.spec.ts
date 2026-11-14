/**
 * Selections through the one listed event, `executor.app_event`, as ChatGPT uses it: the client
 * saves that event once and offers it to every user, who selects their own apps' events with its
 * arguments. Every app, including one deployed after subscribing; one app; or one event with its
 * filters. Each selection is its own subscription, and each delivery names its app and event.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  Granted,
  Selected,
  appEvent,
  emitterFiles,
  eventFixtures,
  secrets,
} from "../support/events.ts";

layer(HostedLive, { excludeTestServices: true })("MCP event selections", (it) => {
  it.effect(
    scenarios.mcpEventSelections.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            suffix,
            emitter,
            callbackUrl,
            awaitDeliveries,
            events,
            emit,
            emitFrom,
            deploy,
            rpcAs,
            ok,
            refused,
            createKey,
          } = yield* eventFixtures;
          const key = yield* createKey(`Event selections ${suffix}`);
          const select = (args: Readonly<Record<string, unknown>>, secret: string = secrets[0]) =>
            rpcAs(key.key, "events/subscribe", {
              name: appEvent,
              arguments: args,
              delivery: { mode: "webhook", url: callbackUrl, secret },
              ttlMs: 60 * 60_000,
            });

          // Arguments that select nothing are refused with the extension's codes.
          expect(yield* refused(yield* select({ event: "issue.opened" }))).toMatchObject({
            code: -32602,
            data: { field: "arguments" },
          });
          expect(
            yield* refused(yield* select({ app: emitter.slug, repo: "acme/widgets" })),
          ).toMatchObject({ code: -32602, data: { field: "arguments" } });
          expect(
            yield* refused(yield* select({ app: `missing-${randomUUID().slice(0, 8)}` })),
          ).toMatchObject({ code: -32011, data: { kind: "event" } });
          expect(
            yield* refused(yield* select({ app: emitter.slug, event: "issue.closed" })),
          ).toMatchObject({ code: -32011, data: { kind: "event" } });
          expect(
            yield* refused(
              yield* select({ app: emitter.slug, event: "issue.opened", owner: "acme" }),
            ),
          ).toMatchObject({ code: -32602, data: { field: "arguments" } });

          // Three selections from one subscriber to one callback stay three subscriptions.
          const everything = yield* ok(Granted, yield* select({}));
          const oneApp = yield* ok(Granted, yield* select({ app: emitter.slug }));
          const oneEvent = yield* ok(
            Granted,
            yield* select({ app: emitter.slug, event: "issue.opened", repo: "acme/widgets" }),
          );
          expect(new Set([everything.id, oneApp.id, oneEvent.id]).size).toBe(3);
          // Repeating a selection refreshes it, and a new secret rotates it.
          expect((yield* ok(Granted, yield* select({}, secrets[1]))).id).toBe(everything.id);

          // An app deployed after subscribing is among every app's events.
          const later = yield* deploy(`Later issue events ${suffix}`, emitterFiles);
          const widgets = yield* emit("acme/widgets", 1);
          const gadgets = yield* emit("acme/gadgets", 2);
          const elsewhere = yield* emitFrom(later, "acme/widgets", 3);
          const emitted: ReadonlyArray<string> = [widgets, gadgets, elsewhere];
          const delivered = yield* awaitDeliveries(
            (all) => events(all).filter((delivery) => emitted.includes(delivery.id)).length >= 6,
          );
          const to = (subscription: string) =>
            events(delivered)
              .filter((delivery) => delivery.subscription === subscription)
              .map((delivery) => delivery.id)
              .sort();
          expect(to(everything.id)).toEqual([widgets, gadgets, elsewhere].sort());
          expect(to(oneApp.id)).toEqual([widgets, gadgets].sort());
          expect(to(oneEvent.id)).toEqual([widgets]);
          for (const delivery of events(delivered)) {
            const body = yield* Schema.decodeUnknownEffect(Selected)(delivery.body);
            expect(body.eventId).toBe(delivery.id);
            expect(body.data.event).toBe("issue.opened");
            expect(body.data.app).toBe(delivery.id === elsewhere ? later.slug : emitter.slug);
          }
          const fromLater = events(delivered).find((delivery) => delivery.id === elsewhere);
          expect((yield* Schema.decodeUnknownEffect(Selected)(fromLater!.body)).data.data).toEqual({
            title: "Issue 3",
            number: 3,
          });

          // Unsubscribing one selection leaves the others.
          yield* ok(
            Schema.Struct({}),
            yield* rpcAs(key.key, "events/unsubscribe", {
              name: appEvent,
              arguments: { app: emitter.slug },
              delivery: { mode: "webhook", url: callbackUrl },
            }),
          );
          const afterUnsubscribe = yield* emit("acme/widgets", 4);
          const settled = yield* awaitDeliveries(
            (all) => events(all).filter((delivery) => delivery.id === afterUnsubscribe).length >= 2,
          );
          expect(
            events(settled)
              .filter((delivery) => delivery.id === afterUnsubscribe)
              .map((delivery) => delivery.subscription)
              .sort(),
          ).toEqual([everything.id, oneEvent.id].sort());
        }),
      ),
    { timeout: 240_000 },
  );
});
