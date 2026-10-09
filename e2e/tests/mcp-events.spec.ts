/**
 * MCP events as ChatGPT uses them: protocol 2026-07-28, webhook delivery only. A client discovers
 * the `events` capability, lists an app's events, subscribes with a callback URL and a Standard
 * Webhooks secret, and receives each matching occurrence, signed, after the callback echoed a
 * challenge. The receiver is an Executor app's own webhook: it checks every signature and records
 * what arrived, so the scenario needs no outside service and runs on deployed Cloudflare.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  Discovered,
  EventList,
  Granted,
  Occurrence,
  eventFixtures,
  secrets,
} from "../support/events.ts";

layer(HostedLive, { excludeTestServices: true })("MCP events", (it) => {
  it.effect(
    scenarios.mcpEvents.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const {
            prefix,
            suffix,
            receiver,
            emitter,
            callbackUrl,
            callReceiver,
            deliveries,
            awaitDeliveries,
            events,
            emit,
            rpcAs,
            ok,
            refused,
            createKey,
            name,
          } = yield* eventFixtures;
          // A personal access token connects as ChatGPT's plugin would, at the organization's MCP URL.
          const key = yield* createKey(`Events ${suffix}`);
          const rpc = (method: string, params: Readonly<Record<string, unknown>> = {}) =>
            rpcAs(key.key, method, params);
          const subscribe = (
            options: { arguments?: unknown; url?: string; secret?: string; name?: string } = {},
          ) =>
            rpc("events/subscribe", {
              name: options.name ?? name,
              arguments: options.arguments ?? { repo: "acme/widgets" },
              delivery: {
                mode: "webhook",
                url: options.url ?? callbackUrl,
                secret: options.secret ?? secrets[0],
              },
              ttlMs: 60 * 60_000,
            });

          // Discovery advertises events beside tools.
          const discovered = yield* ok(Discovered, yield* rpc("server/discover"));
          expect(discovered.capabilities.events).toEqual({});
          const listed = yield* ok(EventList, yield* rpc("events/list"));
          const listedEvent = listed.events.find((event) => event.name === name);
          expect(listedEvent, JSON.stringify(listed)).toMatchObject({
            description: "An issue was opened in a repository.",
            delivery: ["webhook"],
            inputSchema: {
              type: "object",
              properties: { repo: { type: "string" } },
              additionalProperties: false,
            },
            payloadSchema: { type: "object" },
          });
          expect(listedEvent?.inputSchema.required).toBeUndefined();
          // The receiver declares no events, so it lists none.
          expect(listed.events.some((event) => event.name.startsWith(`${receiver.slug}.`))).toBe(
            false,
          );

          // Requests that do not fit are refused with the extension's codes.
          expect(yield* refused(yield* subscribe({ secret: "not-a-secret" }))).toMatchObject({
            code: -32602,
            data: { field: "secret" },
          });
          expect(
            yield* refused(yield* subscribe({ name: `${emitter.slug}.issue.closed` })),
          ).toMatchObject({
            code: -32011,
            data: { kind: "event" },
          });
          expect(yield* refused(yield* subscribe({ arguments: { owner: "acme" } }))).toMatchObject({
            code: -32602,
            data: { field: "arguments" },
          });
          // The filter's own schema applies: this repository name is shorter than it allows.
          expect(yield* refused(yield* subscribe({ arguments: { repo: "" } }))).toMatchObject({
            code: -32602,
            data: { field: "arguments" },
          });
          expect(yield* refused(yield* subscribe({ arguments: { repo: 7 } }))).toMatchObject({
            code: -32602,
            data: { field: "arguments" },
          });
          // A callback that does not echo its challenge is not subscribed.
          expect(
            yield* refused(yield* subscribe({ url: `${callbackUrl}?variant=refuse` })),
          ).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });

          // A subscription verifies its callback once, with a signed challenge.
          const startedAt = yield* Clock.currentTimeMillis;
          const granted = yield* ok(Granted, yield* subscribe());
          expect(granted.id).toMatch(/^evs_[0-9a-f]{32}$/);
          const expiresIn = Date.parse(granted.refreshBefore) - startedAt;
          expect(expiresIn).toBeGreaterThan(55 * 60_000);
          expect(expiresIn).toBeLessThanOrEqual(61 * 60_000);
          const verifications = (yield* deliveries).filter(
            (delivery) => delivery.kind === "verification" && delivery.variant === "",
          );
          expect(verifications, JSON.stringify(yield* deliveries)).toHaveLength(1);
          expect(verifications[0]).toMatchObject({ subscription: granted.id, signedBy: "0" });
          expect(verifications[0]!.id).toMatch(/^msg_verification_/);
          // Repeating it refreshes the same subscription without another challenge.
          const again = yield* ok(
            Granted,
            yield* subscribe({ arguments: { repo: "acme/widgets" } }),
          );
          expect(again.id).toBe(granted.id);
          // Identical requests at the same time make one subscription.
          const concurrent = yield* Effect.all(
            [
              subscribe({ arguments: { repo: "acme/concurrent" } }),
              subscribe({ arguments: { repo: "acme/concurrent" } }),
            ],
            { concurrency: 2 },
          );
          const [left, right] = yield* Effect.forEach(concurrent, (value) => ok(Granted, value));
          expect(left!.id).toBe(right!.id);
          // A second subscription with no filter receives every occurrence. Its callback was just
          // verified for this subscriber, so it is not challenged again.
          const everything = yield* ok(Granted, yield* subscribe({ arguments: {} }));
          expect(everything.id).not.toBe(granted.id);
          const afterSecond = yield* deliveries;
          expect(
            afterSecond.filter(
              (delivery) => delivery.kind === "verification" && delivery.variant === "",
            ),
            JSON.stringify(afterSecond),
          ).toHaveLength(1);

          // Concurrent refreshes with different secrets both succeed on the same subscription, and
          // what it then delivers is signed by a secret the receiver holds.
          const rotating = yield* Effect.all(
            [
              subscribe({ arguments: { repo: "acme/rotating" }, secret: secrets[0] }),
              subscribe({ arguments: { repo: "acme/rotating" }, secret: secrets[1] }),
            ],
            { concurrency: 2 },
          );
          const [rotatedOne, rotatedTwo] = yield* Effect.forEach(rotating, (value) =>
            ok(Granted, value),
          );
          expect(rotatedOne!.id).toBe(rotatedTwo!.id);
          const rotatingEvent = yield* emit("acme/rotating", 99);
          const rotatingDelivered = yield* awaitDeliveries((all) =>
            events(all).some((delivery) => delivery.id === rotatingEvent),
          );
          const signedRotating = events(rotatingDelivered).find(
            (delivery) => delivery.id === rotatingEvent && delivery.subscription === rotatedOne!.id,
          );
          expect(signedRotating?.signedBy).not.toBe("");
          // The rest counts only the issues below.
          const tracked = (all: Parameters<typeof events>[0]) =>
            events(all).filter((delivery) => delivery.id !== rotatingEvent);
          // Each matching occurrence arrives once per subscription, signed, with its event ID.
          const first = yield* emit("acme/widgets", 1);
          const other = yield* emit("acme/gadgets", 2);
          const delivered = yield* awaitDeliveries((all) => tracked(all).length >= 3);
          expect(tracked(delivered)).toHaveLength(3);
          for (const delivery of tracked(delivered)) {
            expect(delivery.signedBy).toBe("0");
            const occurrence = yield* Schema.decodeUnknownEffect(Occurrence)(delivery.body);
            expect(occurrence.name).toBe(name);
            expect(delivery.id).toBe(occurrence.eventId);
            expect(Math.abs(Number(delivery.timestamp) * 1000 - Date.now())).toBeLessThan(120_000);
            expect(Number.isNaN(Date.parse(occurrence.timestamp))).toBe(false);
          }
          const to = (subscription: string) =>
            tracked(delivered)
              .filter((delivery) => delivery.subscription === subscription)
              .map((delivery) => delivery.id);
          expect(to(granted.id)).toEqual([first]);
          expect(to(everything.id).sort()).toEqual([first, other].sort());
          const firstBody = yield* Schema.decodeUnknownEffect(Occurrence)(
            tracked(delivered)[0]!.body,
          );
          expect(firstBody.data).toEqual({ title: "Issue 1", number: 1 });

          // The same upstream event, emitted again, is not delivered again.
          yield* emit("acme/widgets", 1, first);
          // A failed invocation keeps none of the events it emitted.
          const failed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${emitter.id}/tools/call`,
            { tool: "broken", kind: "mutation", input: { id: randomUUID() } },
          );
          expect(failed.status).not.toBe(200);
          // A transaction that rolls back discards its events with its writes, even when the
          // invocation catches the failure and succeeds.
          const rolledBack = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${emitter.id}/tools/call`,
            { tool: "rolledBack", kind: "mutation", input: { id: randomUUID() } },
          );
          expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
          expect(JSON.stringify(rolledBack.body)).toContain('"count":0');
          // A later event marks the point by which those would have arrived.
          const marker = yield* emit("acme/marker", 3);
          const marked = yield* awaitDeliveries((all) =>
            tracked(all).some((delivery) => delivery.id === marker),
          );
          expect(tracked(marked)).toHaveLength(4);

          // A failed delivery is retried with the same event ID and a fresh signature.
          expect(
            (yield* callReceiver("respond", "mutation", { statuses: { list: "500" } })).status,
          ).toBe(200);
          const retried = yield* emit("acme/widgets", 4);
          const attempts = yield* awaitDeliveries((all) => {
            const tries = events(all).filter((delivery) => delivery.id === retried);
            return tries.filter((delivery) => delivery.status === 200).length === 2;
          }, 150);
          const tries = events(attempts).filter((delivery) => delivery.id === retried);
          const failedTry = tries.find((delivery) => delivery.status === 500);
          expect(failedTry, JSON.stringify(tries)).toBeDefined();
          expect(tries).toHaveLength(3);
          const retry = tries.find(
            (delivery) =>
              delivery.status === 200 && delivery.subscription === failedTry!.subscription,
          );
          expect(retry).toBeDefined();
          // Re-signed at the retry's own time.
          expect(Number(retry!.timestamp)).toBeGreaterThan(Number(failedTry!.timestamp));

          // 410 refuses that delivery for good; the subscription keeps delivering.
          expect(
            (yield* callReceiver("respond", "mutation", { statuses: { list: "410,410" } })).status,
          ).toBe(200);
          const gone = yield* emit("acme/widgets", 5);
          yield* awaitDeliveries(
            (all) => events(all).filter((delivery) => delivery.id === gone).length >= 2,
          );
          const afterGone = yield* emit("acme/widgets", 6);
          const settled = yield* awaitDeliveries(
            (all) => events(all).filter((delivery) => delivery.id === afterGone).length >= 2,
          );
          expect(events(settled).filter((delivery) => delivery.id === gone)).toHaveLength(2);

          // A refresh with a new secret rotates it; both sign while the previous one overlaps.
          const rotated = yield* ok(Granted, yield* subscribe({ secret: secrets[1] }));
          expect(rotated.id).toBe(granted.id);
          const signedTwice = yield* emit("acme/widgets", 7);
          const rotatedDeliveries = yield* awaitDeliveries(
            (all) => events(all).filter((delivery) => delivery.id === signedTwice).length >= 2,
          );
          const byGranted = events(rotatedDeliveries).find(
            (delivery) => delivery.id === signedTwice && delivery.subscription === granted.id,
          );
          expect(byGranted?.signedBy).toBe("0,1");

          // Unsubscribing stops delivery; repeating it succeeds.
          const unsubscribe = (args: unknown) =>
            rpc("events/unsubscribe", {
              name,
              arguments: args,
              delivery: { mode: "webhook", url: callbackUrl },
            });
          yield* ok(Schema.Struct({}), yield* unsubscribe({ repo: "acme/widgets" }));
          yield* ok(Schema.Struct({}), yield* unsubscribe({ repo: "acme/widgets" }));
          const afterUnsubscribe = yield* emit("acme/widgets", 8);
          const final = yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) =>
                delivery.id === afterUnsubscribe && delivery.subscription === everything.id,
            ),
          );
          expect(
            events(final).filter(
              (delivery) =>
                delivery.id === afterUnsubscribe && delivery.subscription === granted.id,
            ),
          ).toHaveLength(0);

          // Revoking the token that subscribed stops every subscription it made. Another token's
          // subscription marks when the revoked ones would have received the event.
          const otherKey = yield* createKey(`Events marker ${suffix}`);
          const markerSubscription = yield* ok(
            Granted,
            yield* rpcAs(otherKey.key, "events/subscribe", {
              name,
              arguments: {},
              delivery: {
                mode: "webhook",
                url: `${callbackUrl}?variant=marker`,
                secret: secrets[0],
              },
            }),
          );
          const revoked = yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
            keyId: key.id,
          });
          expect(revoked.status).toBe(200);
          const afterRevocation = yield* emit("acme/widgets", 9);
          const revokedDeliveries = yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) =>
                delivery.id === afterRevocation && delivery.subscription === markerSubscription.id,
            ),
          );
          expect(
            events(revokedDeliveries).filter(
              (delivery) =>
                delivery.id === afterRevocation && delivery.subscription !== markerSubscription.id,
            ),
          ).toHaveLength(0);
        }),
      ),
    { timeout: 240_000 },
  );
});
