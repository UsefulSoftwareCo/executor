import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { batchPath } from "../support/read-batches.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Int, status: Schema.Int })),
);

layer(HostedLive, { excludeTestServices: true })("Cloud dashboard batch resources", (it) => {
  it.effect(scenarios.cloudDashboardBatchResources.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          client = yield* HttpClient.HttpClient,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Batch resources ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  status: query({ description: "Status", input: object({}) }, async () => "ready"),
}) }));`,
              },
              appsManifest,
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const read = (group: string, endpoint: string, params: Record<string, string> = {}) => ({
          group,
          endpoint,
          params,
          query: {},
        });
        const reads = [
          read("viewer", "get"),
          read("organization", "access", { organization }),
          read("organization", "inventory", { organization }),
          read("apps", "get", { organization, app: app.id }),
          read("appAccounts", "appList", { organization, app: app.id }),
          read("appAccounts", "userList", { organization, app: app.id }),
          read("resourceAccess", "app", { organization, app: app.id }),
          read("tools", "index", { organization, app: app.id }),
        ];
        const origin = targetHosts(yield* Target).browser;
        const cookies = Redacted.value(yield* actors.owner.cookies);
        const traces = yield* Effect.forEach(
          [0, 1],
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const traceId = randomUUID().replaceAll("-", "");
                const traceparent = `00-${traceId}-${traceId.slice(0, 16)}-01`;
                const request = yield* HttpClientRequest.post(new URL(batchPath, origin)).pipe(
                  HttpClientRequest.setHeaders({
                    origin,
                    traceparent,
                    cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
                    "executor-wire-revision": "1",
                  }),
                  HttpClientRequest.bodyJson({
                    reads: reads.map((read, id) => ({ ...read, id, traceparent })),
                  }),
                );
                const response = yield* client.execute(request);
                expect(response.status).toBe(200);
                const text = yield* response.text;
                const answers = yield* Effect.forEach(text.trim().split("\n"), (line) =>
                  decodeAnswer(line),
                );
                expect(answers.map(({ id }) => id).sort((a, b) => a - b)).toEqual(
                  reads.map((_, id) => id),
                );
                expect(answers.map(({ status }) => status)).toEqual(reads.map(() => 200));
                return traceId;
              }),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        for (const trace of traces) {
          // Exports can arrive out of order; wait for the reads and both initialization spans.
          const spans = yield* telemetry.query(trace).pipe(
            Effect.flatMap((result) =>
              result.data.filter(({ span }) => span.operationName === "dashboard.batch.read")
                .length === reads.length &&
              result.data.some(({ span }) => span.operationName === "runtime.cloud.database.initialize") &&
              result.data.some(({ span }) => span.operationName === "runtime.cloud.executor.initialize")
                ? Effect.succeed(result.data)
                : Effect.fail(new Error("The completed batch trace has not reached Motel")),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          const count = (name: string) =>
            spans.filter(({ span }) => span.operationName === name).length;
          const counts = {
            pools: count("runtime.cloud.database.initialize"),
            executors: count("runtime.cloud.executor.initialize"),
          };
          yield* evidence.json(`batch-resources-${trace}.json`, counts);
          expect(counts).toEqual({ pools: 1, executors: 1 });
        }
      }),
    ),
  );
});
