import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
const appSchema = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const source = `import {defineApp,defineProvider,secrets,query,object,string} from "apps";
const service=defineProvider({name:"Launch fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export const who=query({input:object({})},async ctx=>ctx.accounts.service.id);
export default defineApp({accounts:{service}},{queries:{who}});`;
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
        const send = (method: "POST" | "GET" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const { app } = yield* body(
          appSchema,
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Launch ${randomUUID().slice(0, 8)}`,
            files: files(source),
          }),
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => send("DELETE", path)).pipe(Effect.orDie),
        );
        const create = (label: string) =>
          Effect.gen(function* () {
            const account = yield* body(
              Resource,
              yield* send("POST", "/v1/accounts", {
                owner: "local",
                provider: app.requirements.accounts.service.provider,
                method: "key",
                label,
                fields: { token: "synthetic-launch-token" },
              }),
            );
            owned.push(`/v1/accounts/${account.id}`);
            const profile = yield* body(
              Resource,
              yield* send("POST", `/v1/apps/${app.id}/profiles`, {
                owner: "local",
                subject: "local",
                name: label,
                accounts: { service: account.id },
                idempotencyKey: randomUUID(),
              }),
            );
            return { account: account.id, profile: profile.id };
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
        expect(new URL(ui).searchParams.get("profile")).toBe(personal.profile);
        yield* browser.use("One account opens without a chooser", (page) =>
          page.goto(new URL("/inbox?folder=unread#message", ui).href),
        );
        yield* browser.use("Personal app data loads", (page) =>
          page.locator("#identity").filter({ hasText: personal.account }).waitFor(),
        );
        const appOrigin = new URL(ui).origin;
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
                  .request.fetch(`${appOrigin}${path}`, {
                    method,
                    headers: { origin: appOrigin },
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
            yield* browser.use("Explicit local app context", (page) => Promise.resolve(page.url())),
          ).searchParams.get("profile"),
        ).toBe(personal.profile);
        const work = yield* create("Work");
        yield* browser.use("Two accounts need a launch choice", (page) =>
          page.goto(new URL("/inbox?folder=unread#message", ui).href),
        );
        yield* browser.use("Choose Work", (page) =>
          page.getByRole("link", { name: "Work", exact: true }).click(),
        );
        yield* browser.use("Work app data loads", (page) =>
          page.locator("#identity").filter({ hasText: work.account }).waitFor(),
        );
        const launched = new URL(
          yield* browser.use("Local deep link survives choice", (page) =>
            Promise.resolve(page.url()),
          ),
        );
        expect(launched.pathname).toBe("/inbox");
        expect(launched.searchParams.get("folder")).toBe("unread");
        expect(launched.hash).toBe("#message");
        yield* browser.checkpoint("Local authored app has explicit account context");
        const plain = yield* body(
          Schema.Struct({ app: Resource }),
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Plain launch ${randomUUID().slice(0, 8)}`,
            files: files(
              source
                .replace("accounts:{service}", "accounts:{}")
                .replace("ctx.accounts.service.id", '"plain"'),
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
            yield* browser.use("Plain URL has no profile", (page) => Promise.resolve(page.url())),
          ).searchParams.has("profile"),
        ).toBe(false);
        expect((yield* send("GET", `/v1/apps/${plain.app.id}/profiles`)).body).toEqual([]);
      }),
    ),
  );
});
