/**
 * Who may receive an app's events. A grant selects an app's events beside its tools: all of them,
 * including later ones, when it omits the choice, or exact names. Selecting none removes them from
 * `events/list`, refuses new subscriptions, and stops the deliveries it already subscribed to.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { EventList, Granted, eventFixtures, secrets } from "../support/events.ts";

layer(HostedLive, { excludeTestServices: true })("MCP event grants", (it) => {
  it.effect(
    scenarios.mcpEventGrants.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            oauth = yield* McpOAuth;
          const {
            emitter,
            callbackUrl,
            awaitDeliveries,
            events,
            emit,
            rpcAs,
            ok,
            refused,
            createKey,
            name,
            suffix,
          } = yield* eventFixtures;
          yield* browser.login(actors.owner);
          const grant = yield* oauth.authorize;
          const token = Redacted.make(Redacted.value(grant.tokens).access_token);
          const listedWith = (credential: Redacted.Redacted<string>) =>
            rpcAs(credential, "events/list").pipe(
              Effect.flatMap((value) => ok(EventList, value)),
              Effect.map((list) => list.events.map((event) => event.name)),
            );
          const listed = listedWith(token);
          const subscribe = (credential: Redacted.Redacted<string>, variant: string) =>
            rpcAs(credential, "events/subscribe", {
              name,
              arguments: {},
              delivery: {
                mode: "webhook",
                url: `${callbackUrl}?variant=${variant}`,
                secret: secrets[0],
              },
            });
          const narrow = (permission: Record<string, unknown>, id = grant.grantId) =>
            api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
              id,
              policy: {
                kind: "tools",
                apps: [{ app: emitter.id, ...permission }],
                approval: "client",
              },
            });
          const tokenOf = (issued: typeof grant) =>
            Redacted.make(Redacted.value(issued.tokens).access_token);

          // A grant of everything includes the app's events.
          expect(yield* listed).toContain(name);
          const subscription = yield* ok(Granted, yield* subscribe(token, "oauth"));
          const first = yield* emit("acme/widgets", 1);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === first && delivery.subscription === subscription.id,
            ),
          );

          // Events are chosen beside tools, not derived from them: naming one tool and omitting
          // the event scope keeps every event.
          expect((yield* narrow({ tools: { kind: "selected", names: ["open"] } })).status).toBe(
            200,
          );
          expect(yield* listed).toContain(name);
          const stillDelivered = yield* emit("acme/widgets", 2);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) =>
                delivery.id === stillDelivered && delivery.subscription === subscription.id,
            ),
          );

          // A grant that names the event includes it even with no tools.
          const named = yield* oauth.authorize;
          expect(
            (yield* narrow(
              {
                tools: { kind: "selected", names: [] },
                events: { kind: "selected", names: ["issue.opened"] },
              },
              named.grantId,
            )).status,
          ).toBe(200);
          expect(yield* listedWith(tokenOf(named))).toContain(name);
          yield* ok(Granted, yield* subscribe(tokenOf(named), "named"));

          // A grant that selects no events hides them and refuses subscribing, and narrowing can
          // never add them back.
          const none = yield* oauth.authorize;
          expect(
            (yield* narrow(
              { tools: { kind: "all" }, events: { kind: "selected", names: [] } },
              none.grantId,
            )).status,
          ).toBe(200);
          expect(yield* listedWith(tokenOf(none))).not.toContain(name);
          expect(yield* refused(yield* subscribe(tokenOf(none), "none"))).toMatchObject({
            code: -32012,
          });
          expect(
            (yield* narrow({ tools: { kind: "all" }, events: { kind: "all" } }, none.grantId))
              .status,
          ).not.toBe(200);

          // Narrowing the subscribed grant to no events hides them, refuses new subscriptions,
          // and stops its existing one at its next delivery. Another token's subscription marks
          // when it would have arrived.
          expect(
            (yield* narrow({
              tools: { kind: "selected", names: ["open"] },
              events: { kind: "selected", names: [] },
            })).status,
          ).toBe(200);
          expect(yield* listed).not.toContain(name);
          expect(yield* refused(yield* subscribe(token, "oauth-narrowed"))).toMatchObject({
            code: -32012,
          });
          const markerKey = yield* createKey(`Event grants marker ${suffix}`);
          const marker = yield* ok(Granted, yield* subscribe(markerKey.key, "marker"));
          const second = yield* emit("acme/widgets", 3);
          const delivered = yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === second && delivery.subscription === marker.id,
            ),
          );
          expect(
            events(delivered).filter(
              (delivery) => delivery.id === second && delivery.subscription === subscription.id,
            ),
          ).toHaveLength(0);
        }).pipe(Effect.provide(McpOAuth.layer)),
      ),
    { timeout: 180_000 },
  );
});
