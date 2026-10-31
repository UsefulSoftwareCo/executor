/**
 * A deploy to an existing app can name the active version it expects. When another version is
 * active by then, as after someone else's deploy, it fails with AppVersionChanged before building,
 * saves no version and leaves the active one as it was. Without `expectedVersion` a deploy does
 * not check, as before.
 */
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
const Deployed = Schema.Struct({
  app: Schema.Struct({ id: Schema.String, activeVersion: Schema.String }),
  version: Schema.Struct({ id: Schema.String }),
});
const Changed = Schema.Struct({
  _tag: Schema.Literal("AppVersionChanged"),
  expected: Schema.String,
  current: Schema.String,
});

layer(TestLive, { excludeTestServices: true })("Deploys that expect a version", (it) => {
  it.effect(scenarios.localDeployExpectedVersion.title, (context) =>
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
        const deploy = (data: unknown) => api.request(agent, "POST", "/v1/apps/deploy", data);
        const first = yield* body(
          Deployed,
          yield* deploy({
            owner: "local",
            name: `Expected ${randomUUID().slice(0, 8)}`,
            files: [source("first"), appsManifest],
          }),
        );
        const app = first.app.id;
        yield* Effect.addFinalizer(() =>
          api.request(agent, "DELETE", `/v1/apps/${app}`).pipe(Effect.orDie),
        );
        // Someone else deploys after the first version was read.
        const second = yield* body(
          Deployed,
          yield* deploy({ owner: "local", app, files: [source("second"), appsManifest] }),
        );
        const stale = yield* deploy({
          owner: "local",
          app,
          files: [source("stale"), appsManifest],
          expectedVersion: first.version.id,
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        expect(yield* body(Changed, stale)).toMatchObject({
          expected: first.version.id,
          current: second.version.id,
        });
        const listed = yield* body(
          Schema.Array(Schema.Unknown),
          yield* api.request(agent, "GET", `/v1/apps/${app}/versions`),
        );
        expect(listed).toHaveLength(2);
        const current = yield* body(
          Deployed.fields.app,
          yield* api.request(agent, "GET", `/v1/apps/${app}`),
        );
        expect(current.activeVersion).toBe(second.version.id);
        // The version that is active deploys.
        const fresh = yield* body(
          Deployed,
          yield* deploy({
            owner: "local",
            app,
            files: [source("third"), appsManifest],
            expectedVersion: second.version.id,
          }),
        );
        expect(fresh.app.activeVersion).toBe(fresh.version.id);
      }),
    ),
  );
});
