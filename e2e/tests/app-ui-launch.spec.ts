import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { helloIndex } from "../support/app-authoring.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { managementApp } from "../support/management-app.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Ready = Schema.Struct({ status: Schema.Literal("ready"), url: Schema.String });
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const refused = "Could not sign in to this app. Try opening it again.";

const deployPage = (name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}/apps`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files: [
        { path: "index.ts", content: helloIndex },
        appsManifest,
        { path: "ui/index.html", content: `<!doctype html><title>${name}</title><h1>${name}</h1>` },
      ],
    });
    expect(deployed.status).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
    );
    const location = `${prefix}/${app.id}/ui`;
    const url = yield* waitForAppUrl(actors.owner, location);
    return { app, origin: new URL(url).origin, location, launch: `${location}/launch` };
  });

const plainHttp = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  return (url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") =>
    http
      .execute(HttpClientRequest.make(method)(url).pipe(HttpClientRequest.setHeaders(headers)))
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (text) => ({
            status: response.status,
            text,
            location: response.headers.location,
            cookie: response.headers["set-cookie"],
          })),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.scoped,
        Effect.orDie,
      );
});

const ownerKey = (name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const key = yield* body(
      Key,
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
    );
    const revoke = api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
      keyId: key.id,
    });
    yield* Effect.addFinalizer(() => revoke.pipe(Effect.ignore));
    return { ...key, revoke };
  });

layer(HostedLive, { excludeTestServices: true })("App launch links", (it) => {
  it.effect(scenarios.appUiLaunch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          mcp = yield* McpClient,
          oauth = yield* McpOAuth;
        const get = yield* plainHttp;
        const notes = yield* deployPage("Launched notes");
        const other = yield* deployPage("Other app");

        yield* managementApp(actors.owner);
        const key = yield* ownerKey("Launch link agent");
        const client = yield* mcp.connect(key.key, "app-launch", {
          organization: actors.organization.id,
        });
        const executed = yield* client.use("Get a launch link through MCP", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools.executor.appUi.launch({ path: ${JSON.stringify({ organization: actors.organization.id, app: notes.app.id })} });`,
              },
            },
            undefined,
            { signal },
          ),
        );
        const link = yield* Schema.decodeUnknownEffect(Ready)(
          (yield* Schema.decodeUnknownEffect(Executed)(executed.structuredContent)).execution.value,
        );
        const launch = new URL(link.url);
        expect(launch.origin).toBe(notes.origin);
        expect(launch.pathname).toBe("/_executor/auth/launch");
        expect([...launch.searchParams.keys()]).toEqual(["code"]);

        expect(yield* get(`${notes.origin}/`)).toMatchObject({
          status: 403,
          text: "App unavailable.",
        });
        expect(yield* get(link.url, {}, "HEAD")).toMatchObject({ status: 405, cookie: undefined });
        expect(yield* get(link.url, { "sec-purpose": "prefetch" })).toMatchObject({
          status: 405,
          cookie: undefined,
        });
        yield* browser.use("Open the launch link with no Executor session", (page) =>
          page.goto(link.url),
        );
        yield* browser.use("The app's page opens at its root", (page) =>
          page.getByRole("heading", { name: "Launched notes" }).waitFor(),
        );
        yield* browser.use("The link lands on the app's root", (page) =>
          page.waitForURL(`${notes.origin}/`),
        );
        const cookies = yield* browser.use("Read the app origin's cookies", (page) =>
          page.context().cookies(notes.origin),
        );
        const secure = launch.protocol === "https:";
        expect(
          cookies.map(({ name, path, httpOnly, secure, sameSite }) => ({
            name,
            path,
            httpOnly,
            secure,
            sameSite,
          })),
        ).toEqual([
          {
            name: secure ? "__Host-executor_app" : "executor_app",
            path: "/",
            httpOnly: true,
            secure,
            sameSite: "Lax",
          },
        ]);
        expect(cookies[0]?.expires).toBeGreaterThan(Date.now() / 1000 + 6 * 24 * 60 * 60);
        const session = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
        const opened = yield* get(`${notes.origin}/`, { cookie: session });
        expect(opened.status).toBe(200);
        expect(opened.text).toContain("<h1>Launched notes</h1>");

        const reused = yield* get(link.url);
        expect(reused).toMatchObject({ status: 401, cookie: undefined });
        expect(reused.text).toContain(refused);

        const owners = yield* body(Ready, yield* api.request(actors.owner, "POST", notes.launch));
        const elsewhere = new URL(owners.url);
        elsewhere.host = new URL(other.origin).host;
        expect(yield* get(elsewhere.href)).toMatchObject({ status: 401, cookie: undefined });
        expect(yield* get(owners.url)).toMatchObject({ status: 401, cookie: undefined });

        const sent = yield* body(Ready, yield* api.request(actors.owner, "POST", notes.launch));
        expect(yield* get(sent.url, { cookie: session })).toMatchObject({
          status: 302,
          location: "/",
          cookie: undefined,
        });

        expect((yield* api.request(actors.member, "GET", notes.location)).status).toBe(403);
        expect((yield* api.request(actors.member, "POST", notes.launch)).status).toBe(403);

        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeApi;
        const anonymous = yield* api.session();
        expect(
          (yield* api.request(anonymous, "POST", notes.launch, undefined, {
            authorization: `Bearer ${Redacted.value(grant.tokens).access_token}`,
          })).status,
        ).toBe(403);
      }).pipe(Effect.provide(Layer.mergeAll(McpClient.layer, McpOAuth.layer))),
    ),
  );

  it.effect(scenarios.appUiLaunchLifetime.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const get = yield* plainHttp;
        const http = yield* HttpClient.HttpClient;
        const notes = yield* deployPage("Short-lived notes");

        const stale = yield* body(Ready, yield* api.request(actors.owner, "POST", notes.launch));
        yield* serverControl("clock/advance", 200, { milliseconds: 61_000 });
        expect(yield* get(stale.url)).toMatchObject({ status: 401, cookie: undefined });

        const key = yield* ownerKey("Launch link key");
        const made = yield* http
          .execute(
            HttpClientRequest.post(`${target.metadata.origin}${notes.launch}`).pipe(
              HttpClientRequest.bearerToken(key.key),
            ),
          )
          .pipe(
            Effect.flatMap((response) => {
              expect(response.status).toBe(200);
              return response.json;
            }),
            Effect.flatMap(Schema.decodeUnknownEffect(Ready)),
            Effect.scoped,
          );
        const redeemed = yield* get(made.url);
        expect(redeemed).toMatchObject({ status: 302, location: "/" });
        const cookie = redeemed.cookie?.split(";")[0];
        expect(cookie).toMatch(/^(__Host-)?executor_app=[a-f0-9]{64}$/u);
        const page = () => get(`${notes.origin}/`, { cookie: cookie ?? "" });
        expect((yield* page()).status).toBe(200);
        expect((yield* key.revoke).status).toBe(200);
        expect(yield* page()).toMatchObject({
          status: 401,
          text: "Sign in to this app to continue.",
        });
      }),
    ),
  );
});
