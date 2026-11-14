/**
 * A new organization's first Tools index loads the Executor catalog without redundant cache round
 * trips, later browsing reads the kept tool listing instead of evaluating the app again, and another
 * account set evaluates it again.
 */
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

/** One Tools index request through the actor's linked Executor key. */
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

/** The app's cache round trips, read from the index request's delivered trace. */
const cacheTrips = (index: Effect.Success<ReturnType<typeof indexTools>>, app: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    // The app's spans arrive as one batch returned with the invocation's result.
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
    // Each host-side command names the app whose supervisor it reached.
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
      // Cloud also reports each command from the host side of the RPC when it has arrived.
      host: host.map((span) => ({ operation: span.tags["cache.operation"], ms: span.durationMs })),
    });
    return {
      result,
      count: (operation: string) =>
        commands.filter((span) => span.tags["cache.operation"] === operation).length,
    };
  });

/** One tool's schemas through the actor's linked account. */
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

/** How a request read the tool listing, and whether it invoked the app, from its trace. */
const listingRead = (traceId: string, label: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    const spans = yield* telemetry.query(traceId).pipe(
      Effect.map((result) => result.data.map((row) => row.span)),
      Effect.flatMap((spans) =>
        spans.some((span) => span.operationName === "sdk.tools.listing")
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
        // Browsing again reads the listing the first index kept instead of evaluating the app.
        const kept = yield* indexTools(actors.owner, app.id, "kept-index");
        expect(cold.names.length).toBeGreaterThan(0);
        expect(kept.names).toEqual(cold.names);
        const keptIndex = yield* listingRead(kept.request.traceId, "kept-index");
        expect(keptIndex.cache).toBe("hit");
        expect(keptIndex.dispatched).toBe(false);

        // Another account context runs in its own Worker and reads the shared stored revision.
        const other = yield* indexTools(actors.admin, app.id, "other-account-index");
        expect(other.names).toEqual(cold.names);

        // Another linked account is another account set and so another listing: connecting it
        // from the app replaces the linked key, and the app is evaluated again and reuses the
        // catalog revision already stored.
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
        const submitted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          {
            method: "apiKey",
            label: "Second Executor key",
            fields: { token: "synthetic-second-key", organization: actors.organization.id },
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
        const revisedListing = yield* listingRead(revised.request.traceId, "revised-listing");
        expect(revisedListing.dispatched).toBe(true);

        const [first, second, third] = yield* Effect.all(
          [cacheTrips(cold, app.id), cacheTrips(revised, app.id), cacheTrips(other, app.id)],
          { concurrency: "unbounded" },
        );

        expect(first.result).toBe("miss");
        // One acquire reads and claims the catalog pointer; publishing ends the load's lease.
        expect(first.count("acquire")).toBe(1);
        expect(first.count("write")).toBeGreaterThan(0);
        expect(first.count("publish")).toBe(1);
        expect(first.count("claim")).toBe(0);
        expect(first.count("release")).toBe(0);
        // The loader keeps the revision it stored instead of reading it straight back.
        expect(first.count("read")).toBe(0);

        expect(second.result).toBe("fresh");
        expect(second.count("acquire")).toBe(1);
        expect(second.count("write") + second.count("publish") + second.count("claim")).toBe(0);

        expect(third.result).toBe("fresh");
        expect(third.count("read")).toBeGreaterThan(0);
        expect(third.count("write") + third.count("publish") + third.count("claim")).toBe(0);

        // Linking the first key again replaces the second; opening one tool reads its schemas
        // from that key's kept listing.
        yield* linkAccount(actors.owner, appPath, "service", account);
        expect(yield* linkedAccountIds(actors.owner, appPath)).toEqual([account]);
        const tool = yield* toolDetail(actors.owner, app.id, cold.names[0] ?? "");
        const keptTool = yield* listingRead(tool.traceId, "kept-tool");
        expect(keptTool.cache).toBe("hit");
        expect(keptTool.source).toBe("listing");
        expect(keptTool.dispatched).toBe(false);
      }),
    ),
  );
});
