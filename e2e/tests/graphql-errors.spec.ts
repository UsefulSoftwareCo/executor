/** The errors a GraphQL server states reach the app's caller as that server's words. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Effect, Layer, Ref, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { authoredAppFiles } from "../support/authored-templates.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { expectUnknownOutcome } from "../support/write-outcome.ts";

/**
 * The account's token; the fixture server repeats it in errors, as a careless server can. Its
 * quote and backslash change how it reads once quoted, so its marker must not appear in any form.
 */
const token = 'synthetic-"quoted\\graphql-keymarker';
const tokenMarker = "keymarker";
/** A value the fixture server puts in a nested `extensions` entry, which is never carried. */
const stackMarker = "synthetic-stack-frame";

/** What the fixture server answers to the next tool call or introspection. */
type Mode =
  | "ok"
  | "introspection"
  | "validation"
  | "execution"
  | "echo"
  | "many"
  | "html"
  | "huge"
  | "wide"
  | "stalled";

const fixture = Effect.gen(function* () {
  const mode = yield* Ref.make<Mode>("ok");
  const scalar = (name: string) => ({ kind: "SCALAR", name, ofType: null });
  const required = (type: Schema.Json) => ({ kind: "NON_NULL", name: null, ofType: type });
  const argument = (name: string, type: Schema.Json) => ({
    name,
    type,
    description: null,
    defaultValue: null,
  });
  const type = (kind: string, name: string, extra: Record<string, Schema.Json> = {}) => ({
    kind,
    name,
    fields: null,
    inputFields: null,
    enumValues: null,
    ...extra,
  });
  const field = (name: string, args: readonly Schema.Json[], output: Schema.Json) => ({
    name,
    description: null,
    args,
    type: output,
  });
  const schema = {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        type("OBJECT", "Query", { fields: [field("viewer", [], scalar("String"))] }),
        type("OBJECT", "Mutation", {
          fields: [
            field(
              "projectCreate",
              [
                argument(
                  "input",
                  required({ kind: "INPUT_OBJECT", name: "ProjectCreateInput", ofType: null }),
                ),
              ],
              { kind: "OBJECT", name: "Project", ofType: null },
            ),
          ],
        }),
        type("OBJECT", "Project", {
          fields: [field("id", [], scalar("String")), field("name", [], scalar("String"))],
        }),
        type("INPUT_OBJECT", "ProjectCreateInput", {
          inputFields: [
            argument("name", required(scalar("String"))),
            argument("description", scalar("String")),
          ],
        }),
        type("SCALAR", "String"),
      ],
    },
  };
  const routes = HttpRouter.add(
    "POST",
    "/graphql",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const message = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ query: Schema.String }))),
      );
      const current = yield* Ref.get(mode);
      if (message.query.includes("__schema"))
        return current === "introspection"
          ? yield* HttpServerResponse.json({
              errors: [
                {
                  message: "Introspection is disabled for this API key",
                  extensions: { code: "INTROSPECTION_DISABLED" },
                },
              ],
            })
          : yield* HttpServerResponse.json({ data: schema });
      const presented = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      switch (current) {
        // A request the server refuses before running it, answered with a client error status.
        case "validation":
          return yield* HttpServerResponse.json(
            {
              errors: [
                {
                  message: "Argument Validation Error",
                  locations: [{ line: 1, column: 12 }],
                  path: ["projectCreate"],
                  extensions: {
                    code: "INVALID_INPUT",
                    type: "invalid input",
                    userPresentableMessage:
                      "description must be shorter than or equal to 255 characters",
                    exception: { stacktrace: [stackMarker] },
                  },
                },
              ],
            },
            { status: 400 },
          );
        // A field error while running the operation, as a GraphQL response with data.
        case "execution":
          return yield* HttpServerResponse.json({
            data: null,
            errors: [
              {
                message: `A project with this name already exists for key ${presented}`,
                path: ["projectCreate", "input", "name"],
                extensions: { code: "CONFLICT", retryable: false },
              },
              // A server's claim about the outcome, which Executor cannot check.
              { message: "Nothing was changed. Retry this request.", extensions: { code: "SAFE" } },
            ],
          });
        // The token in every field a failure quotes: the message, a path segment and an extension.
        case "echo":
          return yield* HttpServerResponse.json(
            {
              errors: [
                {
                  message: `Refused for key ${presented}`,
                  path: ["projectCreate", presented],
                  extensions: { code: "DENIED", key: presented },
                },
              ],
            },
            { status: 400 },
          );
        case "many":
          return yield* HttpServerResponse.json({
            data: null,
            errors: [
              { message: `Long ${"x".repeat(5_000)}`, path: ["projectCreate", 0] },
              ...Array.from({ length: 6 }, (_, index) => ({
                message: `Error ${index + 2}`,
                path: ["projectCreate", "items", index, "label-text"],
              })),
            ],
          });
        // A proxy's error page, which states no GraphQL errors.
        case "html":
          return HttpServerResponse.text("<html><body>Bad Request</body></html>", {
            status: 400,
            contentType: "text/html",
          });
        // A 24 MiB error message, sent in chunks without a declared length.
        case "huge": {
          const chunk = "x".repeat(1_048_576);
          return HttpServerResponse.stream(
            Stream.fromIterable([
              '{"errors":[{"message":"',
              ...Array.from({ length: 24 }, () => chunk),
              '"}]}',
            ]).pipe(Stream.encodeText),
            { status: 400, contentType: "application/json" },
          );
        }
        case "wide":
          return yield* HttpServerResponse.json(
            {
              errors: Array.from({ length: 30_000 }, (_, index) => ({ message: `Error ${index}` })),
            },
            { status: 400 },
          );
        // The status and the start of a body that never finishes.
        case "stalled":
          return HttpServerResponse.stream(
            Stream.concat(Stream.make(new TextEncoder().encode('{"errors":[')), Stream.never),
            { status: 400, contentType: "application/json" },
          );
        default:
          return yield* HttpServerResponse.json({
            data: { projectCreate: { id: "project-1", name: "Synthetic" } },
          });
      }
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    answer: (next: Mode) => Ref.set(mode, next),
  };
});

const ServiceFailure = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.String,
  failure: Schema.Struct({
    source: Schema.Literal("service"),
    errorName: Schema.Literal("GraphqlError"),
    code: Schema.String,
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
        phase: Schema.Literal("call"),
        reference: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
      }),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("GraphQL errors", (it) => {
  it.effect(scenarios.graphqlStatedErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const upstream = yield* fixture;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `GraphQL errors ${randomUUID().slice(0, 8)}`,
          files: authoredAppFiles("graphql", upstream.origin, "apiKey", "GraphQL errors"),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        const apps = [path];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const deployedPath of apps)
              yield* api.request(actors.owner, "DELETE", deployedPath);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "apiKey", label: "work", fields: { token } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        accounts.push(account);

        // Reading the schema: the server's refusal is named, not only its status.
        yield* upstream.answer("introspection");
        const listing = yield* api.request(actors.owner, "GET", `${path}/tools`);
        yield* evidence.json("graphql-discovery-failure.json", listing.body);
        expect(listing.status, JSON.stringify(listing.body)).toBe(502);
        expect(yield* body(ServiceFailure, listing)).toMatchObject({
          _tag: "AppEvaluationFailed",
          failure: {
            code: "execution",
            message:
              'The GraphQL server answered HTTP 200 with errors while Executor read its schema. It stated: "Introspection is disabled for this API key" (code: "INTROSPECTION_DISABLED").',
          },
        });
        yield* upstream.answer("ok");
        const listed = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);

        const input = (description: string) => ({
          accountId: account,
          input: { arguments: { input: { name: "Synthetic", description } } },
        });
        const call = (mode: Mode) =>
          Effect.gen(function* () {
            yield* upstream.answer(mode);
            const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "mutation_projectCreate",
              kind: "mutation",
              input: input("d".repeat(300)),
            });
            yield* evidence.json(`graphql-${mode}-failure.json`, response.body);
            expect(response.status, JSON.stringify(response.body)).toBe(502);
            const failure = yield* body(ServiceFailure, response);
            expect(failure._tag).toBe("ToolCallFailed");
            expect(failure.reason).toBe(`The app's API call failed: ${failure.failure.message}`);
            expect(JSON.stringify(response.body)).not.toContain(token);
            expect(JSON.stringify(response.body)).not.toContain(tokenMarker);
            // The server's words never decide whether the mutation may be repeated.
            const presented = yield* body(
              Schema.Struct({
                recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
              }),
              response,
            );
            expectUnknownOutcome(presented.recovery);
            return failure.failure;
          });

        // A validation error, answered with HTTP 400: the server's message, path and scalar
        // extensions, such as the limit it states, reach the caller; nested values do not.
        const refused = yield* call("validation");
        expect(refused).toEqual({
          source: "service",
          errorName: "GraphqlError",
          code: "request",
          message:
            'The GraphQL server answered HTTP 400 to this tool call. It stated: "Argument Validation Error" at projectCreate (code: "INVALID_INPUT", type: "invalid input", userPresentableMessage: "description must be shorter than or equal to 255 characters").',
        });
        expect(refused.message).not.toContain(stackMarker);

        // A field error during execution, answered with HTTP 200. The account's key, which the
        // server repeated, is replaced.
        expect(yield* call("execution")).toMatchObject({
          code: "execution",
          message:
            'The GraphQL server answered HTTP 200 with errors to this tool call. It stated 2 errors: "A project with this name already exists for key [redacted]" at projectCreate.input.name (code: "CONFLICT", retryable: false); "Nothing was changed. Retry this request." (code: "SAFE").',
        });

        // The token the server repeated is replaced in its message, path and extensions before
        // they are quoted, so its quote and backslash cannot change how it reads.
        expect(yield* call("echo")).toMatchObject({
          code: "request",
          message:
            'The GraphQL server answered HTTP 400 to this tool call. It stated: "Refused for key [redacted]" at projectCreate["[redacted]"] (code: "DENIED", key: "[redacted]").',
        });

        // Many or long errors stay within the message bound and say how many were left out.
        const many = (yield* call("many")).message;
        expect(many.length).toBeLessThanOrEqual(2048);
        expect(many).toMatch(
          /^The GraphQL server answered HTTP 200 with errors to this tool call\. It stated 7 errors: "Long x+…" at projectCreate\[0\]; "Error 2" at projectCreate\.items\[0\]\["label-text"\]; /u,
        );
        expect(many).toContain("2 more errors are not shown.");

        // A body that states no GraphQL errors still names the status, not a missing message.
        expect(yield* call("html")).toMatchObject({
          code: "request",
          message: "The GraphQL server answered HTTP 400 to this tool call.",
        });

        // A refused request's body is read within error-body bounds. One too large or too slow to
        // read is left unread, promptly, and the failure keeps the status the server answered.
        const promptly = (mode: Mode) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const failure = yield* call(mode);
            const elapsed = (yield* Clock.currentTimeMillis) - started;
            yield* evidence.json(`graphql-${mode}-elapsed.json`, { elapsed });
            expect(elapsed).toBeLessThan(10_000);
            return failure;
          });
        const tooLarge =
          "The GraphQL server answered HTTP 400 to this tool call. Executor did not read its response body, which was larger than 64 KiB.";
        const incomplete =
          "The GraphQL server answered HTTP 400 to this tool call. Executor did not read its response body, which did not arrive in time.";
        expect(yield* promptly("huge")).toMatchObject({ code: "request", message: tooLarge });
        expect(yield* promptly("wide")).toMatchObject({ code: "request", message: tooLarge });
        expect(yield* promptly("stalled")).toMatchObject({ code: "request", message: incomplete });

        // An app's own deadline shorter than the body's read keeps the status too.
        const files = authoredAppFiles(
          "graphql",
          upstream.origin,
          "public",
          "GraphQL errors deadline",
        ).map((file) =>
          file.path === "index.ts"
            ? {
                ...file,
                content: file.content.replace(
                  "\n    cache,",
                  "\n    cache,\n    timeoutMs: 1_000,",
                ),
              }
            : file,
        );
        expect(files.find((file) => file.path === "index.ts")?.content).toContain(
          "timeoutMs: 1_000,",
        );
        const short = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `GraphQL errors deadline ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(short.status, JSON.stringify(short.body)).toBe(200);
        const shortPath = `${prefix}/apps/${(yield* body(App, short)).id}`;
        apps.push(shortPath);
        yield* upstream.answer("stalled");
        const started = yield* Clock.currentTimeMillis;
        const deadline = yield* api.request(actors.owner, "POST", `${shortPath}/tools/call`, {
          tool: "mutation_projectCreate",
          kind: "mutation",
          input: { arguments: { input: { name: "Synthetic" } } },
        });
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        yield* evidence.json("graphql-deadline-failure.json", { elapsed, body: deadline.body });
        expect(elapsed).toBeLessThan(10_000);
        expect(deadline.status, JSON.stringify(deadline.body)).toBe(502);
        expect((yield* body(ServiceFailure, deadline)).failure).toMatchObject({
          code: "request",
          message: incomplete,
        });

        // An agent calling the mutation through MCP reads the server's words, under Executor's
        // instruction not to repeat a call that may have changed data.
        yield* upstream.answer("validation");
        const { client } = yield* frameworkSession;
        const executed = yield* client.use("Call the refused mutation", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].mutation_projectCreate(${JSON.stringify(input("d".repeat(300)))});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("mcp-graphql-validation-failure.json", executed.structuredContent);
        const failure = (yield* Schema.decodeUnknownEffect(ExecutionFailed)(
          executed.structuredContent,
        )).execution.error;
        expect(failure.response.code).toBe("ToolCallFailed");
        expect(failure.response.message).toBe(`The app's API call failed: ${refused.message}`);
        expect(failure.response.retryable).toBe(false);
        expectUnknownOutcome(failure.response.recovery);
        expect(failure.response.recovery?.instructions).toContain(
          "They are the server's words, which Executor does not check.",
        );
        expect(failure.message).toContain(
          "description must be shorter than or equal to 255 characters",
        );
        expect(failure.message).not.toContain("thrown without a message");
        expect(failure.message).toBe(
          `ToolCallFailed (HTTP 502): ${failure.response.message} Recovery: ${failure.response.recovery?.action} Retryable (unchanged call): no. Phase: call. Reference: ${failure.response.reference}.`,
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
