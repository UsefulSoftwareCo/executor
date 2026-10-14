import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { accountToolSource } from "../support/tool-account-context.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";

const Index = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

/** The IDs of a span's ancestors in its trace, nearest first. */
const ancestry = (
  trace: typeof SpanQuery.Type,
  span: { readonly parentSpanId: string | null },
): ReadonlyArray<string> => {
  const parents = new Map(trace.data.map(({ span }) => [span.spanId, span.parentSpanId]));
  const ids: string[] = [];
  for (
    let id: string | null | undefined = span.parentSpanId;
    id !== null && id !== undefined;
    id = parents.get(id)
  )
    ids.push(id);
  return ids;
};

layer(HostedLive, { excludeTestServices: true })("Cloud build reuse", (it) => {
  it.effect(scenarios.cloudBuildReuse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Build reuse ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: accountToolSource }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        // The deploy writes its retained build to this data centre's Cache API in the background.
        const deployRequest = (yield* evidence.requests).at(-1);
        if (deployRequest === undefined)
          return yield* Effect.die("Deploy request evidence missing");
        const warmed = yield* telemetry.query(deployRequest.traceId).pipe(
          Effect.flatMap((result) => {
            // The record is always written; the framework only when the isolate did not hold it.
            const write = result.data.find(
              ({ span }) =>
                span.operationName === "runtime.cloud.build.cache_write" &&
                span.tags["executor.build.cache_part"] === "record",
            );
            return write === undefined
              ? Effect.fail(new Error("The deploy's build cache write has not been delivered"))
              : Effect.succeed({ result, write });
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        yield* evidence.json("deploy.json", warmed.result);
        expect(warmed.write.span.tags["executor.build.cache_write"]).toBe("stored");
        for (const { span } of warmed.result.data)
          if (span.operationName === "runtime.cloud.build.cache_write")
            expect(
              span.tags["executor.build.cache_write"],
              span.tags["executor.build.cache_part"],
            ).toBe("stored");
        const app = yield* body(App, deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const add = (label: string, token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              // Connecting from the app links the account to it.
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app.id}`, "user", "workspaces"),
                {},
              ),
            );
            const account = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                {
                  method: "key",
                  label,
                  fields: { token },
                },
              ),
            );
            accounts.push(account.id);
            return account.id;
          });
        const work = yield* add("Work", "work"),
          personal = yield* add("Personal", "personal");

        // Every delivered trace with a span of this operation whose attributes match.
        const tracesWith = (operation: string, attributes: Readonly<Record<string, string>>) =>
          telemetry
            .search(operation, attributes)
            .pipe(
              Effect.flatMap((found) =>
                Effect.forEach(new Set(found.data.map(({ traceId }) => traceId)), telemetry.query),
              ),
            );
        const r2Reads = (trace: typeof SpanQuery.Type, under?: string) =>
          trace.data.filter(
            ({ span }) =>
              span.operationName === "storage.blob.get" &&
              (under === undefined || ancestry(trace, span).includes(under)),
          ).length;

        // Each linked account set is a separate Worker identity, so each index starts a cold Worker
        // for the same immutable build. The runner in the AppData Worker reads the build itself:
        // the API that sends the call never loads, decodes or transfers app code.
        // Linking an account wakes the schedule coordinator, which may call the app with the
        // linked account before the index does. Whichever call reaches a Worker first starts it,
        // so an account's cold start is found by its Worker identity, in the index's trace
        // or the coordinator's.
        const coldStarts = (identity: string) =>
          tracesWith("runtime.app.invoke", { "executor.worker.identity": identity }).pipe(
            Effect.map((traces) =>
              traces.flatMap((trace) =>
                trace.data
                  .filter(
                    ({ span }) =>
                      span.operationName === "runtime.app.invoke" &&
                      span.tags["executor.worker.identity"] === identity,
                  )
                  .flatMap(({ span: invoke }) => {
                    // The build loads beside the call, under the runner's span that serves it.
                    const served = invoke.parentSpanId;
                    const loads = trace.data.filter(
                      ({ span }) =>
                        span.operationName === "runtime.cloud.build.cached" &&
                        served !== null &&
                        ancestry(trace, span).includes(served),
                    );
                    return served === null || loads.length === 0 ? [] : [{ trace, loads }];
                  }),
              ),
            ),
            Effect.flatMap((starts) =>
              starts.length === 0
                ? Effect.fail(new Error("The cold Worker's build load has not been delivered"))
                : Effect.succeed(starts),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
        /** The many() requirement uses every linked account: link exactly `account` first. */
        const linkOnly = (account: string) =>
          Effect.gen(function* () {
            const path = `${prefix}/apps/${app.id}`;
            for (const linked of yield* linkedAccountIds(actors.owner, path))
              if (linked !== account)
                yield* unlinkAccount(actors.owner, path, "workspaces", linked);
            yield* linkAccount(actors.owner, path, "workspaces", account);
            expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
          });
        const coldIndex = (account: string, tool: string) =>
          Effect.gen(function* () {
            yield* linkOnly(account);
            const traceId = randomUUID().replaceAll("-", "");
            const response = yield* actors.owner.send(
              "GET",
              `${prefix}/apps/${app.id}/tools/index`,
              undefined,
              { traceparent: `00-${traceId}-1234567890abcdef-01` },
            );
            expect(response.status).toBe(200);
            const index = yield* body(Index, response);
            expect(index.items.map((item) => item.name)).toContain(tool);
            const { trace, identity } = yield* telemetry.query(traceId).pipe(
              Effect.flatMap((trace) => {
                const identity = trace.data.find(
                  ({ span }) => span.operationName === "runtime.app.invoke",
                )?.span.tags["executor.worker.identity"];
                return identity === undefined
                  ? Effect.fail(new Error("The index's app call has not been delivered"))
                  : Effect.succeed({ trace, identity });
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
            );
            yield* evidence.json(`index-${tool}.json`, trace);
            const starts = yield* coldStarts(identity);
            yield* evidence.json(
              `cold-start-${tool}.json`,
              starts.map((start) => start.trace),
            );
            const loads = starts.flatMap((start) => start.loads);
            expect(loads, "One cold Worker start loads its build once").toHaveLength(1);
            const [start] = starts;
            const load = loads[0]?.span;
            if (start === undefined || load === undefined)
              return yield* Effect.die("Cold start evidence missing");
            const spans = new Map(start.trace.data.map(({ span }) => [span.spanId, span]));
            expect(
              ancestry(start.trace, load).map((id) => spans.get(id)?.operationName ?? "[missing]"),
              "The runner, not the calling Worker, reads the build",
            ).toContain("runtime.app.serve");
            expect(r2Reads(trace), "The index reads no build from R2").toBe(0);
            return {
              build: load.tags["executor.build.id"],
              source: load.tags["executor.build.cache"],
            };
          });

        const first = yield* coldIndex(work, "work");
        // The coordinator may have loaded the build already, for another linked account.
        expect(["hit", "memory"], "The runner reads a cached record").toContain(first.source);
        const second = yield* coldIndex(personal, "personal");
        expect(second.source, "The runner reuses the build it already decoded").toBe("memory");
        if (first.build === undefined) return yield* Effect.die("Build ID missing");

        // Every load of the build in the runner, by any call.
        const loads = (yield* tracesWith("runtime.cloud.build.cached", {
          "executor.build.id": first.build,
        }))
          .flatMap((trace) =>
            trace.data
              .filter(
                ({ span }) =>
                  span.operationName === "runtime.cloud.build.cached" &&
                  span.tags["executor.build.id"] === first.build,
              )
              .map(({ span }) => ({ trace, span })),
          )
          .toSorted((a, b) => a.span.startTime.localeCompare(b.span.startTime));
        yield* evidence.json(
          "build-loads.json",
          loads.map(({ span }) => span),
        );
        const [earliest] = loads;
        expect(
          earliest?.span.tags["executor.build.cache"],
          "The runner reads the record the deploy cached",
        ).toBe("hit");
        // The framework is stored apart from the record. The deploy cached it unless the cache
        // already held it; the runner may also hold it decoded from an earlier build, or be
        // decoding it for another app on this apps release, whose read this one waits for.
        expect(["hit", "memory", "shared"], "The runner reads a cached framework").toContain(
          earliest?.span.tags["executor.build.framework_cache"],
        );
        expect(
          loads.map(({ trace, span }) => r2Reads(trace, span.spanId)),
          "A freshly deployed build is not read from R2",
        ).toEqual(loads.map(() => 0));
      }),
    ),
  );
});
