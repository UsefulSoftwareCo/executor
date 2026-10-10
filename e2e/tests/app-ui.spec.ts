/** The private app protocol is checked through each real hosted product and its browser runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { readAdvice } from "../support/write-outcome.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import {
  committedDocuments,
  recordAppOpening,
  screens,
  type Entry,
} from "../support/app-open-timeline.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { password } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";

import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { managementApp } from "../support/management-app.ts";
import { holdQuery } from "../support/query-transition.ts";
import { appsManifest } from "../support/apps-release.ts";
import { targetHosts } from "../support/role-hosts.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, query, mutation, object, string, router } from "apps";
export const list = query({ input: object({}) }, async ({ sql }) =>
  sql.exec("SELECT body FROM messages ORDER BY seq").toArray().map((row) => row.body));
export const save = mutation({ input: object({ body: string() }) }, async ({ sql }, input) => {
  sql.exec("INSERT INTO messages (body) VALUES (?)", input.body); return input.body;
});
export default defineApp({ accounts: {} }, {  tools: router({
    list,
    save,
  }) });`,
  },
  {
    path: "migrations/0001_messages.sql",
    content: "CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);\n",
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Private app</title><link rel="stylesheet" href="./style.css"><link rel="canonical" href="inbox"><style>.inline-mark { background-image: url("./mark.svg"); } .inline-mark::after { content: "url(mark.svg)"; } .escaped-mark { background-image: url("mark\\2e svg"); } .syntax-mark { background-image: u\\72l(mark.svg); border-image-source: url("mark.svg"/**/); }</style><style>@import"imported.css";</style><style>@import " https://[</style></head><body>
<main><h1>Private app</h1><img src="./mark.svg" alt="Fixture logo"><img alt="Responsive mark" srcset="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='4'%20height='4'%3E%3C/svg%3E 1x, mark.svg 2x"><div class="inline-mark" style="border-image-source: url(mark.svg)"></div><div class="escaped-mark"></div><div class="syntax-mark"></div><svg width="24" height="24"><use href="mark.svg#mark"></use></svg><input type="image" src="mark.svg" alt="Image button"><nav><a href="#/files">Files changed</a></nav><form><label>Message<input name="message"></label><button>Save message</button></form><ul aria-label="Messages"></ul><p role="status">Loading</p></main><script type="module" src="./main.ts"></script></body></html>`,
  },
  { path: "ui/style.css", content: ":root { --fixture-asset: loaded; }" },
  { path: "ui/public/imported.css", content: ":root { --inline-import: loaded; }" },
  {
    path: "ui/badge.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="navy"/></svg>',
  },
  {
    path: "ui/public/mark.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="teal"/></svg>',
  },
  {
    path: "ui/main.ts",
    content: `import { array, string } from "apps";
import { createAppClient, queryReference, mutationReference } from "apps/client";
import type { list, save } from "../index.ts";
import badge from "./badge.svg";
const imported = document.createElement('img');
imported.alt = "Imported badge";
imported.src = badge;
imported.dataset.required = String(require("./badge.svg") === badge);
document.querySelector('main').append(imported);
const client = createAppClient();
const status = document.querySelector('[role="status"]');
const load = async () => {
 const rows = await client.query(queryReference<typeof list>("list"), {}, array(string()));
 document.querySelector('ul').replaceChildren(...rows.map((body) => { const li = document.createElement('li'); li.textContent = body; return li; }));
 status.textContent = "Ready";
};
document.querySelector('form').addEventListener('submit', (event) => {
 event.preventDefault();
 const body = new FormData(event.currentTarget).get('message');
 client.mutate(mutationReference<typeof save>("save"), { body }, string()).then(load).catch(() => { status.textContent = "Save failed"; });
});
load().catch(() => { status.textContent = "Load failed"; });`,
  },
  appsManifest,
];
const Location = Schema.Struct({ url: Schema.String });
const OperationSecurity = Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String)));
const PublicOperation = Schema.Struct({ operationId: Schema.String, security: OperationSecurity });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
/** A declared Executor API error, as MCP returns it from a failed Executor app call. */
const ApiFailure = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({
        code: Schema.String,
        status: Schema.Number,
        message: Schema.String,
        recovery: Schema.optional(
          Schema.Struct({ action: Schema.String, instructions: Schema.String }),
        ),
        retryable: Schema.Boolean,
      }),
    }),
  }),
});

/** Sign-in is redirects only: no host-owned page renders and nothing says "Opening app…". */
const expectNoSignInPages = (timeline: ReadonlyArray<Entry>) => {
  expect(screens(timeline)).not.toContain("Opening app…");
  expect(
    committedDocuments(timeline)
      .map((url) => url.pathname)
      .filter((path) => path === "/app-auth" || path.startsWith("/_executor/auth/")),
  ).toEqual([]);
};

const appFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser,
    target = yield* Target;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Private UI ${randomUUID().slice(0, 8)}`,
    files,
  });
  expect(deployed.status).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
  expect(new URL(url).hostname.split(".").slice(0, 2).join(".")).toBe(
    `${app.slug}.${actors.organization.slug}`,
  );
  const bookmark = `${url}/inbox/unread?filter=new#latest`;
  return { api, actors, browser, target, prefix, app, url, bookmark };
});

/** The owner's browser grants an MCP client that addresses the owner's Executor profile. */
const mcpSession = Effect.gen(function* () {
  const actors = yield* Actors,
    browser = yield* Browser,
    oauth = yield* McpOAuth,
    mcp = yield* McpClient;
  yield* browser.login(actors.owner);
  const { profile } = yield* managementApp(actors.owner);
  expect(profile.accounts.service).toBeTypeOf("string");
  const tools = `tools.executor.profiles[${JSON.stringify(profile.id)}]`;
  const grant = yield* oauth.authorize;
  yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
  const client = yield* mcp.connect(
    Redacted.make(Redacted.value(grant.tokens).access_token),
    "app-ui-discovery",
  );
  return { tools, client };
});

layer(HostedLive, { excludeTestServices: true })("Private app pages", (it) => {
  it.effect(scenarios.appUiApiDocument.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const anonymous = yield* api.session();
        const apiDocument = yield* body(
          Schema.Struct({
            paths: Schema.Record(Schema.String, Schema.Record(Schema.String, PublicOperation)),
            components: Schema.Struct({
              securitySchemes: Schema.Record(Schema.String, Schema.Json),
            }),
          }),
          yield* api.request(anonymous, "GET", "/openapi.json"),
        );
        expect(Object.keys(apiDocument.paths)).toContain(
          "/api/organizations/{organization}/apps/{app}/ui",
        );
        expect(Object.keys(apiDocument.paths)).not.toContain("/api/app-ui/authorize");
        expect(Object.keys(apiDocument.paths)).toContain("/api/viewer");
        const { app: management, profile } = yield* managementApp(actors.owner);
        expect(profile.accounts.service).toBeTypeOf("string");
        const source = yield* body(
          Schema.Struct({
            files: Schema.Array(
              Schema.Struct({
                path: Schema.String,
                content: Schema.String,
              }),
            ),
          }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${management.id}/source`),
        );
        const configurationFile = source.files.find((file) => file.path === "openapi.json");
        if (configurationFile === undefined)
          return yield* Effect.die("Executor app has no live OpenAPI configuration");
        const configuration = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              source: Schema.Struct({ url: Schema.String }),
              baseUrl: Schema.String,
              allowedOrigin: Schema.String,
              securitySchemes: Schema.Record(Schema.String, Schema.Json),
            }),
          ),
        )(configurationFile.content);
        // The Executor app calls the API at its canonical origin.
        const apiOrigin = targetHosts(target).api;
        expect(configuration.source.url).toBe(`${apiOrigin}/openapi.json`);
        expect(configuration.baseUrl).toBe(apiOrigin);
        expect(configuration.allowedOrigin).toBe(new URL(apiOrigin).origin);
        expect(configuration.securitySchemes).toEqual(apiDocument.components.securitySchemes);
      }),
    ),
  );
  it.effect(scenarios.appUiMcpSearch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { tools, client } = yield* mcpSession;
        const search = yield* client.use(
          "Discover the app URL tool through MCP",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  // Every page of matches, so a tool cannot hide on a later page.
                  code: `const items = [];
for (let page = await tools.search({ query: "executor", limit: 100 }); ; page = await tools.search(page.next)) {
  items.push(...page.items.map(({ path }) => ({ path })));
  if (page.next === null) break;
}
return { items };`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const discovered = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ path: Schema.String })),
          }),
        )((yield* Schema.decodeUnknownEffect(Completed)(search.structuredContent)).execution.value);
        expect(discovered.items.map((item) => item.path)).toContain(`${tools}.appUi.location`);
        expect(discovered.items.map((item) => item.path)).not.toContain(`${tools}.appUi.authorize`);
        expect(discovered.items.map((item) => item.path)).not.toContain(`${tools}.viewer.get`);
        expect(discovered.items.map((item) => item.path)).not.toContain(
          `${tools}.appData.subscribe`,
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.appUiMcpFailures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { tools, client } = yield* mcpSession;
        const organization = { organization: actors.organization.id };
        const run = (label: string, code: string) =>
          client.use(label, (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        const name = `Address proof ${randomUUID().slice(0, 8)}`;
        const created = yield* run(
          "Create an app without deploying it",
          `return await ${tools}.appManagement.create(${JSON.stringify({ path: organization, body: { name, files } })});`,
        );
        const app = yield* Schema.decodeUnknownEffect(App)(
          (yield* Schema.decodeUnknownEffect(Completed)(created.structuredContent)).execution.value,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(
              actors.owner,
              "DELETE",
              `/api/organizations/${actors.organization.id}/apps/${app.id}`,
            )
            .pipe(Effect.orDie),
        );
        // The app's page has no address until its first deployment, and the error says so.
        const location = yield* run(
          "Get the URL of an app that has never been deployed",
          `return await ${tools}.appUi.location({ path: ${JSON.stringify({ ...organization, app: app.id })} });`,
        );
        expect(
          (yield* Schema.decodeUnknownEffect(ApiFailure)(location.structuredContent)).execution
            .error,
        ).toEqual({
          message:
            "AppNotDeployed (HTTP 409): The app has no active deployment to load. Recovery: Open Source and deploy the app before using its tools or accounts. Retryable (unchanged call): no.",
          response: {
            code: "AppNotDeployed",
            status: 409,
            message: "The app has no active deployment to load.",
            recovery: expect.any(Object),
            retryable: false,
          },
        });
        // A different name with the same generated address names the app that holds it.
        const taken = yield* run(
          "Create an app whose name produces an existing app's address",
          `return await ${tools}.appManagement.create(${JSON.stringify({ path: organization, body: { name: name.toLowerCase().replaceAll(" ", "-"), files } })});`,
        );
        const message = `The app “${name}” (${app.id}) already uses the address “${app.slug}”, which this name also produces. Choose a different name, or deploy to that app by its ID.`;
        // Creating an app may write, so a failed create is reported as an unknown outcome even
        // though Executor refuses a taken address before it creates anything. Accurate copy for
        // such definite refusals is a separate follow-up; this is the conservative, safe text.
        const declared = {
          action: "Read the API’s error to determine the next step.",
          instructions:
            "An API the app calls returned an error its OpenAPI document declares (AppSlugTaken, HTTP 409). Read its message to decide whether the input, the account's access or the API is at fault.",
        };
        const recovery = {
          action:
            "Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.",
          instructions: `This call may have changed data or may still complete. A safe read can show effects but cannot rule out later completion. Tell the user what is known and get their agreement before repeating the change. ${readAdvice(`${declared.action} ${declared.instructions}`)} Repairing the cause does not establish whether the earlier call completed.`,
        };
        expect(
          (yield* Schema.decodeUnknownEffect(ApiFailure)(taken.structuredContent)).execution.error,
        ).toEqual({
          message: `AppSlugTaken (HTTP 409): ${message} Recovery: ${recovery.action} Retryable (unchanged call): no.`,
          response: { code: "AppSlugTaken", status: 409, message, recovery, retryable: false },
        });
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.appUiDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, app, url } = yield* appFixture;
        const { tools, client } = yield* mcpSession;
        const lookup = yield* client.use(
          "Get the canonical app URL using the MCP grant",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await ${tools}.appUi.location({ path: ${JSON.stringify({ organization: actors.organization.id, app: app.id })} });`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const mcpLocation = yield* Schema.decodeUnknownEffect(Location)(
          (yield* Schema.decodeUnknownEffect(Completed)(lookup.structuredContent)).execution.value,
        );
        expect(mcpLocation.url).toBe(url);
        const denied = yield* client.use(
          "An MCP grant cannot discover another organization's URL",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await ${tools}.appUi.location({ path: ${JSON.stringify({ organization: "other-organization", app: app.id })} });`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const failed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({ ok: Schema.Literal(false) }),
          }),
        )(denied.structuredContent);
        expect(failed.execution.ok).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.appUiFileProbes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { url, target } = yield* appFixture;
        const http = yield* HttpClient.HttpClient;
        const known = new URL(url);
        const missingApp = new URL(url);
        missingApp.hostname = `missing-app.${known.hostname.split(".").slice(1).join(".")}`;
        const missingOrganization = new URL(url);
        missingOrganization.hostname = `${known.hostname.split(".")[0]}.missing-organization.${known.hostname.split(".").slice(2).join(".")}`;
        const send = (request: HttpClientRequest.HttpClientRequest, accept: string) =>
          request.pipe(
            HttpClientRequest.setHeader("accept", accept),
            http.execute,
            Effect.flatMap((response) =>
              Effect.map(response.text, (body) => ({
                outcome: { status: response.status, body },
                headers: response.headers,
              })),
            ),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          );
        const read = (origin: URL, path: string, accept: string) =>
          send(HttpClientRequest.get(new URL(path, origin).href), accept).pipe(
            Effect.map(({ outcome }) => outcome),
          );
        const sendAnonymously = (
          origin: URL,
          path: string,
          method: "GET" | "HEAD" | "POST" | "PUT" | "OPTIONS" = "GET",
        ) => send(HttpClientRequest.make(method)(new URL(path, origin).href), "*/*");
        const fetchAnonymously = (
          origin: URL,
          path: string,
          method?: "GET" | "HEAD" | "POST" | "PUT" | "OPTIONS",
        ) => sendAnonymously(origin, path, method).pipe(Effect.map(({ outcome }) => outcome));
        const probe = yield* fetchAnonymously(known, "/.env");
        expect(probe).toEqual({ status: 403, body: "App unavailable." });
        expect(yield* fetchAnonymously(known, "/%2eenv")).toEqual(probe);
        expect(yield* fetchAnonymously(known, "/")).toEqual(probe);
        expect(yield* fetchAnonymously(missingApp, "/.env")).toEqual(probe);
        expect(yield* fetchAnonymously(missingApp, "/admin")).toEqual(probe);
        // Scanners send other methods to paths no app route accepts. They are not found, not a
        // server failure (previously Cloud answered 503 "App unavailable.").
        for (const [origin, path, method] of [
          [known, "/wp-json/batch/v1", "POST"],
          [known, "/", "POST"],
          [known, "/index.php", "PUT"],
          [known, "/", "OPTIONS"],
          [missingApp, "/", "POST"],
        ] as const) {
          const missing = yield* sendAnonymously(origin, path, method);
          expect(missing.outcome, `${method} ${path}`).toEqual({ status: 404, body: "" });
          // Cloud's app-origin Worker answers with the app's private headers.
          if (target.metadata.target === "cloud") {
            expect(missing.headers["cache-control"], `${method} ${path}`).toBe("no-store");
          }
        }
        expect((yield* fetchAnonymously(known, "/index.html", "HEAD")).status).toBe(403);
        const document = yield* read(known, "/report.json", "text/html");
        expect(document.status).toBe(302);
        const page = yield* fetchAnonymously(known, "/inbox/read");
        expect(page).toEqual(probe);
        const navigation = yield* read(known, "/", "text/html");
        expect(navigation.status).toBe(302);
        // A nonexistent team's hostname is refused too.
        if (target.metadata.target === "cloud" && target.metadata.mode === "attached") {
          // Cloudflare holds one wildcard certificate per team, so a host under an unknown
          // organization fails the TLS handshake at the edge and never reaches the Worker.
          for (const [path, accept] of [
            ["/.env", "*/*"],
            ["/", "text/html"],
          ] as const) {
            const refused = yield* HttpClientRequest.get(
              new URL(path, missingOrganization).href,
            ).pipe(HttpClientRequest.setHeader("accept", accept), http.execute, Effect.flip);
            const codes: Array<unknown> = [];
            for (let cause: unknown = refused; typeof cause === "object" && cause !== null;) {
              codes.push("code" in cause ? cause.code : undefined);
              cause = "cause" in cause ? cause.cause : "reason" in cause ? cause.reason : undefined;
            }
            expect(codes, "An unknown organization's host has no certificate").toContain(
              "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
            );
          }
        } else {
          expect(yield* fetchAnonymously(missingOrganization, "/.env")).toEqual(probe);
          expect((yield* read(missingOrganization, "/", "text/html")).status).toBe(403);
        }
      }),
    ),
  );
  it.effect(scenarios.appUiSignedOutOpen.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, browser, target, bookmark } = yield* appFixture;
        const { timeline } = yield* recordAppOpening(
          Effect.gen(function* () {
            yield* browser.use("Open the app URL without an Executor session", (page) =>
              page.goto(bookmark),
            );
            yield* browser.use("The app asks for the product sign-in", (page) =>
              page
                .getByRole("heading", {
                  name: target.metadata.target === "cloud" ? "Sign in" : "Sign in to Executor",
                  exact: true,
                })
                .waitFor(),
            );
            if (target.metadata.target === "self-host") {
              yield* browser.use("Enter the owner's email", (page) =>
                page.getByLabel("Email", { exact: true }).fill("owner@example.test"),
              );
              yield* browser.use("Enter the self-host password", (page) =>
                page.getByLabel("Password", { exact: true }).fill(password),
              );
              yield* browser.use("Sign in", (page) =>
                page.getByRole("button", { name: "Sign in", exact: true }).click(),
              );
            } else {
              // Cloud fixture users cannot receive sign-in codes; the session arrives as a cookie
              // and the sign-in page is reloaded to continue its return navigation.
              // Keep the app's pending sign-in cookie; only the product session is added.
              const cookies = yield* actors.owner.cookies;
              yield* browser.use("Add the owner's product session", (page) =>
                page.context().addCookies([...Redacted.value(cookies)]),
              );
              yield* browser.use("Continue from the sign-in page with a session", (page) =>
                page.reload(),
              );
            }
            yield* browser.use("Sign-in returns to the app and it renders", (page) =>
              page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
            );
          }),
        );
        expect(
          yield* browser.use("The bookmark survives sign-in", (page) =>
            Promise.resolve(page.url()),
          ),
        ).toBe(bookmark);
        expectNoSignInPages(timeline);
      }),
    ),
  );
  it.effect(scenarios.appUiDashboardOpen.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, browser, app, url } = yield* appFixture;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the deployed app details", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}`),
        );
        yield* browser.use("The ready app link appears", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).waitFor(),
        );
        const { result: opened, timeline } = yield* recordAppOpening(
          browser.use("Open app opens a new tab that signs in and renders the app", (page) => {
            const callbacks: string[] = [];
            // Registered on the context so the new tab's first redirects are observed.
            page.context().on("response", (response) => {
              if (new URL(response.url()).pathname === "/_executor/auth/callback")
                callbacks.push(response.url());
            });
            return Promise.all([
              page.context().waitForEvent("page"),
              page.getByRole("link", { name: "Open app", exact: true }).click(),
            ]).then(([tab]) => {
              return tab
                .getByRole("status")
                .filter({ hasText: "Ready" })
                .waitFor()
                .then(() => tab.reload())
                .then(() => tab.getByRole("status").filter({ hasText: "Ready" }).waitFor())
                .then(() => ({ url: tab.url(), callbacks }));
            });
          }),
        );
        expect(new URL(opened.url).origin).toBe(new URL(url).origin);
        expectNoSignInPages(timeline);
        expect(opened.callbacks).toHaveLength(1);
        const callback = opened.callbacks[0] ?? "";
        expect(
          yield* browser.use("A used callback URL cannot sign in again", (page) =>
            page
              .context()
              .request.get(callback, { maxRedirects: 0 })
              .then((response) => response.status()),
          ),
        ).toBe(401);
        expect(
          yield* browser.use("A callback URL cannot sign in another browser", (page) =>
            (
              page.context().browser()?.newContext() ?? Promise.reject(new Error("No browser"))
            ).then((other) =>
              other.request
                .get(callback, { maxRedirects: 0 })
                .then((response) => response.status())
                .finally(() => other.close()),
            ),
          ),
        ).toBe(401);
      }),
    ),
  );
  it.effect(scenarios.appUi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, target, prefix, app, url, bookmark } = yield* appFixture;
        const seeded = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/data/mutate`,
          {
            name: "save",
            input: { body: "Saved from the management API" },
          },
        );
        expect(seeded.status).toBe(200);
        yield* browser.omitNetworkTrace;
        expect(
          (yield* browser.use("Unsigned protected assets stay private", (page) =>
            page.context().request.get(`${url}/mark.svg`),
          )).status(),
        ).toBe(403);
        expect(
          (yield* browser.use("App origin has no management routes", (page) =>
            page.context().request.get(`${url}/api/auth/get-session`),
          )).status(),
        ).toBe(404);
        expect(
          yield* browser.use("Reserved product roots are not app pages", (page) =>
            Promise.all(
              ["/api", "/mcp", "/_executor", "/.well-known"].map((path) =>
                page
                  .context()
                  .request.get(`${url}${path}`, { maxRedirects: 0 })
                  .then((response) => [path, response.status()] as const),
              ),
            ),
          ),
        ).toEqual([
          ["/api", 404],
          ["/mcp", 404],
          ["/_executor", 404],
          ["/.well-known", 404],
        ]);
        yield* browser.use("Direct bookmark requires the existing product login", (page) =>
          page.goto(bookmark),
        );
        yield* browser.use("Sign-in return stays on the dashboard", (page) =>
          page
            .getByRole("heading", {
              name: target.metadata.target === "cloud" ? "Sign in" : "Sign in to Executor",
              exact: true,
            })
            .waitFor(),
        );
        yield* browser.login(actors.owner);
        yield* openPrivateApp(bookmark);
        yield* browser.use("App query executes after authentication", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.use("App pages read data saved through the management API", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved from the management API" }).waitFor(),
        );
        expect(
          yield* browser.use("The original path query and fragment survive sign-in", (page) =>
            Promise.resolve(page.url()),
          ),
        ).toBe(bookmark);
        expect(
          yield* browser.use("Retained image is loaded", (page) =>
            page
              .getByRole("img", { name: "Fixture logo" })
              .evaluate((image) =>
                image instanceof HTMLImageElement
                  ? image.decode().then(() => image.complete && image.naturalWidth === 24)
                  : false,
              ),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("A script-imported image loads from a nested page path", (page) =>
            page
              .getByRole("img", { name: "Imported badge" })
              .evaluate((image) =>
                image instanceof HTMLImageElement
                  ? image.decode().then(() => image.complete && image.naturalWidth === 16)
                  : false,
              ),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("The page URL is the document base", (page) =>
            page.evaluate(() => {
              const inline = document.querySelector(".inline-mark");
              const style = inline === null ? undefined : getComputedStyle(inline);
              return {
                base: document.querySelector("base") === null,
                baseURI: document.baseURI === location.href,
                logo: new URL(document.querySelector("img")?.src ?? "", location.href).pathname,
                canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
                srcset: document
                  .querySelector<HTMLImageElement>('img[alt="Responsive mark"]')
                  ?.srcset.split(" ")[0],
                inlineStyle: style?.backgroundImage,
                styleAttribute: style?.borderImageSource,
                quoted: inline === null ? "" : getComputedStyle(inline, "::after").content,
                escaped: getComputedStyle(document.querySelector(".escaped-mark") ?? document.body)
                  .backgroundImage,
                use: document.querySelector("use")?.getAttribute("href"),
                escapedName: getComputedStyle(
                  document.querySelector(".syntax-mark") ?? document.body,
                ).backgroundImage,
                commented: getComputedStyle(document.querySelector(".syntax-mark") ?? document.body)
                  .borderImageSource,
                inlineImport: getComputedStyle(document.documentElement)
                  .getPropertyValue("--inline-import")
                  .trim(),
                imageInput: document.querySelector<HTMLInputElement>('input[type="image"]')?.src,
                required: document.querySelector<HTMLImageElement>('img[alt="Imported badge"]')
                  ?.dataset.required,
              };
            }),
          ),
        ).toEqual({
          base: true,
          baseURI: true,
          logo: expect.stringMatching(/^\/_executor\/assets\/[^/]+\/mark\.svg$/),
          canonical: "inbox",
          srcset:
            "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='4'%20height='4'%3E%3C/svg%3E",
          inlineStyle: expect.stringMatching(/\/_executor\/assets\/[^/]+\/mark\.svg"\)$/),
          styleAttribute: expect.stringMatching(/\/_executor\/assets\/[^/]+\/mark\.svg"\)$/),
          quoted: '"url(mark.svg)"',
          escaped: expect.stringMatching(/\/_executor\/assets\/[^/]+\/mark\.svg"\)$/),
          escapedName: expect.stringMatching(/\/_executor\/assets\/[^/]+\/mark\.svg"\)$/),
          commented: expect.stringMatching(/\/_executor\/assets\/[^/]+\/mark\.svg"\)$/),
          inlineImport: "loaded",
          use: expect.stringMatching(/^\/_executor\/assets\/[^/]+\/mark\.svg#mark$/),
          imageInput: expect.stringMatching(/\/_executor\/assets\/[^/]+\/mark\.svg$/),
          required: "true",
        });
        yield* browser.use("A fragment link stays on the page", (page) =>
          page.getByRole("link", { name: "Files changed" }).click(),
        );
        expect(
          yield* browser.use("Only the fragment changed", (page) =>
            page
              .waitForURL((url) => url.hash === "#/files")
              .then(() => {
                const current = new URL(page.url());
                return { path: current.pathname, search: current.search };
              }),
          ),
        ).toEqual({ path: "/inbox/unread", search: "?filter=new" });
        yield* browser.use("The app document remains after the fragment link", (page) =>
          page.getByRole("heading", { name: "Private app" }).waitFor(),
        );
        expect(
          yield* browser.use("Retained CSS is loaded", (page) =>
            page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--fixture-asset").trim(),
            ),
          ),
        ).toBe("loaded");
        const session = yield* browser.use("App cookie is host-only and HttpOnly", (page) =>
          page
            .context()
            .cookies(url)
            .then((cookies) => {
              const cookie = cookies.find((cookie) => cookie.name.endsWith("executor_app"));
              return cookie && { httpOnly: cookie.httpOnly, domain: cookie.domain };
            }),
        );
        expect(session).toEqual({ httpOnly: true, domain: new URL(url).hostname });
        const publicFile = yield* browser.use("Signed-in app serves its root public file", (page) =>
          page.context().request.get(`${url}/mark.svg`),
        );
        expect(publicFile.status()).toBe(200);
        expect(
          yield* browser.use("Signed-in public file keeps its contents", () => publicFile.text()),
        ).toContain('<circle cx="12"');
        expect(
          (yield* browser.use(
            "Signed-in index file serves the document without HTML Accept",
            (page) =>
              page.context().request.get(`${url}/index.html`, { headers: { accept: "*/*" } }),
          )).status(),
        ).toBe(200);
        const dottedStatus = yield* browser.use(
          "Signed-in dotted navigation keeps the missing-file response",
          (page) =>
            page
              .context()
              .newPage()
              .then((tab) =>
                tab
                  .goto(`${url}/report.json`)
                  .then((response) => response?.status())
                  .finally(() => tab.close()),
              ),
        );
        expect(dottedStatus).toBe(404);
        expect(
          (yield* browser.use("Missing assets remain 404", (page) =>
            page.context().request.get(`${url}/missing.js`),
          )).status(),
        ).toBe(404);
        expect(
          (yield* browser.use("Cross-origin writes are rejected", (page) =>
            page.context().request.post(`${url}/_executor/api/mutate`, {
              headers: { origin: "https://other.example.test" },
              data: {},
            }),
          )).status(),
        ).toBe(403);
        yield* browser.use("Enter a message", (page) =>
          page.getByLabel("Message", { exact: true }).fill("Saved through app runtime"),
        );
        yield* browser.use("Run the saved app mutation", (page) =>
          page.getByRole("button", { name: "Save message" }).click(),
        );
        yield* browser.use("Read the committed app data", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved through app runtime" }).waitFor(),
        );
        yield* browser.checkpoint("Private app query and mutation");
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/data/query`,
          {
            name: "list",
            input: {},
          },
        );
        expect(saved.status).toBe(200);
        expect(yield* body(Schema.Array(Schema.String), saved)).toEqual([
          "Saved from the management API",
          "Saved through app runtime",
        ]);
        yield* browser.use("A bookmark revisit reuses the app session", (page) =>
          page.goto(bookmark),
        );
        yield* browser.use("Data remains after reopening", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved through app runtime" }).waitFor(),
        );
      }),
    ),
  );
  it.effect(scenarios.appUiAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, prefix, app, bookmark } = yield* appFixture;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        const shared = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          }),
        );
        yield* browser.login(actors.member);
        // Keep the live revocation watcher pending while testing the mutation's
        // own rejection. Starting a document navigation can cancel its response.
        const watcher = yield* holdQuery(["/_executor/version"], "continue");
        yield* openPrivateApp(bookmark);
        yield* watcher.requested;
        yield* browser.use("Member can query the app", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.use("Member enters a message", (page) =>
          page.getByLabel("Message", { exact: true }).fill("Saved by a member"),
        );
        yield* browser.use("Member writes to the shared app", (page) =>
          page.getByRole("button", { name: "Save message" }).click(),
        );
        yield* browser.use("Member write succeeds", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved by a member" }).waitFor(),
        );
        const live = yield* browser.use("Open a member tab with live revocation", (page) =>
          page.context().newPage(),
        );
        yield* Effect.addFinalizer(() =>
          browser.use("Close the live member tab", () => live.close()).pipe(Effect.orDie),
        );
        const [response] = yield* Effect.all(
          [
            browser.use("Observe the live member subscription", () =>
              live.waitForResponse(
                (response) => new URL(response.url()).pathname === "/_executor/version",
              ),
            ),
            browser.use("Load the live member tab", () => live.goto(bookmark)),
          ],
          { concurrency: "unbounded" },
        );
        expect(response.status()).toBe(200);
        yield* browser.use("The live member tab is ready", () =>
          live.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: shared.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        yield* browser.use("Revoked app session attempts a write", (page) =>
          page.getByRole("button", { name: "Save message" }).click(),
        );
        yield* browser.use("Existing session loses access immediately", (page) =>
          page.getByRole("status").filter({ hasText: "Save failed" }).waitFor(),
        );
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${app.id}/ui`)).status,
        ).toBe(403);
        yield* browser.use("Revocation removes the open app from the browser", () =>
          live.getByText("App unavailable.", { exact: true }).waitFor(),
        );
        yield* watcher.release;
        // Each app has its own complete DNS label, independent of the team slug length.
        const maxAppSlug = 63;
        expect(maxAppSlug).toBeGreaterThan(0);
        const boundaryName = "a".repeat(maxAppSlug);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: boundaryName,
          })).status,
        ).toBe(200);
        const boundary = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`);
        expect(boundary.status).toBe(200);
        const boundaryUrl = (yield* body(Location, boundary)).url;
        expect(new URL(boundaryUrl).hostname.split(".")[0]?.length).toBe(63);
        yield* browser.login(actors.owner);
        yield* openPrivateApp(boundaryUrl);
        yield* browser.use("A 63-character app label serves the authenticated app", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.checkpoint("The longest app hostname works over verified HTTPS");
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: `${boundaryName}a`,
          })).status,
        ).toBe(200);
        const normalized = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`);
        expect(normalized.status).toBe(200);
        expect((yield* body(Location, normalized)).url).toBe(boundaryUrl);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: app.name,
          })).status,
        ).toBe(200);
      }),
    ),
  );
});
