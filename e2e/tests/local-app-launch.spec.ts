import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { committedDocuments, recordAppOpening, screens } from "../support/app-open-timeline.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { linkLocal, localLinks, unlinkLocal } from "../support/local-links.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
const appSchema = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const source = `import {defineApp,defineProvider,secrets,query,object,string, router, ProviderError} from "apps";
const service=defineProvider({name:"Launch fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})},
  async health({account}){if(account.fields.token==="rejected-launch-token")throw new ProviderError({reason:"unauthorized",status:401});
    if(account.fields.token==="down-launch-token")throw new ProviderError({reason:"unavailable",status:503});}});
export const who=query({input:object({})},async ctx=>ctx.user.accounts.service.id);
export default defineApp({user: { accounts:{service} }},{tools: router({ who })});`;
const files = (code: string) => [
  { path: "index.ts", content: code },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Launch</title></head><body><h1>Local app</h1><p id="identity"></p><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content:
      'import {string} from "apps";import {createAppClient,queryReference} from "apps/client";import type {who} from "../index.ts";createAppClient().query(queryReference<typeof who>("who"),{},string()).then(value=>{document.querySelector("#identity").textContent=value;});',
  },
  appsManifest,
];
layer(TestLive, { excludeTestServices: true })("Local app launch", (it) => {
  it.effect(scenarios.localAppLaunch.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        // Agent calls carry the API key and no browser origin.
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const send = (method: "POST" | "GET" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const appName = `Launch ${randomUUID().slice(0, 8)}`;
        const { app } = yield* body(
          appSchema,
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: appName,
            files: files(source),
          }),
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => send("DELETE", path)).pipe(Effect.orDie),
        );
        const create = (label: string, token = "synthetic-launch-token") =>
          Effect.gen(function* () {
            // Connecting from the app links the account, replacing the one linked before.
            const account = yield* connectLocalAccount(
              agent,
              {
                app: app.id,
                requirement: "service",
                method: "key",
                label,
                fields: { token },
              },
              headers,
            );
            owned.push(`/v1/accounts/${account.id}`);
            return account.id;
          });
        const remove = (account: string) =>
          Effect.gen(function* () {
            expect((yield* send("DELETE", `/v1/accounts/${account}`)).status).toBe(200);
            owned.splice(owned.indexOf(`/v1/accounts/${account}`), 1);
          });
        const personal = yield* create("Personal");
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.use("Pair launch browser", (page) => page.goto(url));
        yield* browser.use("Pairing finished", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        yield* browser.use("Open local app metadata", (page) => page.goto(`/apps/${app.id}`));
        const ui = yield* browser.use("Read local app URL", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
        );
        if (ui === null) return yield* Effect.die(new Error("Missing app URL"));
        const appOrigin = new URL(ui).origin;
        // The app link names no account; the app uses the account linked to it.
        expect(new URL(ui).searchParams.has("accounts")).toBe(false);
        const { timeline } = yield* recordAppOpening(
          Effect.gen(function* () {
            // Another deep link than the one opened below, which must load a new document.
            yield* browser.use("One account opens without a chooser", (page) =>
              page.goto(new URL("/inbox?folder=all#message", ui).href),
            );
            yield* browser.use("Personal app data loads", (page) =>
              page.locator("#identity").filter({ hasText: personal }).waitFor(),
            );
          }),
        );
        // Sign-in is redirects only; no host-owned page renders before the app.
        expect(screens(timeline)).not.toContain("Opening app…");
        expect(
          committedDocuments(timeline)
            .map((url) => url.pathname)
            .filter((path) => path.startsWith("/_executor/auth/")),
        ).toEqual([]);
        // Chromium maps *.localhost to loopback itself; Node relies on the OS resolver,
        // which does not on every platform. Local listens on 127.0.0.1.
        const appLoopback = new URL(ui);
        appLoopback.hostname = "127.0.0.1";
        expect(
          yield* browser.use("Reserved host roots are not app pages", (page) =>
            Promise.all(
              (
                [
                  ["GET", "/_executor"],
                  ["GET", "/dashboard"],
                  ["GET", "/auth"],
                  ["GET", "/v1"],
                  ["GET", "/mcp"],
                  ["POST", "/v1"],
                  ["POST", "/mcp"],
                ] as const
              ).map(([method, path]) =>
                page
                  .context()
                  .request.fetch(`${appLoopback.origin}${path}`, {
                    method,
                    headers: { host: new URL(ui).host, origin: appOrigin },
                    maxRedirects: 0,
                  })
                  .then((response) => [method, path, response.status()] as const),
              ),
            ),
          ),
        ).toEqual([
          ["GET", "/_executor", 404],
          ["GET", "/dashboard", 404],
          ["GET", "/auth", 404],
          ["GET", "/v1", 404],
          ["GET", "/mcp", 404],
          ["POST", "/v1", 404],
          ["POST", "/mcp", 404],
        ]);
        expect(
          new URL(
            yield* browser.use("The single account page names no choice", (page) =>
              Promise.resolve(page.url()),
            ),
          ).searchParams.has("accounts"),
        ).toBe(false);
        // Connecting another account from the app replaces the one it uses; the app opens
        // straight away with it, keeping its deep link.
        const work = yield* create("Work");
        expect(yield* localLinks(agent, app.id)).toEqual([work]);
        yield* browser.use("The app opens with the newly linked account", (page) =>
          page
            .goto(new URL("/inbox?folder=unread#message", ui).href)
            .then(() => page.locator("#identity").filter({ hasText: work }).waitFor()),
        );
        const launched = new URL(
          yield* browser.use("Read the opened page", (page) => Promise.resolve(page.url())),
        );
        expect(launched.origin).toBe(appOrigin);
        expect(launched.pathname).toBe("/inbox");
        expect(launched.searchParams.get("folder")).toBe("unread");
        expect(launched.searchParams.has("accounts")).toBe(false);
        expect(launched.hash).toBe("#message");
        expect(
          yield* browser.use("No host account chooser was shown", (page) =>
            page.getByRole("heading", { name: `Open ${appName}`, exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Local authored app opens with its linked account");
        const blocked = (step: string) =>
          Effect.gen(function* () {
            yield* browser.use(step, (page) => page.goto(new URL("/inbox", ui).href));
            yield* browser.use("A full page replaces the app", (page) =>
              page.getByRole("heading", { name: `${appName} can't open`, exact: true }).waitFor(),
            );
            return yield* browser.use("Read the blocked page", (page) =>
              Promise.all([
                page.locator("main").innerText(),
                page.getByRole("link", { name: "Fix accounts", exact: true }).getAttribute("href"),
                page.locator("#identity").count(),
              ]),
            );
          });
        const rejected = yield* create("Rejected", "rejected-launch-token");
        yield* send("POST", `/v1/accounts/${rejected}/health`, { apps: [app.id] });
        const [rejectedPage, rejectedFix, rejectedApp] = yield* blocked(
          "Open the app with a rejected linked account",
        );
        expect(rejectedPage).toContain("Rejected (Launch fixture): sign-in rejected at last check");
        expect(rejectedFix).toContain(`/apps/${app.id}?view=accounts`);
        expect(rejectedApp).toBe(0);
        yield* browser.checkpoint("Blocked accounts explain why the app cannot open");
        // With nothing linked, the page says what to link; the replaced accounts stay saved.
        yield* unlinkLocal(agent, app.id, "service", rejected);
        const [missingPage, missingFix, missingApp] = yield* blocked(
          "Open the app with no linked account",
        );
        expect(missingPage).toContain("No Launch fixture account linked");
        expect(missingFix).toContain(`/apps/${app.id}?view=accounts`);
        expect(missingApp).toBe(0);
        expect((yield* send("GET", `/v1/accounts/${work}`)).status).toBe(200);
        // Removing the linked account removes its link too.
        yield* linkLocal(agent, app.id, "service", work);
        yield* remove(work);
        expect(yield* localLinks(agent, app.id)).toEqual([]);
        const advisory = yield* create("Advisory", "down-launch-token");
        yield* send("POST", `/v1/accounts/${advisory}/health`, { apps: [app.id] });
        yield* browser.use("Open the app with an advisory account", (page) =>
          page.goto(new URL("/inbox", ui).href),
        );
        yield* browser.use("Advisory app data still loads", (page) =>
          page.locator("#identity").filter({ hasText: advisory }).waitFor(),
        );
        expect(
          yield* browser.use("Read the advisory card", (page) =>
            page.getByRole("status", { name: "Account warning" }).innerText(),
          ),
        ).toContain("Advisory (Launch fixture): service unavailable at last check");
        yield* browser.use("Dismiss the advisory card", (page) =>
          page.getByRole("button", { name: "Dismiss", exact: true }).click(),
        );
        expect(
          yield* browser.use("Advisory card is gone", (page) =>
            page.getByRole("status", { name: "Account warning" }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("App pages explain account problems when they open");
        const plain = yield* body(
          Schema.Struct({ app: Resource }),
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Plain launch ${randomUUID().slice(0, 8)}`,
            files: files(
              source
                .replace("accounts:{service}", "accounts:{}")
                .replace("ctx.user.accounts.service.id", '"plain"'),
            ),
          }),
        );
        owned.unshift(`/v1/apps/${plain.app.id}`);
        yield* browser.use("Open no-provider app metadata", (page) =>
          page.goto(`/apps/${plain.app.id}`),
        );
        const plainUrl = yield* browser.use("Read plain app URL", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
        );
        if (plainUrl === null) return yield* Effect.die(new Error("Missing plain app URL"));
        yield* browser.use("No-provider app opens directly", (page) => page.goto(plainUrl));
        yield* browser.use("No-provider app data works", (page) =>
          page.locator("#identity").filter({ hasText: "plain" }).waitFor(),
        );
        expect(
          new URL(
            yield* browser.use("Plain URL has no account choice", (page) =>
              Promise.resolve(page.url()),
            ),
          ).searchParams.has("accounts"),
        ).toBe(false);
        expect(
          (yield* send("GET", `/dashboard/api/apps/${plain.app.id}/accounts/user`)).body,
        ).toEqual([]);
      }),
    ),
  );
});
