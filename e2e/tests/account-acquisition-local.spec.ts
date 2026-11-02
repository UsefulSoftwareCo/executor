import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";
import { acquisitionAppSource, acquisitionProduct } from "../support/acquisition-product.ts";
import { interactiveAccountBackend } from "../support/interactive-account-backend.ts";
import { callLocalQuery, linkLocal, localAgent } from "../support/local-links.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Resource = Schema.Struct({ id: Schema.String });
const App = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
    }),
  }),
});
const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Resource });
layer(TestLive, { excludeTestServices: true })("Reusable local account", (it) => {
  it.effect(scenarios.accountAcquisitionLocal.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent } = yield* localAgent;
        const backend = yield* interactiveAccountBackend;
        const apps: string[] = [];
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* serverControl("start");
            for (const app of apps) yield* agent.send("DELETE", `/v1/apps/${app}`);
            for (const account of accounts) yield* agent.send("DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const response = yield* agent.send("POST", "/v1/apps/deploy", {
              owner: "local",
              name,
              files: [
                { path: "index.ts", content: acquisitionAppSource(backend.origin) },
                appsManifest,
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { app } = yield* body(App, response);
            apps.push(app.id);
            return app;
          });
        const manager = yield* deploy("Account management");
        const first = yield* deploy("First account consumer"),
          second = yield* deploy("Second account consumer");
        const provider = manager.requirements.accounts.identity!.provider;
        expect(first.requirements.accounts.identity?.provider).toBe(provider);
        expect(second.requirements.accounts.identity?.provider).toBe(provider);
        yield* acquisitionProduct({ provider, origin: backend.origin });
        const connect = (app: string, account?: string) =>
          Effect.gen(function* () {
            const response = yield* agent.send("POST", "/v1/account-connections", {
              owner: "local",
              target: { app, requirement: "identity" },
              ...(account === undefined ? {} : { account }),
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return (yield* body(Resource, response)).id;
          });
        const start = (connection: string) =>
          agent.send("POST", "/v1/account-connections/interactive/start", {
            connection,
            owner: "local",
            method: "paste",
          });
        const submit = (connection: string) =>
          agent.send("POST", "/v1/account-connections/interactive/submit", {
            connection,
            owner: "local",
            value: "http://localhost:48765/done?code=synthetic",
          });
        const initial = yield* connect(manager.id);
        expect((yield* start(initial)).status).toBe(200);
        const completed = yield* submit(initial);
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const { account } = yield* body(Connected, completed);
        accounts.push(account.id);
        expect(JSON.stringify(completed.body)).not.toContain("opaque-");
        expect(JSON.stringify(completed.body)).not.toContain("private-session-");
        yield* linkLocal(agent, first.id, "identity", account.id);
        yield* linkLocal(agent, second.id, "identity", account.id);
        const used = (app: string) => callLocalQuery(agent, app, "ids");
        expect(yield* used(first.id)).toEqual([
          { id: account.id, method: "paste", fields: { ref: "opaque-1" } },
        ]);
        expect(yield* used(second.id)).toEqual(yield* used(first.id));
        const path = `/v1/accounts/${account.id}`;
        const checked = yield* agent.send("POST", `${path}/health`, { apps: [] });
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        const health = yield* agent.send("GET", `${path}/health?apps=%5B%5D`);
        expect(health.status, JSON.stringify(health.body)).toBe(200);
        expect((yield* agent.send("DELETE", `/v1/apps/${manager.id}`)).status).toBe(200);
        expect(yield* backend.removeCalls).toHaveLength(0);
        yield* serverControl("restart");
        expect((yield* agent.send("GET", `${path}/health?apps=%5B%5D`)).body).toEqual(health.body);
        expect(yield* used(second.id)).toEqual([
          { id: account.id, method: "paste", fields: { ref: "opaque-1" } },
        ]);

        const reconnect = yield* connect(first.id, account.id);
        expect((yield* start(reconnect)).status).toBe(200);
        const reconnected = yield* submit(reconnect);
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
        expect((yield* body(Connected, reconnected)).account.id).toBe(account.id);
        expect(yield* used(second.id)).toEqual([
          { id: account.id, method: "paste", fields: { ref: "opaque-2" } },
        ]);
        expect(yield* backend.removeCalls).toHaveLength(0);
        expect((yield* agent.send("DELETE", path)).status).toBe(200);
        const removed = yield* backend.removeCalls;
        expect(removed).toHaveLength(1);
        expect(removed[0]?.ref).toBe("opaque-2");
        expect(removed[0]?.operation).toBeTruthy();
        expect((yield* agent.send("GET", path)).status).toBe(404);
      }),
    ),
  );
});
