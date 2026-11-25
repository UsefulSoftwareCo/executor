import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Effect, Layer, Redacted, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { scenarios } from "../test-plan.ts";
import { body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { Target } from "../support/platform.ts";
import {
  EventList,
  Granted,
  RpcResult,
  appEvent,
  emitterFiles,
  meta,
  revision,
  secrets,
} from "../support/events.ts";

interface Received {
  readonly at: number;
  readonly kind: "verification" | "event";
  readonly id: string;
  readonly subscription: string;
  readonly signed: boolean;
  readonly status: number;
  readonly body: string;
}

const receiver = Effect.gen(function* () {
  const received: Received[] = [];
  const key = Buffer.from(secrets[0].slice("whsec_".length), "base64");
  let failNext = true;
  const closed = { count: 0, after: 0 };
  let stalledAt = 0;
  const routes = HttpRouter.add(
    "POST",
    "/hook",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text;
      const id = request.headers["webhook-id"] ?? "";
      const timestamp = request.headers["webhook-timestamp"] ?? "";
      const expected = `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${text}`).digest("base64")}`;
      const signed = (request.headers["webhook-signature"] ?? "").split(" ").includes(expected);
      const message = JSON.parse(text) as { type?: string; challenge?: string };
      const kind = message.type === "verification" ? "verification" : "event";
      const data = (message as { data?: { number?: number } }).data;
      const stalled = kind === "event" && data?.number === 5;
      const status = stalled ? 410 : kind === "event" && failNext ? 503 : 200;
      if (kind === "event" && !stalled) failNext = false;
      received.push({
        at: Date.now(),
        kind,
        id,
        subscription: request.headers["x-mcp-subscription-id"] ?? "",
        signed,
        status,
        body: text,
      });
      if (stalled) stalledAt = Date.now();
      if (stalled)
        return HttpServerResponse.stream(
          Stream.concat(Stream.make(new TextEncoder().encode("partial")), Stream.never).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                closed.count += 1;
                closed.after = Date.now() - stalledAt;
              }),
            ),
          ),
          { status },
        );
      return kind === "verification"
        ? HttpServerResponse.jsonUnsafe({ challenge: message.challenge })
        : HttpServerResponse.empty({ status });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected a TCP receiver");
  return { url: `http://127.0.0.1:${server.address.port}/hook`, received, closed };
});

layer(TestLive, { excludeTestServices: true })("Local MCP events", (it) => {
  it.effect(
    scenarios.localMcpEvents.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            http = yield* HttpClient.HttpClient;
          const operator = yield* pairLocalOperator;
          const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
          const deployed = yield* operator.send(
            "POST",
            "/v1/apps/deploy",
            {
              owner: "local",
              name: `Local events ${randomUUID().slice(0, 8)}`,
              files: emitterFiles,
            },
            headers,
          );
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const { app } = yield* body(Schema.Struct({ app: App }), deployed);
          yield* Effect.addFinalizer(() =>
            operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
          );
          const hook = yield* receiver;
          const rpc = (method: string, params: Readonly<Record<string, unknown>> = {}) =>
            Effect.gen(function* () {
              const request = HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
                HttpClientRequest.bearerToken(Redacted.value(target.apiKey)),
                HttpClientRequest.setHeaders({
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                  "mcp-protocol-version": revision,
                  "mcp-method": method,
                }),
              );
              const response = yield* http.execute(
                yield* HttpClientRequest.bodyJson(request, {
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  params: { ...params, _meta: meta },
                }),
              );
              const value = yield* response.json;
              return (yield* Schema.decodeUnknownEffect(RpcResult)(value).pipe(
                Effect.tapError(() => Effect.sync(() => expect.fail(JSON.stringify(value)))),
              )).result;
            }).pipe(Effect.scoped);
          const name = `${app.slug}.issue.opened`;
          const emit = (repo: string, number: number) =>
            Effect.gen(function* () {
              const id = randomUUID();
              const response = yield* operator.send(
                "POST",
                "/v1/tools/call",
                {
                  app: app.id,
                  tool: "open",
                  kind: "mutation",
                  input: { repo, title: `Issue ${number}`, number, id },
                },
                headers,
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return id;
            });
          const awaitReceived = (ready: () => boolean) =>
            Effect.gen(function* () {
              const deadline = (yield* Clock.currentTimeMillis) + 30_000;
              while (!ready()) {
                expect(yield* Clock.currentTimeMillis, JSON.stringify(hook.received)).toBeLessThan(
                  deadline,
                );
                yield* Effect.sleep("200 millis");
              }
            });

          const listed = yield* Schema.decodeUnknownEffect(EventList)(yield* rpc("events/list"));
          expect(listed.events.map((event) => event.name)).toEqual([appEvent]);
          const granted = yield* Schema.decodeUnknownEffect(Granted)(
            yield* rpc("events/subscribe", {
              name,
              arguments: { repo: "acme/widgets" },
              delivery: { mode: "webhook", url: hook.url, secret: secrets[0] },
            }),
          );
          expect(hook.received).toMatchObject([
            { kind: "verification", subscription: granted.id, signed: true },
          ]);

          const first = yield* emit("acme/widgets", 1);
          yield* emit("acme/gadgets", 2);
          yield* awaitReceived(() =>
            hook.received.some((item) => item.id === first && item.status === 200),
          );
          const attempts = hook.received.filter((item) => item.kind === "event");
          expect(attempts.map((item) => [item.id, item.status, item.signed])).toEqual([
            [first, 503, true],
            [first, 200, true],
          ]);
          expect(JSON.parse(attempts[1]!.body)).toMatchObject({
            eventId: first,
            name,
            data: { title: "Issue 1", number: 1 },
            cursor: null,
          });

          const stalled = yield* emit("acme/widgets", 5);
          yield* awaitReceived(() => hook.received.some((item) => item.id === stalled));
          yield* awaitReceived(() => hook.closed.count === 1);
          expect(hook.closed.after).toBeLessThan(3_000);
          yield* Effect.sleep("18 seconds");
          expect(
            hook.received.filter((item) => item.id === stalled),
            JSON.stringify(hook.received.map(({ body: _body, ...item }) => item)),
          ).toHaveLength(1);

          expect(
            yield* rpc("events/unsubscribe", {
              name,
              arguments: { repo: "acme/widgets" },
              delivery: { mode: "webhook", url: hook.url },
            }),
          ).toEqual(expect.objectContaining({}));
          const marker = yield* Schema.decodeUnknownEffect(Granted)(
            yield* rpc("events/subscribe", {
              name,
              arguments: { repo: "acme/marker" },
              delivery: { mode: "webhook", url: hook.url, secret: secrets[0] },
            }),
          );
          const dropped = yield* emit("acme/widgets", 3);
          const marked = yield* emit("acme/marker", 4);
          yield* awaitReceived(() =>
            hook.received.some((item) => item.id === marked && item.subscription === marker.id),
          );
          expect(hook.received.filter((item) => item.id === dropped)).toHaveLength(0);

          const everything = yield* Schema.decodeUnknownEffect(Granted)(
            yield* rpc("events/subscribe", {
              name: appEvent,
              arguments: {},
              delivery: { mode: "webhook", url: hook.url, secret: secrets[0] },
            }),
          );
          const selected = yield* emit("acme/selected", 6);
          yield* awaitReceived(() =>
            hook.received.some(
              (item) => item.id === selected && item.subscription === everything.id,
            ),
          );
          const delivery = hook.received.find(
            (item) => item.id === selected && item.subscription === everything.id,
          );
          expect(JSON.parse(delivery!.body)).toMatchObject({
            eventId: selected,
            name: appEvent,
            data: { app: app.slug, event: "issue.opened", data: { title: "Issue 6", number: 6 } },
          });
        }),
      ),
    { timeout: 120_000 },
  );
});
