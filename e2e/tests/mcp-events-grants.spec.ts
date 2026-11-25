import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import {
  EventList,
  Granted,
  appEvent,
  emitterFiles,
  eventFixtures,
  secrets,
} from "../support/events.ts";

const Execute = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

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
            emitFrom,
            deploy,
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

          expect(yield* listed).toEqual([appEvent]);
          const subscription = yield* ok(Granted, yield* subscribe(token, "oauth"));
          const first = yield* emit("acme/widgets", 1);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === first && delivery.subscription === subscription.id,
            ),
          );

          expect((yield* narrow({ tools: { kind: "selected", names: ["open"] } })).status).toBe(
            200,
          );
          const stillDelivered = yield* emit("acme/widgets", 2);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) =>
                delivery.id === stillDelivered && delivery.subscription === subscription.id,
            ),
          );

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
          expect(yield* listedWith(tokenOf(named))).toEqual([appEvent]);
          yield* ok(Granted, yield* subscribe(tokenOf(named), "named"));
          const eventOnlyResponse = (yield* rpcAs(tokenOf(named), "tools/call", {
            name: "execute",
            arguments: {
              code: `const app = tools[${JSON.stringify(emitter.slug)}];
let callable = true;
try { await app({}); } catch { callable = false; }
return { names: Object.keys(tools), callable };`,
            },
          })) as {
            readonly result: { readonly structuredContent: unknown };
          };
          const eventOnly = yield* Schema.decodeUnknownEffect(Execute)(
            eventOnlyResponse.result.structuredContent,
          );
          const eventOnlyValue = eventOnly.execution.value as {
            callable: boolean;
            names: ReadonlyArray<string>;
          };
          expect(eventOnlyValue.callable).toBe(false);
          expect(eventOnlyValue.names).not.toContain(emitter.slug);

          const none = yield* oauth.authorize;
          expect(
            (yield* narrow(
              { tools: { kind: "all" }, events: { kind: "selected", names: [] } },
              none.grantId,
            )).status,
          ).toBe(200);
          expect(yield* listedWith(tokenOf(none))).toEqual([appEvent]);
          expect(yield* refused(yield* subscribe(tokenOf(none), "none"))).toMatchObject({
            code: -32012,
          });
          expect(
            (yield* narrow({ tools: { kind: "all" }, events: { kind: "all" } }, none.grantId))
              .status,
          ).not.toBe(200);

          expect(
            (yield* narrow({
              tools: { kind: "selected", names: ["open"] },
              events: { kind: "selected", names: [] },
            })).status,
          ).toBe(200);
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

          const other = yield* deploy(`Other issue events ${suffix}`, emitterFiles);
          const mixed = yield* oauth.authorize;
          const selection = yield* ok(
            Granted,
            yield* rpcAs(tokenOf(mixed), "events/subscribe", {
              name: appEvent,
              arguments: {},
              delivery: {
                mode: "webhook",
                url: `${callbackUrl}?variant=selection`,
                secret: secrets[0],
              },
            }),
          );
          expect(
            (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
              id: mixed.grantId,
              policy: {
                kind: "tools",
                apps: [
                  {
                    app: emitter.id,
                    tools: { kind: "all" },
                    events: { kind: "selected", names: [] },
                  },
                  { app: other.id, tools: { kind: "all" }, events: { kind: "all" } },
                ],
                approval: "client",
              },
            })).status,
          ).toBe(200);
          const excluded = yield* emit("acme/widgets", 4);
          const included = yield* emitFrom(other, "acme/widgets", 5);
          const both = yield* awaitDeliveries(
            (all) =>
              events(all).some(
                (delivery) => delivery.id === included && delivery.subscription === selection.id,
              ) &&
              events(all).some(
                (delivery) => delivery.id === excluded && delivery.subscription === marker.id,
              ),
          );
          expect(
            events(both).filter(
              (delivery) => delivery.id === excluded && delivery.subscription === selection.id,
            ),
          ).toHaveLength(0);
          const later = yield* emitFrom(other, "acme/widgets", 6);
          yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === later && delivery.subscription === selection.id,
            ),
          );
        }).pipe(Effect.provide(McpOAuth.layer)),
      ),
    { timeout: 180_000 },
  );
});
