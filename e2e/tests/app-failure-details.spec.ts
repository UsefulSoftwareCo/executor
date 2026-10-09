/** Build, operation and evaluation failures reach the app's caller with their own details. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("DeploymentBuildFailed"),
  stage: Schema.String,
  location: Schema.optional(
    Schema.Struct({
      file: Schema.String,
      line: Schema.optional(Schema.Number),
      column: Schema.optional(Schema.Number),
    }),
  ),
  message: Schema.String,
});
const ToolFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.optional(Schema.String),
    message: Schema.String,
  }),
});
const ExecutionFailed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        recovery: Schema.optional(
          Schema.Struct({ action: Schema.String, instructions: Schema.String }),
        ),
      }),
    }),
  }),
});

const declarationMarker = "synthetic declaration failure";
const appMarker = "conversation.id is required";

const operationApp = [
  {
    path: "index.ts",
    content: `import { defineApp, string, query, mutation, object, router } from "apps";
class ConversationMissing extends Error { override name = "ConversationMissing"; }
export default defineApp({ accounts: {} }, {
  tools: router({
    fail: query({ input: object({}) }, async () => { throw new ConversationMissing(${JSON.stringify(appMarker)}); }),
    failWrite: mutation({ input: object({}) }, async (ctx) =>
      ctx.sql.transaction((tx) => {
        tx.exec("INSERT INTO items (label) VALUES ('rolled back')");
        throw new TypeError(${JSON.stringify(appMarker)});
      })),
  }),
});`,
  },
  {
    path: "migrations/0001_items.sql",
    content: `CREATE TABLE items (label TEXT NOT NULL);
`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("App failure details", (it) => {
  it.effect(scenarios.appBuildFailureDetails.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (files: ReadonlyArray<{ path: string; content: string }>) =>
          api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name: `Build failure ${randomUUID().slice(0, 8)}`,
            files: [...files, appsManifest],
          });

        // The compiler's own error and location reach the deployer, with 1-based columns.
        const compile = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, router } from "apps";
export default defineApp({ accounts: {} }, { tools: router({ broken: ) }) });`,
          },
        ]);
        yield* evidence.json("compile-failure.json", compile.body);
        expect(compile.status).toBe(422);
        const compiled = yield* body(BuildFailed, compile);
        expect(compiled).toMatchObject({
          stage: "compile",
          location: { file: "index.ts", line: 2, column: 70 },
        });
        expect(compiled.message).toContain('index.ts:2:70: Unexpected ")"');

        // Columns count UTF-16 code units, as editors do, after non-ASCII text on the same line:
        // "é" is one unit and "🙂" two, though they take two and four bytes.
        const unicode = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, router } from "apps";
export default defineApp({ accounts: {} }, { tools: router({ "café 🙂": ) }) });`,
          },
        ]);
        yield* evidence.json("unicode-compile-failure.json", unicode.body);
        expect(unicode.status).toBe(422);
        const counted = yield* body(BuildFailed, unicode);
        expect(counted).toMatchObject({
          stage: "compile",
          location: { file: "index.ts", line: 2, column: 73 },
        });
        expect(counted.message).toContain('index.ts:2:73: Unexpected ")"');

        // An import that no deployed file satisfies fails where it is written.
        const missing = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, router } from "apps";
import { value } from "./not-there.ts";
export default defineApp({ accounts: {} }, { tools: router({ value }) });`,
          },
        ]);
        yield* evidence.json("missing-module-failure.json", missing.body);
        expect(missing.status).toBe(422);
        const unloaded = yield* body(BuildFailed, missing);
        expect(unloaded).toMatchObject({
          stage: "compile",
          location: { file: "index.ts", line: 2, column: 23 },
        });
        expect(unloaded.message).toContain('index.ts:2:23: Cannot find "./not-there.ts"');

        // A declaration that throws while the Worker loads is located in its own file, and a
        // value passed where a schema belongs is named.
        const invalid = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
import { tools } from "./lib/tools.js";
export default defineApp({ accounts: {} }, { tools });`,
          },
          {
            path: "lib/tools.ts",
            content: `import { object, query, router, string } from "apps";
export const tools = router({
  search: query({ input: object({ q: string }) }, async () => []),
});`,
          },
        ]);
        yield* evidence.json("invalid-schema-failure.json", invalid.body);
        expect(invalid.status).toBe(422);
        const located = yield* body(BuildFailed, invalid);
        expect(located).toMatchObject({
          stage: "declaration",
          location: { file: "lib/tools.ts", line: 3, column: 26 },
        });
        expect(located.message).toContain('The object() field "q" must be a schema');
        expect(located.message).toContain("Call it, as in string().");
        expect(located.message).toContain("at lib/tools.ts:3:26");

        // An app that throws while its module loads reports its own message at declaration.
        const declaration = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
throw new Error(${JSON.stringify(declarationMarker)});
export default defineApp({ accounts: {} }, {});`,
          },
        ]);
        yield* evidence.json("declaration-failure.json", declaration.body);
        expect(declaration.status).toBe(422);
        const declared = yield* body(BuildFailed, declaration);
        expect(declared.stage).toBe("declaration");
        expect(declared.message).toContain(declarationMarker);

        // A frozen error keeps its own name, message and location: reporting it changes nothing on it.
        const frozen = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
throw Object.freeze(new TypeError(${JSON.stringify(declarationMarker)}));
export default defineApp({ accounts: {} }, {});`,
          },
        ]);
        yield* evidence.json("frozen-declaration-failure.json", frozen.body);
        expect(frozen.status).toBe(422);
        const kept = yield* body(BuildFailed, frozen);
        expect(kept).toMatchObject({
          stage: "declaration",
          location: { file: "index.ts", line: 2, column: 21 },
        });
        expect(kept.message).toContain(`TypeError: ${declarationMarker}`);
        expect(kept.message).toContain("at index.ts:2:21");
        expect(kept.message).not.toContain("read only");

        // The Executor app's deploy tool carries the same detail to an MCP caller.
        const { client, profile } = yield* frameworkSession;
        const deployed = yield* client.use("Deploy a failing app through MCP", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools.executor.profiles[${JSON.stringify(profile.id)}].apps.deploy(${JSON.stringify(
                  {
                    path: { organization: actors.organization.id },
                    body: {
                      name: `MCP build failure ${randomUUID().slice(0, 8)}`,
                      files: [
                        {
                          path: "index.ts",
                          content: `import { defineApp } from "apps";\nthrow new Error(${JSON.stringify(declarationMarker)});\nexport default defineApp({ accounts: {} }, {});`,
                        },
                        appsManifest,
                      ],
                    },
                  },
                )});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("mcp-deploy-failure.json", deployed.structuredContent);
        const mcpFailure = (yield* Schema.decodeUnknownEffect(ExecutionFailed)(
          deployed.structuredContent,
        )).execution.error;
        expect(mcpFailure.response.code).toBe("DeploymentBuildFailed");
        expect(mcpFailure.response.message).toContain("declaration");
        expect(mcpFailure.response.message).toContain(declarationMarker);
        expect(mcpFailure.message).not.toContain("Operation execution failed");
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.appOperationFailureDetails.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Operation failure ${randomUUID().slice(0, 8)}`,
          files: operationApp,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const call = (tool: string, kind: "query" | "mutation") =>
          api.request(actors.owner, "POST", `${prefix}/${app.id}/tools/call`, {
            tool,
            kind,
            input: {},
          });

        // The app's own error name and message pass through, not a fixed SDK reason.
        const query = yield* body(ToolFailed, yield* call("fail", "query"));
        expect(query.failure).toEqual({
          source: "app",
          errorName: "ConversationMissing",
          message: appMarker,
        });
        expect(query.reason).toBe(`The app threw ConversationMissing: ${appMarker}`);
        const mutation = yield* body(ToolFailed, yield* call("failWrite", "mutation"));
        expect(mutation.failure).toMatchObject({ source: "app", errorName: "TypeError" });

        // MCP callers receive the same message with recovery guidance.
        const { client } = yield* frameworkSession;
        const executed = yield* client.use("Call a failing app query", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].fail({});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("mcp-operation-failure.json", executed.structuredContent);
        const failure = (yield* Schema.decodeUnknownEffect(ExecutionFailed)(
          executed.structuredContent,
        )).execution.error;
        expect(failure.response).toMatchObject({
          code: "ToolCallFailed",
          message: `The app threw ConversationMissing: ${appMarker}`,
          recovery: { action: "Fix the input or the app code that threw this error, then retry." },
        });
        expect(failure.message).toContain(appMarker);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
