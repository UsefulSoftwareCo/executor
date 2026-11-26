import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { managementApp } from "../support/management-app.ts";
import { linkAccount, linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";

const Index = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
const Detail = Schema.Struct({
  name: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
});

const indexTools = (actor: Session, app: string, label: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      evidence = yield* Evidence;
    const root = `/api/organizations/${actors.organization.id}/apps/${app}`;
    const response = yield* api.request(actor, "GET", `${root}/tools/index`);
    expect(response.status, label).toBe(200);
    const index = yield* body(Index, response);
    const request = (yield* evidence.requests).at(-1);
    if (request === undefined) return yield* Effect.die(new Error("The index request is missing"));
    return { label, request, names: index.items.map((tool) => tool.name).sort() };
  });

const cacheTrips = (index: Effect.Success<ReturnType<typeof indexTools>>, app: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    const spans = yield* telemetry.query(index.request.traceId).pipe(
      Effect.map((result) => result.data.map((row) => row.span)),
      Effect.flatMap((spans) =>
        spans.some((span) => span.operationName === "app.cache.get") &&
        spans.some((span) => span.operationName === "app.dispatch")
          ? Effect.succeed(spans)
          : Effect.fail(new Error(`The ${index.label} trace has not arrived`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 40 }),
    );
    const commands = spans.filter((span) => span.operationName === "app.cache.command");
    const host = spans.filter((span) => span.operationName === "runtime.cloud.cache");
    for (const span of host) expect(span.tags["executor.app.id"], index.label).toBe(app);
    const result = spans.find((span) => span.operationName === "app.cache.get")?.tags[
      "cache.result"
    ];
    yield* evidence.json(`${index.label}.json`, {
      durationMs: index.request.durationMs,
      result,
      commands: commands.map((span) => ({
        operation: span.tags["cache.operation"],
        ms: span.durationMs,
      })),
      host: host.map((span) => ({ operation: span.tags["cache.operation"], ms: span.durationMs })),
    });
    return {
      result,
      count: (operation: string) =>
        commands.filter((span) => span.tags["cache.operation"] === operation).length,
    };
  });

const toolDetail = (actor: Session, app: string, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      evidence = yield* Evidence;
    const root = `/api/organizations/${actors.organization.id}/apps/${app}`;
    const response = yield* api.request(actor, "GET", `${root}/tools/${encodeURIComponent(name)}`);
    expect(response.status, name).toBe(200);
    const tool = yield* body(Detail, response);
    expect(tool.name).toBe(name);
    const request = (yield* evidence.requests).at(-1);
    if (request === undefined) return yield* Effect.die(new Error("The tool request is missing"));
    return request;
  });

const listingRead = (traceId: string, label: string, reads: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    const spans = yield* telemetry.query(traceId).pipe(
      Effect.map((result) => result.data.map((row) => row.span)),
      Effect.flatMap((spans) =>
        reads.every((name) => spans.some((span) => span.operationName === name))
          ? Effect.succeed(spans)
          : Effect.fail(new Error(`The ${label} trace has not arrived`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 40 }),
    );
    yield* evidence.json(`${label}.json`, spans);
    return {
      cache: spans.find((span) => span.operationName === "sdk.tools.listing")?.tags[
        "executor.declarations.cache"
      ],
      source: spans.find((span) => span.operationName === "sdk.tools.get")?.tags[
        "executor.tools.source"
      ],
      dispatched: spans.some((span) => span.operationName === "app.dispatch"),
    };
  });

layer(HostedLive, { excludeTestServices: true })("Tools index cache", (it) => {
  it.effect(scenarios.toolsIndexCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app, account } = yield* managementApp(actors.owner);
        yield* managementApp(actors.admin);
        const cold = yield* indexTools(actors.owner, app.id, "cold-index");
        const kept = yield* indexTools(actors.owner, app.id, "kept-index");
        expect(cold.names.length).toBeGreaterThan(0);
        expect(kept.names).toEqual(cold.names);
        const keptIndex = yield* listingRead(kept.request.traceId, "kept-index", [
          "sdk.tools.listing",
        ]);
        expect(keptIndex.cache).toBe("hit");
        expect(keptIndex.dispatched).toBe(false);

        const other = yield* indexTools(actors.admin, app.id, "other-account-index");
        expect(other.names).toEqual(cold.names);

        const prefix = `/api/organizations/${actors.organization.id}`;
        const connection = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const secondToken = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.String }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Second Executor key",
            metadata: { organization: actors.organization.id },
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: secondToken.id })
            .pipe(Effect.orDie),
        );
        const submitted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          {
            method: "apiKey",
            label: "Second Executor key",
            fields: { token: secondToken.key, organization: actors.organization.id },
          },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const secondKey = yield* body(Schema.Struct({ id: Schema.String }), submitted);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${secondKey.id}`)
            .pipe(Effect.orDie),
        );
        const appPath = `${prefix}/apps/${app.id}`;
        expect(yield* linkedAccountIds(actors.owner, appPath)).toEqual([secondKey.id]);
        const revised = yield* indexTools(actors.owner, app.id, "revised-index");
        expect(revised.names).toEqual(cold.names);
        const revisedListing = yield* listingRead(revised.request.traceId, "revised-listing", [
          "sdk.tools.listing",
          "app.dispatch",
        ]);
        expect(revisedListing.dispatched).toBe(true);

        const [first, second, third] = yield* Effect.all(
          [cacheTrips(cold, app.id), cacheTrips(revised, app.id), cacheTrips(other, app.id)],
          { concurrency: "unbounded" },
        );

        expect(first.result).toBe("miss");
        expect(first.count("acquire")).toBe(1);
        expect(first.count("write")).toBeGreaterThan(0);
        expect(first.count("publish")).toBe(1);
        expect(first.count("claim")).toBe(0);
        expect(first.count("release")).toBe(0);
        expect(first.count("read")).toBe(0);

        expect(second.result).toBe("fresh");
        expect(second.count("acquire")).toBe(1);
        expect(second.count("write") + second.count("publish") + second.count("claim")).toBe(0);

        expect(third.result).toBe("fresh");
        expect(third.count("read")).toBeGreaterThan(0);
        expect(third.count("write") + third.count("publish") + third.count("claim")).toBe(0);

        yield* linkAccount(actors.owner, appPath, "service", account);
        expect(yield* linkedAccountIds(actors.owner, appPath)).toEqual([account]);
        const tool = yield* toolDetail(actors.owner, app.id, cold.names[0] ?? "");
        const keptTool = yield* listingRead(tool.traceId, "kept-tool", [
          "sdk.tools.listing",
          "sdk.tools.get",
        ]);
        expect(keptTool.cache).toBe("hit");
        expect(keptTool.source).toBe("listing");
        expect(keptTool.dispatched).toBe(false);
      }),
    ),
  );
});
