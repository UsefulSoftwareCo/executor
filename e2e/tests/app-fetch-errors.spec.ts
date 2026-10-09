/**
 * App code's `ctx.fetch` fails with a typed error that names the cause when Executor, not the
 * service, stopped the request: the instance's network refused its destination, or the app
 * runtime does not implement one of its RequestInit options. Neither looks like a service's
 * response.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { credentialUpstream } from "../support/credential-upstream.ts";
import { Target } from "../support/platform.ts";

const ToolFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.optional(Schema.String),
    message: Schema.String,
  }),
});
const Reached = Schema.Struct({ status: Schema.Number });
const Answered = Schema.Struct({
  status: Schema.Number,
  refused: Schema.NullOr(Schema.String),
  text: Schema.String,
});
const Refused = Schema.Struct({
  _tag: Schema.Literal("NetworkRefused"),
  host: Schema.String,
  refusal: Schema.Struct({ reason: Schema.String }),
});
/** The refusal header carries the encoded error, URI-encoded; the body adds its message. */
const RefusalHeader = Schema.StringFromUriComponent.pipe(
  Schema.decodeTo(Schema.fromJsonString(Refused)),
);
const RefusalBody = Schema.fromJsonString(
  Schema.Struct({ ...Refused.fields, message: Schema.String }),
);

/** `ctx.fetch` with the given options, and the platform's global `fetch` for comparison. */
const fetchApp = `import { defineApp, json, object, string, query, router } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({
    fetched: query({ input: object({ url: string(), init: json() }) }, async (ctx, { url, init }) => {
      const response = await ctx.fetch(url, init);
      return { status: response.status };
    }),
    global: query({ input: object({ url: string() }) }, async (_ctx, { url }) => {
      const response = await fetch(url);
      return { status: response.status, refused: response.headers.get("x-executor-refused"), text: await response.text() };
    }),
    // A HEAD response has no body, so the refusal must travel in its header.
    head: query({ input: object({ url: string() }) }, async (ctx, { url }) => {
      const response = await ctx.fetch(url, { method: "HEAD" });
      return { status: response.status };
    }),
  }),
});`;

const scenario = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `Fetch errors ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: fetchApp }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
  );
  const call = (tool: string, input: object) =>
    api.request(actors.owner, "POST", `${prefix}/${app.id}/tools/call`, {
      tool,
      kind: "query",
      input,
    });
  return { call };
});

layer(HostedLive, { excludeTestServices: true })("App fetch errors", (it) => {
  it.effect(scenarios.appFetchPrivateRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { call } = yield* scenario;
        const origin = (yield* Target).metadata.origin;
        const upstream = yield* credentialUpstream;
        const host = `127.0.0.1:${upstream.port}`;

        const message = `Executor refused a request to ${host}: apps on this instance can reach only public addresses, and ${host} is a private, loopback or internal address. The request was not sent.`;
        const refusedCall = (tool: string, input: object) =>
          call(tool, input).pipe(
            Effect.tap((response) =>
              Effect.sync(() =>
                expect(response.status, JSON.stringify(response.body)).not.toBe(200),
              ),
            ),
            Effect.flatMap((response) => body(ToolFailed, response)),
          );

        // ctx.fetch rejects with Executor's refusal, naming the host and the policy.
        const failure = yield* refusedCall("fetched", {
          url: `${upstream.origin}/private`,
          init: {},
        });
        expect(failure.failure).toEqual({
          source: "app",
          errorName: "NetworkRefused",
          code: "private_address",
          message,
        });
        expect(failure.reason).toBe(`The app threw NetworkRefused (private_address): ${message}`);

        // A refused HEAD request, whose response has no body, rejects the same way.
        expect((yield* refusedCall("head", { url: `${upstream.origin}/head` })).failure).toEqual(
          failure.failure,
        );

        // The global fetch receives Executor's marked refusal, not a status a service could send.
        const answered = yield* body(
          Answered,
          yield* call("global", { url: `${upstream.origin}/global` }),
        );
        expect(answered.status).toBe(421);
        const refused = { _tag: "NetworkRefused", host, refusal: { reason: "private_address" } };
        expect(Schema.decodeUnknownSync(RefusalHeader)(answered.refused)).toEqual(refused);
        expect(Schema.decodeUnknownSync(RefusalBody)(answered.text)).toEqual({
          ...refused,
          message,
        });

        // The instance's own origin stays reachable, as the bundled Executor app needs.
        const own = yield* call("fetched", { url: `${origin}/health`, init: {} });
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect((yield* body(Reached, own)).status).toBe(200);

        expect(yield* upstream.received).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.appFetchUnsupportedOption.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { call } = yield* scenario;
        const origin = (yield* Target).metadata.origin;
        const option = (init: object) =>
          call("fetched", { url: `${origin}/health`, init }).pipe(
            Effect.tap((response) =>
              Effect.sync(() =>
                expect(response.status, JSON.stringify(response.body)).not.toBe(200),
              ),
            ),
            Effect.flatMap((response) => body(ToolFailed, response)),
          );

        const redirect = yield* option({ redirect: "error" });
        expect(redirect.failure).toEqual({
          source: "app",
          errorName: "FetchOptionUnsupported",
          code: "redirect",
          message: `fetch option redirect: "error" is not supported by Executor's app runtime. Use "follow" or "manual", or omit redirect. To reject redirects, send redirect: "manual" and treat a 3xx response as the error.`,
        });
        const cache = yield* option({ cache: "force-cache" });
        expect(cache.failure).toMatchObject({ errorName: "FetchOptionUnsupported", code: "cache" });
        expect(cache.failure.message).toContain(`Use "no-store" or "no-cache"`);
        const integrity = yield* option({ integrity: "sha256-synthetic" });
        expect(integrity.failure).toEqual({
          source: "app",
          errorName: "FetchOptionUnsupported",
          code: "integrity",
          message: `fetch option integrity: "sha256-synthetic" is not supported by Executor's app runtime. Use "", or omit integrity. To check a digest, read the body and hash it with crypto.subtle.digest.`,
        });

        // Supported values are sent.
        const manual = yield* call("fetched", {
          url: `${origin}/health`,
          init: { redirect: "manual", cache: "no-store", integrity: "" },
        });
        expect(manual.status, JSON.stringify(manual.body)).toBe(200);
        yield* body(Reached, manual);
      }),
    ),
  );
});
