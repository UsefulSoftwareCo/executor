/**
 * Cloudflare refuses a call into a Worker or Durable Object once its request has entered the
 * Workers runtime too many times. A client that calls Cloud's MCP from deep inside its own Worker
 * chain reaches that limit at the gateway's call to the session object. The gateway must then say
 * why, with a 508 and a JSON-RPC error, instead of an empty 500.
 *
 * A disposable relay Worker calls itself through a service binding `hops` times, then posts an MCP
 * initialize to a deployed stage. The scenario raises `hops` until the relay's own call is refused.
 * Each step adds one Worker invocation, so the deepest request the stage still answers is the one
 * whose call to the session object was refused, and every shallower one initializes.
 *
 * Local workerd does not enforce the limit, so this runs by hand against a deployed stage, with
 * vault-bound Cloudflare credentials to upload and delete the relay:
 * `bunx vitest run --config e2e/subrequest-depth.config.ts`. It needs
 * `SUBREQUEST_DEPTH_MCP_URL`, the stage's MCP endpoint (`https://mcp.<slug>.<test domain>/mcp`),
 * `SUBREQUEST_DEPTH_MCP_KEY`, an API key of a synthetic test account on that stage, and
 * `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
 */
import { randomBytes } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Config, Console, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class DepthScenarioFailed extends Schema.TaggedError<DepthScenarioFailed>()("DepthScenarioFailed", {
  operation: Schema.String,
  status: Schema.optionalKey(Schema.Number),
}) {}

/** Forwards the MCP request it holds once its own hop count reaches zero; holds no state. */
const relaySource = `
export default {
  async fetch(request, env) {
    if (request.method !== "POST" || request.headers.get("x-relay-key") !== env.RELAY_KEY)
      return new Response(null, { status: 404 });
    const url = new URL(request.url);
    const hops = Number(url.searchParams.get("hops"));
    if (!Number.isSafeInteger(hops) || hops < 0) return new Response(null, { status: 400 });
    const body = await request.text();
    const refused = (error) =>
      Response.json({ outcome: "refused", message: error instanceof Error ? error.message : String(error) });
    if (hops > 0) {
      url.searchParams.set("hops", String(hops - 1));
      try {
        return await env.SELF.fetch(url, { method: "POST", headers: request.headers, body });
      } catch (error) {
        return refused(error);
      }
    }
    const headers = new Headers();
    for (const name of ["authorization", "accept", "content-type", "mcp-protocol-version"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    try {
      const answer = await fetch(env.TARGET, { method: "POST", headers, body });
      return Response.json({ outcome: "answered", status: answer.status, text: await answer.text() });
    } catch (error) {
      return refused(error);
    }
  },
};
`;

const CloudflareResult = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
});
const RelayAnswer = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("answered"),
    status: Schema.Number,
    text: Schema.String,
  }),
  Schema.Struct({ outcome: Schema.Literal("refused"), message: Schema.String }),
]);
const RefusalBody = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Null,
    error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
  }),
);
const depthLimit = /^Subrequest depth limit exceeded/u;
/** Well past Cloudflare's 32 Worker invocations per request, so the sweep always ends refused. */
const maximumHops = 64;

layer(Layer.mergeAll(FetchHttpClient.layer), { excludeTestServices: true })(
  "Cloud MCP subrequest depth",
  (it) => {
    it.effect(
      "explains a request refused at the subrequest depth limit instead of failing with an empty 500",
      () =>
        Effect.gen(function* () {
          const target = yield* Config.String("SUBREQUEST_DEPTH_MCP_URL");
          expect(new URL(target).protocol).toBe("https:");
          const credential = yield* Config.Redacted("SUBREQUEST_DEPTH_MCP_KEY");
          const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
          const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
          const http = yield* HttpClient.HttpClient;
          const workers = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers`;
          const cloudflare = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
            Effect.scoped(
              Effect.gen(function* () {
                const response = yield* http.execute(
                  request.pipe(HttpClientRequest.bearerToken(token)),
                );
                const value = yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(CloudflareResult)),
                );
                if (!value.success)
                  return yield* new DepthScenarioFailed({ operation, status: response.status });
                return value.result;
              }),
            ).pipe(
              Effect.mapError((error) =>
                Schema.is(DepthScenarioFailed)(error)
                  ? error
                  : new DepthScenarioFailed({ operation }),
              ),
            );

          const name = `e2e-subrequest-depth-${randomBytes(4).toString("hex")}`;
          const key = randomBytes(24).toString("hex");
          const upload = (bindings: ReadonlyArray<Readonly<Record<string, string>>>) => {
            const form = new FormData();
            form.set(
              "metadata",
              new Blob(
                [
                  JSON.stringify({
                    main_module: "relay.js",
                    compatibility_date: "2026-09-08",
                    bindings: [
                      { type: "secret_text", name: "RELAY_KEY", text: key },
                      { type: "plain_text", name: "TARGET", text: target },
                      ...bindings,
                    ],
                  }),
                ],
                { type: "application/json" },
              ),
            );
            form.set(
              "relay.js",
              new Blob([relaySource], { type: "application/javascript+module" }),
              "relay.js",
            );
            return cloudflare(
              "Upload the relay",
              HttpClientRequest.put(`${workers}/scripts/${name}`).pipe(
                HttpClientRequest.bodyFormData(form),
              ),
            );
          };
          yield* Effect.acquireRelease(upload([]), () =>
            cloudflare(
              "Delete the relay",
              HttpClientRequest.delete(`${workers}/scripts/${name}?force=true`),
            ).pipe(Effect.catch(() => Console.error(`Could not delete the relay Worker ${name}.`))),
          );
          // A service binding names an existing script, so the relay binds itself on its second upload.
          yield* upload([{ type: "service", name: "SELF", service: name }]);
          yield* cloudflare(
            "Enable the relay's workers.dev route",
            yield* HttpClientRequest.post(`${workers}/scripts/${name}/subdomain`).pipe(
              HttpClientRequest.bodyJson({ enabled: true, previews_enabled: false }),
            ),
          );
          const subdomain = yield* cloudflare(
            "Read the workers.dev subdomain",
            HttpClientRequest.get(`${workers}/subdomain`),
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ subdomain: Schema.String }))),
          );
          const relay = `https://${name}.${subdomain.subdomain}.workers.dev`;

          const initialize = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "subrequest-depth", version: "1" },
            },
          });
          const at = (hops: number) =>
            Effect.scoped(
              Effect.gen(function* () {
                const response = yield* http.execute(
                  HttpClientRequest.post(`${relay}/?hops=${hops}`).pipe(
                    HttpClientRequest.setHeaders({
                      "x-relay-key": key,
                      authorization: `Bearer ${Redacted.value(credential)}`,
                      accept: "application/json, text/event-stream",
                      "mcp-protocol-version": "2025-06-18",
                    }),
                    HttpClientRequest.bodyText(initialize, "application/json"),
                  ),
                );
                if (response.status !== 200)
                  return yield* new DepthScenarioFailed({
                    operation: "Call the relay",
                    status: response.status,
                  });
                return yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(RelayAnswer)),
                );
              }),
            ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

          // A new workers.dev route takes a few seconds to answer.
          const shallowest = yield* at(0).pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
          );
          expect(shallowest, "The relay reaches the stage and the key initializes").toMatchObject({
            outcome: "answered",
            status: 200,
          });

          const answers: Array<typeof RelayAnswer.Type> = [shallowest];
          for (let hops = 1; hops <= maximumHops; hops++) {
            const answer = yield* at(hops);
            answers.push(answer);
            if (answer.outcome === "refused") break;
          }
          const sweep = answers.map((answer, hops) =>
            answer.outcome === "answered"
              ? { hops, status: answer.status }
              : { hops, refused: answer.message },
          );
          const refused = answers.at(-1);
          expect(refused?.outcome, JSON.stringify(sweep)).toBe("refused");
          if (refused?.outcome === "refused")
            expect(refused.message, "The sweep reached the platform's own limit").toMatch(
              depthLimit,
            );

          const answered = answers.flatMap((answer) =>
            answer.outcome === "answered" ? [answer] : [],
          );
          expect(answered.length, JSON.stringify(sweep)).toBe(answers.length - 1);
          const deepest = answered.at(-1);
          expect(
            answered.slice(0, -1).map((answer) => answer.status),
            "Every shallower request initializes",
          ).toEqual(answered.slice(0, -1).map(() => 200));
          expect(deepest?.status, JSON.stringify(sweep)).toBe(508);
          const body = yield* Schema.decodeUnknownEffect(RefusalBody)(deepest?.text ?? "");
          expect(body.error.code).toBe(-32000);
          expect(body.error.message).toMatch(depthLimit);
          expect(body.error.message).toContain("Call Executor from a shallower point");
        }),
    );
  },
);
