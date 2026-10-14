/** Local dashboard pages arrive rendered and hydrate to the same markup. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
const ProviderApp = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});

layer(TestLive, { excludeTestServices: true })("Local server-rendered dashboard", (it) => {
  it.effect(scenarios.localServerRenderedDashboard.title, (context) =>
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
        const send = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const { app } = yield* body(
          ProviderApp,
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Local rendered ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Rendered mail",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const identity=query({input:object({})},async ctx=>ctx.user.accounts.service.id);
export default defineApp({user: { accounts:{service} }},async()=>({tools:router({identity}),skills:[{name:"greeting",description:"Greet the reader",files:[{path:"SKILL.md",content:"---\\nname: greeting\\ndescription: Greet the reader\\n---\\nSay hello."}]}]}));`,
              },
              appsManifest,
            ],
          }),
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => send("DELETE", path)).pipe(Effect.orDie),
        );
        const account = yield* connectLocalAccount(
          agent,
          {
            app: app.id,
            requirement: "service",
            method: "key",
            label: "Rendered account",
            fields: { token: "synthetic-rendered-key" },
          },
          headers,
        );
        owned.push(`/v1/accounts/${account.id}`);
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.use("Pair the local dashboard", (page) => page.goto(url));
        yield* browser.use("The local dashboard is ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );

        // Local reports errors through its logger, so any console message type can carry one.
        const failures: string[] = [];
        yield* browser.use("Watch hydration", (page) => {
          page.on("console", (message) => {
            if (hydrationFailure.test(message.text())) failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          return Promise.resolve();
        });

        const pages = [
          ["Apps", "/apps", /^Apps/],
          ["App overview", `/apps/${app.id}`, "Accounts"],
          ["App accounts", `/apps/${app.id}?view=accounts`, "Rendered account"],
          ["App tools", `/apps/${app.id}?view=tools`, "identity"],
          ["App skills", `/apps/${app.id}?view=skills`, "greeting"],
          ["App source", `/apps/${app.id}?view=source`, "index.ts"],
          ["App deployments", `/apps/${app.id}?view=deployments`, "index.ts"],
          ["Accounts", "/accounts", "Rendered account"],
          ["Linked account", `/accounts?account=${account.id}`, "Rendered account"],
        ] as const;
        for (const [label, path, content] of pages) {
          const response = yield* browser.use(`Load ${label} from the server`, (page) =>
            page.goto(path),
          );
          expect(response?.status(), `${label} is served`).toBe(200);
          yield* browser.use(`${label} shows its content after hydration`, (page) =>
            page.getByText(content).first().waitFor(),
          );
          expect(failures, `${label} hydrates to the server's markup`).toEqual([]);
        }
        yield* browser.checkpoint("Local pages hydrate to their server-rendered markup");
      }),
    ),
  );
});
