import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { linkLocal, localLinks } from "../support/local-links.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
const ProviderApp = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
layer(TestLive, { excludeTestServices: true })("Local resources", (it) => {
  it.effect(scenarios.localResources.title, (context) =>
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
        const files = [
          {
            path: "index.ts",
            content: `import {defineApp,defineProvider,secrets,query,workflow,object,string, router} from "apps";
const service=defineProvider({name:"Local resources",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const identity=query({input:object({})},async ctx=>ctx.user.accounts.service.id);
const capture=workflow({input:object({})},async ctx=>ctx.step.do("identity",async step=>step.user.accounts.service.id));
export default defineApp({user: { accounts:{service} }},{tools: router({ identity }),workflows:{capture}});`,
          },
          appsManifest,
        ];
        const { app } = yield* body(
          ProviderApp,
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Local resources ${randomUUID().slice(0, 8)}`,
            files,
          }),
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => send("DELETE", path)).pipe(Effect.orDie),
        );
        const ids: Record<string, string> = {};
        // Connecting from the app links the account; the newest replaces the one before.
        for (const label of ["Personal", "Work"]) {
          const account = yield* connectLocalAccount(
            agent,
            {
              app: app.id,
              requirement: "service",
              method: "key",
              label,
              fields: { token: "synthetic-local-resource-key" },
            },
            headers,
          );
          owned.push(`/v1/accounts/${account.id}`);
          ids[label] = account.id;
        }
        expect(yield* localLinks(agent, app.id)).toEqual([ids.Work]);
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.use("Pair local resource browser", (page) => page.goto(url));
        yield* browser.use("Local dashboard ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        yield* browser.use("Open local tools", (page) => page.goto(`/apps/${app.id}?view=tools`));
        yield* browser.use("Tools load with the linked account, without a choice", (page) =>
          page.getByRole("button", { name: "identity", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("No account choice is offered", (page) =>
            page.getByRole("heading", { name: "Choose an account", exact: true }).count(),
          ),
        ).toBe(0);
        const runCapture = (label: string, runs: number) =>
          Effect.gen(function* () {
            yield* browser.use(`Open local workflows for ${label}`, (page) =>
              page.goto(`/apps/${app.id}?view=workflows`),
            );
            yield* browser.use(`Expand the workflow for ${label}`, (page) =>
              page.getByRole("button", { name: "capture", exact: true }).click(),
            );
            yield* browser.use(`Start the workflow with ${label}`, (page) =>
              page.getByRole("button", { name: "Start workflow", exact: true }).click(),
            );
            yield* browser.use(`The ${label} run completes`, (page) =>
              page
                .getByRole("button", { name: "View capture run: Complete", exact: true })
                .nth(runs - 1)
                .waitFor(),
            );
          });
        yield* runCapture("Work", 1);
        // Linking Personal replaces Work; run history belongs to the app and each run keeps the
        // account it started with.
        const personal = ids.Personal;
        if (personal === undefined) return yield* Effect.die("Personal was not connected");
        yield* linkLocal(agent, app.id, "service", personal);
        yield* runCapture("Personal", 2);
        const runs = yield* body(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ status: Schema.String, output: Schema.Json })),
          }),
          yield* send("GET", `/v1/apps/${app.id}/workflow-runs`),
        );
        expect(runs.items.map((run) => run.output).toSorted()).toEqual(
          [ids.Work, ids.Personal].toSorted(),
        );
        expect(runs.items.every((run) => run.status === "complete")).toBe(true);
        const simple = yield* body(
          Schema.Struct({ app: Resource }),
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Plain workflow ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import {defineApp,workflow,query,object, router} from "apps";export default defineApp({}, {tools: router({ hello:query({input:object({})},async()=>"hello") }),workflows:{capture:workflow({input:object({})},async ctx=>ctx.step.do("plain",async()=>"No account required"))}});`,
              },
              appsManifest,
            ],
          }),
        );
        owned.unshift(`/v1/apps/${simple.app.id}`);
        yield* browser.use("Open no-provider workflow", (page) =>
          page.goto(`/apps/${simple.app.id}?view=workflows`),
        );
        yield* browser.use("Inspect no-provider definition", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).click(),
        );
        yield* browser.use("Run without installing an account", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("No-provider run completes", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).waitFor(),
        );
        const linked = yield* send("GET", `/dashboard/api/apps/${simple.app.id}/accounts/user`);
        expect(linked.status).toBe(200);
        expect(linked.body).toEqual([]);
        yield* browser.checkpoint("Linked-account and no-provider workflows");
      }),
    ),
  );
});
