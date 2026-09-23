/** Deploy a small older snapshot after unrelated source has grown; check the actual Git transfer. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Workspace } from "../support/app-authoring.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const files = [
  {
    path: "index.ts",
    content: `import {defineApp,object,query} from 'apps'; export default defineApp({accounts:{}},{queries:{hello:query({input:object({})},async()=>"historical snapshot")}});`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Historical source", (it) => {
  it.effect(scenarios.historicalSource.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/drafts`, {
          name: `Historical source ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(created.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), created);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const read = () =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", `${path}/workspace`);
            expect(response.status).toBe(200);
            return yield* body(Workspace, response);
          });
        const initial = yield* read();
        let current = initial;
        // Two modest incompressible files make an unbounded history fetch observable without a load test.
        for (let revision = 0; revision < 2; revision += 1) {
          const response = yield* api.request(actors.owner, "POST", `${path}/commits`, {
            expected: current.revision.commit,
            files: [
              ...files,
              { path: "later.txt", content: randomBytes(256 * 1024).toString("base64") },
            ],
            message: `Later revision ${revision}`,
          });
          expect(response.status).toBe(200);
          current = yield* body(Workspace, response);
        }
        expect(current.revision.commit).not.toBe(initial.revision.commit);
        const deployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          commit: initial.revision.commit,
        });
        expect(deployed.status).toBe(200);
        if (target.metadata.target === "cloud") {
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined)
            return yield* Effect.fail(new Error("Missing deployment request evidence"));
          const trace = yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((trace) =>
              trace.data.some(({ span }) => span.operationName === "http.server POST")
                ? Effect.succeed(trace)
                : Effect.fail(new Error("Missing completed historical deployment trace")),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
          );
          yield* evidence.json("historical-deployment-trace.json", trace);
          expect(
            trace.data.filter(({ span }) => span.operationName === "source.git.clone"),
          ).toHaveLength(1);
          expect(
            trace.data.filter(({ span }) => span.operationName === "source.git.refs"),
          ).toHaveLength(0);
          const transfers = trace.data
            .filter(({ span }) => span.operationName === "source.git.http.body")
            .map(({ span }) => Number(span.tags["source.git.response.bytes"]));
          expect(transfers.length).toBeGreaterThan(0);
          expect(transfers.every((bytes) => Number.isFinite(bytes) && bytes >= 0)).toBe(true);
          expect(transfers.reduce((total, bytes) => total + bytes, 0)).toBeLessThan(128 * 1024);
        }
        const source = yield* api.request(actors.owner, "GET", `${path}/source`);
        expect(source.status).toBe(200);
        const retained = yield* body(
          Schema.Struct({ sourceCommit: Schema.String, files: Workspace.fields.files }),
          source,
        );
        expect(retained.sourceCommit).toBe(initial.revision.commit);
        expect(retained.files).toEqual(files);
        expect(yield* read()).toEqual(current);
        const invalid = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          commit: "f".repeat(40),
        });
        expect(invalid.status).toBe(503);
        const afterFailure = yield* api.request(actors.owner, "GET", `${path}/source`);
        expect(afterFailure.status).toBe(200);
        expect(
          (yield* body(Schema.Struct({ files: Workspace.fields.files }), afterFailure)).files,
        ).toEqual(files);
      }),
    ),
  );
});
