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
import { readAdvice, unknownOutcomeRecovery } from "../support/write-outcome.ts";

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
        retryable: Schema.Boolean,
      }),
    }),
  }),
});

const declarationMarker = "synthetic declaration failure";
const appMarker = "conversation.id is required";

const operationApp = [
  {
    path: "index.ts",
    content: `import { CacheError, defineApp, string, query, mutation, object, router } from "apps";
class ConversationMissing extends Error { override name = "ConversationMissing"; }
export default defineApp({}, {
  tools: router({
    fail: query({ input: object({}) }, async () => { throw new ConversationMissing(${JSON.stringify(appMarker)}); }),
    cacheUnavailable: query({ input: object({}) }, async () => { throw new CacheError({ reason: "unavailable" }); }),
    cacheOverLimit: query({ input: object({}) }, async (ctx) => {
      await ctx.cache.write([{ key: "x".repeat(9000), value: true }], "1 minute");
      return true;
    }),
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
export default defineApp({}, { tools: router({ broken: ) }) });`,
          },
        ]);
        yield* evidence.json("compile-failure.json", compile.body);
        expect(compile.status).toBe(422);
        const compiled = yield* body(BuildFailed, compile);
        expect(compiled).toMatchObject({
          stage: "compile",
          location: { file: "index.ts", line: 2, column: 56 },
        });
        expect(compiled.message).toContain('index.ts:2:56: Unexpected ")"');

        // Columns count UTF-16 code units, as editors do, after non-ASCII text on the same line:
        // "é" is one unit and "🙂" two, though they take two and four bytes.
        const unicode = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, router } from "apps";
export default defineApp({}, { tools: router({ "café 🙂": ) }) });`,
          },
        ]);
        yield* evidence.json("unicode-compile-failure.json", unicode.body);
        expect(unicode.status).toBe(422);
        const counted = yield* body(BuildFailed, unicode);
        expect(counted).toMatchObject({
          stage: "compile",
          location: { file: "index.ts", line: 2, column: 59 },
        });
        expect(counted.message).toContain('index.ts:2:59: Unexpected ")"');

        // An import that no deployed file satisfies fails where it is written.
        const missing = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, router } from "apps";
import { value } from "./not-there.ts";
export default defineApp({}, { tools: router({ value }) });`,
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

        // An imported JSON file that is not JSON fails at its first invalid character.
        const json = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, query, object, router } from "apps";
import settings from "./settings.json";
export default defineApp({}, { tools: router({
  settings: query({ input: object({}) }, async () => settings),
}) });`,
          },
          { path: "settings.json", content: '{\n  "name": "synthetic",\n  "items": [1, 2,]\n}' },
        ]);
        yield* evidence.json("invalid-json-failure.json", json.body);
        expect(json.status).toBe(422);
        const parsed = yield* body(BuildFailed, json);
        expect(parsed).toMatchObject({
          stage: "compile",
          location: { file: "settings.json", line: 3, column: 18 },
        });
        expect(parsed.message).toContain("settings.json:3:18: Invalid JSON");

        // A declaration that throws while the Worker loads is located in its own file, and a
        // value passed where a schema belongs is named.
        const invalid = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
import { tools } from "./lib/tools.js";
export default defineApp({}, { tools });`,
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

        // An OAuth declaration that does not match its schema names the failing option and why,
        // leaving out the forms the author did not mean (here, discovery's missing `discover`).
        const oauth = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service = defineProvider({ name: "Synthetic", auth: { oauth: oauth2({
  authorizationUrl: "https://auth.example.test/authorize?scope=everything",
  tokenUrl: "https://auth.example.test/token",
  scopes: [],
}) } });
export default defineApp({ user: { accounts: { service } } }, {});`,
          },
        ]);
        yield* evidence.json("invalid-oauth-declaration-failure.json", oauth.body);
        expect(oauth.status).toBe(422);
        const oauthFailure = yield* body(BuildFailed, oauth);
        expect(oauthFailure.stage).toBe("declaration");
        expect(oauthFailure.message).toContain(
          "DeclarationInvalid: The oauth2() declaration is invalid. authorizationUrl: authorizationUrl cannot set protocol parameters: scope.",
        );
        expect(oauthFailure.message).not.toContain("discover");

        // A client credentials declaration is read as one, so the option it lacks is named rather
        // than the authorization code forms' objections to its grant.
        const machine = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service = defineProvider({ name: "Synthetic", auth: { oauth: oauth2({
  grant: "client_credentials",
  tokenUrl: "https://auth.example.test/token",
  scopes: [],
}) } });
export default defineApp({ user: { accounts: { service } } }, {});`,
          },
        ]);
        yield* evidence.json("incomplete-oauth-declaration-failure.json", machine.body);
        expect(machine.status).toBe(422);
        const machineFailure = yield* body(BuildFailed, machine);
        expect(machineFailure.stage).toBe("declaration");
        expect(machineFailure.message).toContain(
          "DeclarationInvalid: The oauth2() declaration is invalid. tokenEndpointAuthMethod: Missing key",
        );
        expect(machineFailure.message).not.toContain("grant");

        // An app that throws while its module loads reports its own message at declaration.
        const declaration = yield* deploy([
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
throw new Error(${JSON.stringify(declarationMarker)});
export default defineApp({}, {});`,
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
export default defineApp({}, {});`,
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
        const { client, queries } = yield* frameworkSession;
        const deployed = yield* client.use("Deploy a failing app through MCP", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await ${queries}.apps.deploy(${JSON.stringify({
                  path: { organization: actors.organization.id },
                  body: {
                    name: `MCP build failure ${randomUUID().slice(0, 8)}`,
                    files: [
                      {
                        path: "index.ts",
                        content: `import { defineApp } from "apps";\nthrow new Error(${JSON.stringify(declarationMarker)});\nexport default defineApp({}, {});`,
                      },
                      appsManifest,
                    ],
                  },
                })});`,
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

        // A cache that was unavailable for the operation, as when another load took over its
        // lease, is temporary; a request over the cache's limits fails the same way again.
        const unavailable = yield* call("cacheUnavailable", "query");
        expect(unavailable.body).toMatchObject({
          _tag: "ToolCallFailed",
          failure: {
            source: "storage",
            errorName: "CacheError",
            code: "unavailable",
            message: "The app cache was not available for this operation.",
          },
          recovery: {
            action:
              "Retry once after a short wait. If it fails again, report that the app’s storage is failing.",
          },
        });
        const overLimit = yield* call("cacheOverLimit", "query");
        expect(overLimit.body).toMatchObject({
          _tag: "ToolCallFailed",
          failure: { source: "storage", errorName: "CacheError", code: "capacity" },
          recovery: {
            action: "Change the operation to stay within the storage rule or limit it names.",
          },
        });

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
        // Executor cannot tell whether the app's error is temporary, so a read may be tried once more.
        expect(failure.response).toMatchObject({
          code: "ToolCallFailed",
          message: `The app threw ConversationMissing: ${appMarker}`,
          recovery: {
            action:
              "Read the error to determine whether input, app code, configuration or Executor needs attention.",
            instructions:
              "This error arose while running the app’s tool. Corrected input is a new call. For a read with an uncertain temporary cause, one further attempt may help.",
          },
          retryable: true,
        });
        expect(failure.message).toContain(appMarker);
        expect(failure.message).toMatch(/ Retryable \(unchanged call\): yes\.$/);
        const cacheRetryable = (tool: string) =>
          client
            .use(`Call the app query ${tool}`, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].${tool}({});`,
                  },
                },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.flatMap((executed) =>
                Schema.decodeUnknownEffect(ExecutionFailed)(executed.structuredContent),
              ),
              Effect.map(({ execution }) => execution.error.response.retryable),
            );
        expect(yield* cacheRetryable("cacheUnavailable")).toBe(true);
        expect(yield* cacheRetryable("cacheOverLimit")).toBe(false);

        // A mutation's error may follow changes it made outside app data, so the agent is told
        // not to repeat it automatically; the cause's advice for a read follows only as a quote.
        const wrote = yield* client.use("Call a failing app mutation", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].failWrite({});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("mcp-mutation-failure.json", wrote.structuredContent);
        const written = (yield* Schema.decodeUnknownEffect(ExecutionFailed)(
          wrote.structuredContent,
        )).execution.error;
        expect(written.response).toMatchObject({
          code: "ToolCallFailed",
          message: `The app threw TypeError: ${appMarker}`,
          retryable: false,
        });
        expect(written.response.recovery).toEqual(
          unknownOutcomeRecovery(
            readAdvice(
              "Read the error to determine whether input, app code, configuration or Executor needs attention. This error arose while running the app’s tool. Corrected input is a new call. For a read with an uncertain temporary cause, one further attempt may help.",
            ),
          ),
        );
        expect(written.message).toMatch(/ Retryable \(unchanged call\): no\.$/);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
