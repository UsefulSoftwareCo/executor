/** A local authored app's deep link opens straight in the app with the account linked to it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { localLinks } from "../support/local-links.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const source = `import {defineApp,defineProvider,secrets,query,object,string, router} from "apps";
const service=defineProvider({name:"Picker fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export const who=query({input:object({})},async ctx=>ctx.user.accounts.service.id);
export default defineApp({user: { accounts:{service} }},{tools: router({ who })});`;
const files = [
  { path: "index.ts", content: source },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Picker</title></head><body><h1>Local app</h1><p id="identity"></p><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content:
      'import {string} from "apps";import {createAppClient,queryReference} from "apps/client";import type {who} from "../index.ts";createAppClient().query(queryReference<typeof who>("who"),{},string()).then(value=>{document.querySelector("#identity").textContent=value;});',
  },
  appsManifest,
];

layer(TestLive, { excludeTestServices: true })("Local app deep links", (it) => {
  it.effect(scenarios.localAccountPickerDeepLink.title, (context) =>
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
        const appName = `Picker ${randomUUID().slice(0, 8)}`;
        const { app } = yield* body(
          Deployed,
          yield* send("POST", "/v1/apps/deploy", { owner: "local", name: appName, files }),
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => send("DELETE", path)).pipe(Effect.orDie),
        );
        // Connecting from the app links the account; the newest replaces the one before.
        const create = (label: string) =>
          Effect.gen(function* () {
            const account = yield* connectLocalAccount(
              agent,
              {
                app: app.id,
                requirement: "service",
                method: "key",
                label,
                fields: { token: "synthetic-picker-token" },
              },
              headers,
            );
            owned.push(`/v1/accounts/${account.id}`);
            return account.id;
          });
        const personal = yield* create("Personal");
        const work = yield* create("Work");
        expect(yield* localLinks(agent, app.id)).toEqual([work]);
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.use("Pair the browser", (page) => page.goto(url));
        yield* browser.use("Pairing finished", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        const dashboard = new URL(
          yield* browser.use("Read the dashboard origin", (page) => Promise.resolve(page.url())),
        ).origin;
        yield* browser.use("Open local app metadata", (page) => page.goto(`/apps/${app.id}`));
        const ui = yield* browser.use("Read the local app URL", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
        );
        if (ui === null) return yield* Effect.die(new Error("Missing app URL"));
        const appOrigin = new URL(ui).origin;
        const visited: string[] = [];
        yield* browser.use("Record the pages the tab visits", (page) =>
          Promise.resolve(
            page.on("framenavigated", (frame) => {
              if (frame === page.mainFrame()) visited.push(frame.url());
            }),
          ),
        );
        yield* browser.use("Open an app bookmark", (page) =>
          page.goto(`${appOrigin}/inbox?folder=unread#message`),
        );
        yield* browser.use("The app runs with the linked account", (page) =>
          page.locator("#identity").filter({ hasText: work }).waitFor(),
        );
        const landed = new URL(
          yield* browser.use("Read the opened app", (page) => Promise.resolve(page.url())),
        );
        expect(landed.origin).toBe(appOrigin);
        expect(landed.pathname).toBe("/inbox");
        expect(landed.searchParams.get("folder")).toBe("unread");
        expect(landed.searchParams.has("accounts")).toBe(false);
        // The browser carries the bookmark's fragment through every sign-in redirect.
        expect(landed.hash).toBe("#message");
        // No dashboard page, such as an account picker, opened on the way.
        expect(visited.filter((url) => new URL(url).origin === dashboard)).toEqual([]);
        expect(
          yield* browser.use("Read the account the page ran with", (page) =>
            page.locator("#identity").textContent(),
          ),
        ).toBe(work);
        expect(work).not.toBe(personal);
        yield* browser.checkpoint("Local deep link opened with the linked account");
      }),
    ),
  );
});
