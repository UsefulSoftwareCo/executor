import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { liveOpenapiFixture } from "../support/live-openapi.ts";
import { scenarios } from "../test-plan.ts";

/** A tool the importer left out fails with the reason, as the app's evaluation failure. */
const LeftOut = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  failure: Schema.Struct({ errorName: Schema.String, code: Schema.String }),
});

/** A call to a tool the app no longer exposes. */
const Removed = Schema.Struct({ _tag: Schema.Literal("ToolNotFound"), message: Schema.String });
/** A call the upstream answered with an error its document does not declare. */
const Failed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  failure: Schema.Struct({ errorName: Schema.String, message: Schema.String }),
});
const Listing = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI", (it) => {
  it.effect(scenarios.liveOpenapi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* liveOpenapiFixture(0, { staleFor: 0 });
        const { call, callTool, api, actors, path } = fixture;
        const first = yield* call("old", "old");
        expect(first.status).toBe(200);
        expect(yield* body(Schema.Json, first)).toEqual({
          token: "synthetic-live-key",
          stolen: null,
        });
        yield* fixture.publish;
        const changed = yield* call("new", "new");
        expect(changed.status).toBe(200);
        expect(yield* body(Schema.Json, changed)).toEqual({
          token: "synthetic-live-key",
          stolen: null,
        });
        expect((yield* call("old", "old")).status).toBe(404);
        // The flat operationId-based name no longer exists.
        expect((yield* callTool("echoes_new", "new")).status).toBe(404);
        // An operation on another origin is left out; calling its tool says why.
        const evil = yield* callTool("evil.getEvil", "new");
        expect(evil.status, JSON.stringify(evil.body)).toBe(502);
        expect((yield* body(LeftOut, evil)).failure).toEqual({
          errorName: "OpenapiCompileError",
          code: "multiple_hosts",
        });
        const tools = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(tools.status).toBe(200);
        const listing = yield* body(
          Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          tools,
        );
        expect(listing.items.map((tool) => tool.name)).toEqual(["echoes.new", "status.getHealth"]);
      }),
    ),
  );
  it.effect(scenarios.liveOpenapiRetired.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // Fresh for a minute: without a recheck, the retained document keeps the removed operation.
        const fixture = yield* liveOpenapiFixture(60_000, { retiring: true });
        const { invoke, api, actors, path } = fixture;
        const listed = (yield* body(
          Listing,
          yield* api.request(actors.owner, "GET", `${path}/tools`),
        )).items.map((tool) => tool.name);
        expect(listed).toContain("legacy.list");
        expect(listed).toContain("items.get");
        expect((yield* invoke("legacy.list", {})).status).toBe(200);

        // The upstream drops the operation and its route answers 404. Concurrent calls share one
        // recheck of the document, which no longer has it: each reports an unknown tool.
        yield* fixture.publish;
        const downloads = yield* fixture.downloads;
        const removed = yield* Effect.all(
          Array.from({ length: 3 }, () => invoke("legacy.list", {})),
          { concurrency: "unbounded" },
        );
        for (const response of removed) {
          expect(response.status, JSON.stringify(response.body)).toBe(404);
          const { message } = yield* body(Removed, response);
          expect(message).toContain("legacy.list");
          expect(message).toMatch(/search/i);
        }
        expect(yield* fixture.downloads).toBe(downloads + 1);
        const relisted = (yield* body(
          Listing,
          yield* api.request(actors.owner, "GET", `${path}/tools`),
        )).items.map((tool) => tool.name);
        expect(relisted).not.toContain("legacy.list");
        expect(relisted).toContain("items.get");

        // An operation the document still has keeps the upstream's failure, which names its
        // status but never its body. The recent recheck is not repeated.
        const missing = yield* invoke("items.get", {});
        expect(missing.status, JSON.stringify(missing.body)).toBe(502);
        const failed = yield* body(Failed, missing);
        expect(failed.failure.errorName).toBe("OpenapiError");
        expect(failed.reason).toContain("GET /missing responded with HTTP 404");
        expect(JSON.stringify(missing.body)).not.toContain("No item for token");
        expect(JSON.stringify(missing.body)).not.toContain("synthetic-live-key");
        expect(yield* fixture.downloads).toBe(downloads + 1);
      }),
    ),
  );
});
