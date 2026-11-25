import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, SessionClients, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { credentialUpstream } from "../support/credential-upstream.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
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
const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));
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
const RefusalHeader = Schema.StringFromUriComponent.pipe(
  Schema.decodeTo(Schema.fromJsonString(Refused)),
);
const RefusalBody = Schema.fromJsonString(
  Schema.Struct({ ...Refused.fields, message: Schema.String }),
);

const fetchApp = `import { defineApp, json, object, string, query, router } from "apps";
export default defineApp({}, {
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

const deployFetchApp = (api: typeof Api.Service, owner: Session, organization: string) =>
  Effect.gen(function* () {
    const prefix = `/api/organizations/${organization}/apps`;
    const deployed = yield* api.request(owner, "POST", `${prefix}/deploy`, {
      name: `Fetch errors ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: fetchApp }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
    );
    const call = (tool: string, input: object) =>
      api.request(owner, "POST", `${prefix}/${app.id}/tools/call`, {
        tool,
        kind: "query",
        input,
      });
    return { call };
  });

const scenario = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  return yield* deployFetchApp(api, actors.owner, actors.organization.id);
});

const privateAddressRefusal = (host: string) => {
  const message = `Executor refused a request to ${host}: apps on this instance can reach only public addresses, and ${host} is a private, loopback or internal address. The request was not sent.`;
  return { source: "app", errorName: "NetworkRefused", code: "private_address", message };
};

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

        expect((yield* refusedCall("head", { url: `${upstream.origin}/head` })).failure).toEqual(
          failure.failure,
        );

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

layer(TestLive, { excludeTestServices: true })("App private origins", (it) => {
  it.effect(scenarios.appFetchPrivateOriginAllowed.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const allowed = yield* credentialUpstream;
        const other = yield* credentialUpstream;
        const origin = yield* startFreshSelfHost(target, {
          EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "false",
          EXECUTOR_APPS_ALLOW_PRIVATE_ORIGINS: JSON.stringify([
            allowed.origin,
            other.origin.slice(0, -1),
          ]),
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            name: "Egress Owner",
            email: "egress-owner@example.test",
            password: "Synthetic-egress-password-123!",
            organizationName: "Egress lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list"),
        );
        const { call } = yield* deployFetchApp(api, owner, organization.id);
        const reached = (url: string) =>
          call("fetched", { url, init: {} }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => body(Reached, response)),
          );
        const refused = (url: string) =>
          call("fetched", { url, init: {} }).pipe(
            Effect.tap((response) =>
              Effect.sync(() =>
                expect(response.status, JSON.stringify(response.body)).not.toBe(200),
              ),
            ),
            Effect.flatMap((response) => body(ToolFailed, response)),
            Effect.map(({ failure }) => failure),
          );
        const otherHost = `127.0.0.1:${other.port}`;
        const allowedHost = `127.0.0.1:${allowed.port}`;

        expect(yield* reached(`${allowed.origin}/allowed`)).toEqual({ status: 200 });
        expect(
          yield* reached(`${allowed.origin}/redirect?to=${encodeURIComponent("/landed")}`),
        ).toEqual({ status: 200 });

        expect(yield* refused(`${allowed.undeclaredOrigin}/by-name`)).toEqual(
          privateAddressRefusal(`localhost:${allowed.port}`),
        );
        expect(yield* refused(`https://${allowedHost}/tls`)).toEqual(
          privateAddressRefusal(allowedHost),
        );
        expect(yield* refused(`${other.origin}/other`)).toEqual(privateAddressRefusal(otherHost));
        expect(
          yield* refused(
            `${allowed.origin}/redirect?to=${encodeURIComponent(`${other.origin}/escaped`)}`,
          ),
        ).toEqual(privateAddressRefusal(otherHost));

        expect(
          (yield* allowed.received).map((request) => new URL(request.url, "http://x").pathname),
        ).toEqual(["/allowed", "/redirect", "/landed", "/redirect"]);
        expect(yield* other.received).toEqual([]);
      }),
    ),
  );
});
