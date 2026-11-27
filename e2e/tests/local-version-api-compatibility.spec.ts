import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const source = (answer: string) => ({
  path: "index.ts",
  content: `import { defineApp, query, object, string, router } from "apps";
export const answer = query({ input: object({}), output: string() }, async () => ${JSON.stringify(answer)});
export default defineApp({}, { tools: router({ answer }) });`,
});
const App = Schema.Struct({
  id: Schema.String,
  activeVersion: Schema.String,
  activeDeployment: Schema.String,
});
const Deployed = Schema.Struct({
  app: App,
  version: Schema.Struct({ id: Schema.String }),
  deployment: Schema.Struct({ id: Schema.String }),
});
const Summaries = Schema.Array(Schema.Struct({ id: Schema.String }));
const Retained = Schema.Struct({ id: Schema.String });

layer(TestLive, { excludeTestServices: true })("Local version API compatibility", (it) => {
  it.effect(scenarios.localVersionApiCompatibility.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session();
        const agent: Session = {
          ...session,
          send: (method, path, data, headers = {}) => {
            const { origin: _origin, ...agentHeaders } = headers;
            return session.send(method, path, data, {
              ...agentHeaders,
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            });
          },
        };
        const created = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Versions ${randomUUID().slice(0, 8)}`,
          files: [source("first"), appsManifest],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const first = yield* body(Deployed, created);
        yield* Effect.addFinalizer(() =>
          api.request(agent, "DELETE", `/v1/apps/${first.app.id}`).pipe(Effect.orDie),
        );
        expect(first.deployment.id).toBe(first.version.id);
        expect(first.app.activeDeployment).toBe(first.app.activeVersion);
        const second = yield* body(
          Deployed,
          yield* api.request(agent, "POST", "/v1/apps/deploy", {
            owner: "local",
            app: first.app.id,
            files: [source("second"), appsManifest],
          }),
        );
        expect(second.version.id).not.toBe(first.version.id);
        const path = `/v1/apps/${first.app.id}`;

        const versions = yield* api.request(agent, "GET", `${path}/versions`);
        const deployments = yield* api.request(agent, "GET", `${path}/deployments`);
        expect(versions.status).toBe(200);
        expect(deployments.status).toBe(200);
        const listed = yield* body(Summaries, versions);
        expect(yield* body(Summaries, deployments)).toEqual(listed);
        expect(listed.map((version) => version.id).sort()).toEqual(
          [first.version.id, second.version.id].sort(),
        );

        for (const endpoint of ["version", "deployment"])
          for (const name of ["version", "deployment"]) {
            const read = yield* api.request(
              agent,
              "GET",
              `${path}/${endpoint}?${name}=${first.version.id}`,
            );
            expect(read.status, `${endpoint} ${name}`).toBe(200);
            expect((yield* body(Retained, read)).id, `${endpoint} ${name}`).toBe(first.version.id);
          }

        const activated = yield* api.request(agent, "POST", `${path}/activate`, {
          deployment: first.version.id,
          expectedDeployment: second.version.id,
        });
        expect(activated.status, JSON.stringify(activated.body)).toBe(200);
        expect(yield* body(App, activated)).toMatchObject({
          activeVersion: first.version.id,
          activeDeployment: first.version.id,
        });
        const stale = yield* api.request(agent, "POST", `${path}/activate`, {
          version: second.version.id,
          expectedVersion: second.version.id,
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        expect(stale.body).toMatchObject({ _tag: "AppVersionChanged" });
      }),
    ),
  );
});
