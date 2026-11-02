/** Local calls expose the product's one caller even without linked accounts. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, mutation, object, query, router, string } from "apps";
const who = query({ input: object({}) }, async (ctx) => ctx.user.id ?? "missing");
const spoof = mutation({ input: object({ caller: string() }) }, async (ctx) => ctx.user.id ?? "missing");
export default defineApp({}, { tools: router({ who, spoof }) });`;

layer(TestLive, { excludeTestServices: true })("Local app caller identity", (it) => {
  it.effect(scenarios.localAppCallerIdentity.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Caller identity",
            files: [{ path: "index.ts", content: source }, appsManifest],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session
            .send("DELETE", `/v1/apps/${app.id}`, undefined, headers)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const call = (tool: string, kind: "query" | "mutation", input: Schema.Json) =>
          session.send("POST", "/v1/tools/call", { app: app.id, tool, kind, input }, headers).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) =>
              body(
                Schema.Struct({
                  status: Schema.Literal("completed"),
                  value: Schema.String,
                }),
                response,
              ),
            ),
            Effect.map((result) => result.value),
          );
        expect(yield* call("who", "query", {})).toBe("local");
        expect(yield* call("spoof", "mutation", { caller: "synthetic-other" })).toBe("local");
        expect(yield* call("who", "query", {})).toBe("local");
      }),
    ),
  );
});
