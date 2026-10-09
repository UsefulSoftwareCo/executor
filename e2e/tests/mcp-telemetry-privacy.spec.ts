/**
 * MCP tool calls deliver their tool name and outcome, never what the caller supplied: arguments,
 * results, form answers, slugs, skill names, tool names, argument keys, or an app error that
 * quotes them. Neither do the errors app management returns about a name the user chose: an app's
 * name, a data operation's name, or a failed build's source. The caller still receives each
 * detailed message; Executor's spans, logs and incident reports record the error's tag and fixed
 * text.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { awaitSentryEvents, traceEvents } from "../support/sentry-events.ts";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";

const private_ = (label: string) => `PRIVATE_${label}_${randomUUID().replaceAll("-", "")}`;
/** Synthetic caller content: program text, a returned value and a form answer. */
const programMarker = private_("PROGRAM");
const resultMarker = private_("RESULT");
const answerMarker = private_("ANSWER");
/** Not a valid app slug, so the skills call is rejected while decoding its arguments. */
const invalidSlugMarker = private_("APP");
/** A valid slug no app has, so the skills handler itself fails. */
const slugMarker = `private-${randomUUID().replaceAll("-", "")}`;
/** A valid skill name and file the app does not have. */
const skillMarker = `private-skill-${randomUUID().replaceAll("-", "")}`;
const fileMarker = `PRIVATE_FILE_${randomUUID().replaceAll("-", "")}.md`;
/** The name, a file and the text of a skill the app publishes. */
const publishedSkillMarker = `private-guide-${randomUUID().replaceAll("-", "")}`;
const publishedFileMarker = `PRIVATE_NOTES_${randomUUID().replaceAll("-", "")}.md`;
const skillTextMarker = private_("SKILL_TEXT");
/** Text a backend tool echoes in the error it throws. */
const crashMarker = private_("CRASH");
/** A tool name no app or MCP server exposes. */
const toolMarker = private_("TOOL");
/** A form field the resume tool does not accept. */
const fieldMarker = private_("FIELD");
/** A key of a record-valued tool input whose value has the wrong type. */
const recordKeyMarker = private_("RECORD_KEY");
/** An app name the user chose, deployed twice. */
const nameMarker = private_("NAME");
/** The name and source of an app whose build fails. */
const buildNameMarker = private_("BUILD_NAME");
const sourceMarker = private_("SOURCE");
/** A data operation name the app does not define, and one it defines that fails. */
const operationMarker = private_("OPERATION");
const failingOperation = `private_op_${randomUUID().replaceAll("-", "")}`;
const markers = [
  programMarker,
  resultMarker,
  answerMarker,
  invalidSlugMarker,
  slugMarker,
  skillMarker,
  fileMarker,
  publishedSkillMarker,
  publishedFileMarker,
  skillTextMarker,
  crashMarker,
  toolMarker,
  fieldMarker,
  recordKeyMarker,
  nameMarker,
  buildNameMarker,
  sourceMarker,
  operationMarker,
  failingOperation,
];

/**
 * An app whose tool throws the caller's text, as app code often does; a tool whose input is a
 * record, so its validation errors name the caller's keys; an operation whose name is the
 * app's own, which fails; and a skill whose name, files and text are the app's own.
 */
const crashing = [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, record, string, router } from "apps";
export const ${failingOperation} = query({ input: object({}) }, async () => {
  throw new Error("The operation failed");
});
export default defineApp({ accounts: {} }, {
  tools: router({
    crash: query({ input: object({ text: string() }) }, async (_ctx, input) => {
      throw new Error(input.text);
    }),
    keyed: query({ input: record(string()) }, async () => "unreachable"),
    ${failingOperation},
  }),
});`,
  },
  {
    path: `skills/${publishedSkillMarker}/SKILL.md`,
    content: `---\nname: ${publishedSkillMarker}\ndescription: ${skillTextMarker}\n---\n# ${skillTextMarker}\n`,
  },
  {
    path: `skills/${publishedSkillMarker}/${publishedFileMarker}`,
    content: `${skillTextMarker}\n`,
  },
  appsManifest,
];

/** An app whose source does not compile; the compiler's error quotes the line. */
const broken = [{ path: "index.ts", content: `export default 1 ${sourceMarker};\n` }, appsManifest];

const RpcReply = Schema.Struct({
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  result: Schema.optional(Schema.Unknown),
});

type Delivered = typeof SpanQuery.Type;
/** Where a marker appears in a delivered trace, by span name and field; never the value. */
const located = (trace: Delivered, marker: string) => {
  const found = trace.data.flatMap(({ span }) => [
    ...(span.operationName.includes(marker) ? ["span name"] : []),
    ...Object.entries(span.tags)
      .filter(([key, value]) => key.includes(marker) || value.includes(marker))
      .map(([key]) => `${span.operationName} ${key.includes(marker) ? "attribute key" : key}`),
    ...span.events.flatMap((event) =>
      Object.entries(event.attributes)
        .filter(([key, value]) => key.includes(marker) || value.includes(marker))
        .map(([key]) => `${span.operationName} ${event.name} ${key}`),
    ),
    ...(span.statusMessage?.includes(marker) ? [`${span.operationName} status message`] : []),
  ]);
  return found.length === 0 && JSON.stringify(trace).includes(marker) ? ["elsewhere"] : found;
};

const toolCall = (operation: string) =>
  operation.startsWith("McpServer.") && operation.endsWith("/tools/call");

layer(HostedLive, { excludeTestServices: true })("MCP telemetry privacy", (it) => {
  it.effect(scenarios.mcpTelemetryPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target,
          http = yield* HttpClient.HttpClient,
          fs = yield* FileSystem.FileSystem;
        const key = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Telemetry privacy fixture",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Telemetry privacy ${randomUUID().slice(0, 8)}`,
          files: crashing,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const client = yield* (yield* McpClient).connect(
          Redacted.make(Redacted.value(key.key)),
          "telemetry-privacy",
          { organization: actors.organization.id },
        );
        // The client's standalone GET stream can open after a call, so take the last POST.
        const latestTrace = evidence.requests.pipe(
          Effect.map((requests) => {
            const id = requests.findLast(({ method }) => method === "POST")?.traceId;
            if (id === undefined) throw new Error("The request trace was not recorded");
            return id;
          }),
        );

        /** Each path's trace and every place its delivered telemetry holds a marker. */
        const leaks: Record<string, ReadonlyArray<string>> = {};
        const traces: Record<string, string> = {};
        /** Wait until the trace holds every named span, then record where markers appear. */
        const delivered = (path: string, trace: string, spans: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const found = yield* telemetry.query(trace).pipe(
              Effect.flatMap((result) => {
                const names = result.data.map(({ span }) => span.operationName);
                const missing = spans.filter((name) =>
                  name === "tools/call" ? !names.some(toolCall) : !names.includes(name),
                );
                return missing.length === 0
                  ? Effect.succeed(result)
                  : Effect.fail(new Error(`${path}: missing delivered ${missing.join(", ")}`));
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
            );
            yield* evidence.json(`${path}-trace.json`, found);
            traces[path] = trace;
            // The trace's own log records, and any record whose body holds a marker's prefix. An
            // unreadable collector fails the scenario: absence is only evidence when it was read.
            const logs = yield* telemetry
              .logs(trace, "PRIVATE_")
              .pipe(Effect.map((records) => records.join("\n")));
            const rpc = found.data.find(({ span }) => toolCall(span.operationName))?.span;
            leaks[path] = [
              ...(rpc?.tags.parameters === undefined ? [] : ["tools/call parameters"]),
              ...markers.flatMap((marker) => [
                ...located(found, marker),
                ...(logs.includes(marker) ? ["logs"] : []),
              ]),
            ];
            return found;
          });
        /** The delivered tools/call span of a trace. */
        const rpcSpan = (trace: Delivered) =>
          trace.data.find(({ span }) => toolCall(span.operationName))?.span;

        /** One JSON-RPC message over raw Streamable HTTP, in its own trace. */
        const raw = (message: object, headers: Readonly<Record<string, string>> = {}) =>
          Effect.gen(function* () {
            const trace = randomBytes(16).toString("hex");
            const response = yield* http
              .execute(
                HttpClientRequest.post(new URL("/mcp", target.metadata.origin), {
                  headers: {
                    authorization: `Bearer ${Redacted.value(key.key)}`,
                    "x-executor-organization": actors.organization.id,
                    accept: "application/json, text/event-stream",
                    traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01`,
                    ...headers,
                  },
                }).pipe(HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message })),
              )
              .pipe(Effect.timeout("30 seconds"));
            const text = yield* response.text;
            // A streamed reply ends with the request's response after any notifications.
            const data = response.headers["content-type"]?.startsWith("text/event-stream")
              ? text
                  .split("\n")
                  .filter((line) => line.startsWith("data: ") && line.length > 6)
                  .map((line) => line.slice(6))
                  .at(-1)
              : text;
            const reply =
              data === undefined || data === ""
                ? undefined
                : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RpcReply))(data);
            return { trace, session: response.headers["mcp-session-id"], reply };
          }).pipe(Effect.scoped, Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        /** A session on one revision, as an older client opens it. */
        const session = (protocolVersion: string) =>
          Effect.gen(function* () {
            const opened = yield* raw({
              id: 1,
              method: "initialize",
              params: {
                protocolVersion,
                capabilities: {},
                clientInfo: { name: `executor-e2e-${protocolVersion}`, version: "1" },
              },
            });
            const id = opened.session;
            if (id === undefined) return yield* Effect.die(`${protocolVersion}: no session`);
            const headers = { "mcp-session-id": id, "mcp-protocol-version": protocolVersion };
            yield* raw({ method: "notifications/initialized" }, headers);
            return (message: object) => raw({ id: 2, ...message }, headers);
          });

        yield* evidence.step(
          "Execute, resume and a rejected skills call record no arguments",
          Effect.gen(function* () {
            const executed = yield* client.use(
              "execute a program with private content",
              (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `// ${programMarker}\nreturn ${JSON.stringify(resultMarker)};`,
                    },
                  },
                  undefined,
                  { signal },
                ),
            );
            // The marker reaches the caller, so its absence from telemetry is not an empty result.
            expect(JSON.stringify(executed.structuredContent)).toContain(resultMarker);
            const execute = rpcSpan(
              yield* delivered("execute", yield* latestTrace, ["tools/call", "mcp.execute"]),
            );
            expect(execute?.tags.tool, "execute: tools/call names its tool").toBe("execute");
            expect(execute?.status).toBe("ok");

            const resumed = yield* client.use(
              "resume with a private form answer",
              (client, signal) =>
                client.callTool(
                  {
                    name: "resume",
                    arguments: {
                      requestId: `elc_${randomUUID()}`,
                      response: { action: "accept", content: { name: answerMarker } },
                    },
                  },
                  undefined,
                  { signal },
                ),
            );
            expect(resumed.structuredContent).toMatchObject({ status: "unavailable" });
            const resume = rpcSpan(
              yield* delivered("resume", yield* latestTrace, ["tools/call", "mcp.resume"]),
            );
            expect(resume?.tags.tool).toBe("resume");

            const rejected = yield* client.use(
              "read a skill with an invalid private slug",
              (client, signal) =>
                client.callTool(
                  { name: "skills", arguments: { app: invalidSlugMarker } },
                  undefined,
                  { signal },
                ),
            );
            expect(rejected).toMatchObject({ isError: true });
            expect(JSON.stringify(rejected.content)).toContain(
              "Invalid parameters for tool 'skills'",
            );
            const skills = rpcSpan(
              yield* delivered("skills-invalid", yield* latestTrace, ["tools/call"]),
            );
            expect(skills?.tags.tool).toBe("skills");
          }),
        );

        yield* evidence.step(
          "A backend tool's error quoting the caller's input reaches only the caller",
          Effect.gen(function* () {
            const tool = `tools[${JSON.stringify(app.slug)}]`;
            const crashed = yield* client.use(
              "call a tool that throws its input",
              (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `return await ${tool}.crash({ text: ${JSON.stringify(crashMarker)} });`,
                    },
                  },
                  undefined,
                  { signal },
                ),
            );
            expect(JSON.stringify(crashed.structuredContent)).toContain(crashMarker);
            yield* delivered("app-error", yield* latestTrace, [
              "tools/call",
              "mcp.tool.call",
              "sdk.tools.call",
              "app.call",
            ]);

            const missing = yield* client.use("call a tool the app lacks", (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await ${tool}[${JSON.stringify(toolMarker)}]({});`,
                  },
                },
                undefined,
                { signal },
              ),
            );
            expect(JSON.stringify(missing.structuredContent)).toContain(toolMarker);
            yield* delivered("app-tool-missing", yield* latestTrace, ["tools/call", "mcp.execute"]);

            const keyed = yield* client.use(
              "call a record-valued tool with an invalid private key",
              (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `return await ${tool}.keyed({ [${JSON.stringify(recordKeyMarker)}]: 7 });`,
                    },
                  },
                  undefined,
                  { signal },
                ),
            );
            // The caller receives the failing key with the error's code.
            const keyedReply = JSON.stringify(keyed.structuredContent);
            expect(keyedReply).toContain("InputInvalid");
            expect(keyedReply).toContain(recordKeyMarker);
            yield* delivered("record-key-invalid", yield* latestTrace, [
              "tools/call",
              "mcp.tool.call",
              "sdk.tools.call",
            ]);
          }),
        );

        yield* evidence.step(
          "Skills calls for a missing app or skill name them only to the caller",
          Effect.gen(function* () {
            const missing = yield* client.use(
              "read the skills of a missing app",
              (client, signal) =>
                client.callTool({ name: "skills", arguments: { app: slugMarker } }, undefined, {
                  signal,
                }),
            );
            expect(missing).toMatchObject({ isError: true });
            expect(JSON.stringify(missing.content)).toContain(
              `No visible app has the slug ${slugMarker}`,
            );
            yield* delivered("skills-missing", yield* latestTrace, ["tools/call", "mcp.skills"]);

            const skill = yield* client.use("read a skill the app lacks", (client, signal) =>
              client.callTool(
                {
                  name: "skills",
                  arguments: { app: app.slug, name: skillMarker, file: fileMarker },
                },
                undefined,
                { signal },
              ),
            );
            // The caller receives the failure's code; the SDK error's message names the skill.
            expect(skill).toMatchObject({ isError: true });
            expect(JSON.stringify(skill.content)).toContain("AppSkillNotFound");
            yield* delivered("skill-missing", yield* latestTrace, [
              "tools/call",
              "mcp.skills",
              "sdk.skills.read",
            ]);
          }),
        );

        yield* evidence.step(
          "A skill read records that an app's skill was read, never its name, file or text",
          Effect.gen(function* () {
            const read = yield* client.use("read a skill the app publishes", (client, signal) =>
              client.callTool(
                {
                  name: "skills",
                  arguments: {
                    app: app.slug,
                    name: publishedSkillMarker,
                    file: publishedFileMarker,
                  },
                },
                undefined,
                { signal },
              ),
            );
            expect(read.isError).not.toBe(true);
            expect(JSON.stringify(read.structuredContent)).toContain(skillTextMarker);
            const trace = yield* delivered("skill-read", yield* latestTrace, [
              "tools/call",
              "mcp.skills",
              "sdk.skills.read",
            ]);
            const skills = trace.data.find(({ span }) => span.operationName === "mcp.skills")?.span;
            expect(skills?.tags).toMatchObject({
              "executor.skill.operation": "read",
              "executor.skill.source": "customer",
            });
          }),
        );

        yield* evidence.step(
          "App names, operation names and build source reach only the caller",
          Effect.gen(function* () {
            const named = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: nameMarker,
              files: crashing,
            });
            expect(named.status, JSON.stringify(named.body)).toBe(200);
            const first = yield* body(App, named);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${first.id}`).pipe(Effect.orDie),
            );
            const taken = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: nameMarker,
              files: crashing,
            });
            expect(taken.status, JSON.stringify(taken.body)).toBe(409);
            expect(JSON.stringify(taken.body)).toContain("AppNameTaken");
            yield* delivered("app-name-taken", yield* latestTrace, ["sdk.apps.deploy"]);

            const build = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: buildNameMarker,
              files: broken,
            });
            expect(build.status, JSON.stringify(build.body)).toBe(422);
            const buildReply = JSON.stringify(build.body);
            expect(buildReply).toContain("DeploymentBuildFailed");
            expect(buildReply).toContain(sourceMarker);
            yield* delivered("build-failed", yield* latestTrace, ["sdk.apps.deploy"]);

            const data = `${prefix}/${app.id}/data/query`;
            const unknown = yield* api.request(actors.owner, "POST", data, {
              name: operationMarker,
              input: {},
            });
            // The hosted data route answers this error with HTTP 500, whatever its declared status.
            expect(JSON.stringify(unknown.body)).toContain("AppDataNotFound");
            expect(JSON.stringify(unknown.body)).toContain(operationMarker);
            yield* delivered("data-operation-missing", yield* latestTrace, ["sdk.data.query"]);

            const failing = yield* api.request(actors.owner, "POST", data, {
              name: failingOperation,
              input: {},
            });
            // The hosted data route answers this error with HTTP 500, whatever its declared status.
            expect(JSON.stringify(failing.body)).toContain("AppDataFailed");
            expect(JSON.stringify(failing.body)).toContain(failingOperation);
            yield* delivered("data-operation-failed", yield* latestTrace, ["sdk.data.query"]);
          }),
        );

        for (const protocolVersion of ["2025-11-25", "2025-06-18", "2025-03-26"])
          yield* evidence.step(
            `On ${protocolVersion}, an unknown tool name and a resume answer's keys reach only the caller`,
            Effect.gen(function* () {
              const call = yield* session(protocolVersion);
              const unknown = yield* call({
                method: "tools/call",
                params: { name: toolMarker, arguments: {} },
              });
              expect(unknown.reply?.error?.message).toBe(`Tool '${toolMarker}' not found`);
              const refused = rpcSpan(
                yield* delivered(`unknown-tool-${protocolVersion}`, unknown.trace, ["tools/call"]),
              );
              expect(refused?.status).toBe("error");

              const malformed = yield* call({
                method: "tools/call",
                params: {
                  name: "resume",
                  arguments: {
                    requestId: `elc_${randomUUID()}`,
                    response: { action: "accept", content: { [fieldMarker]: {} } },
                  },
                },
              });
              // The newest revisions answer a tool's invalid arguments as a tool error result.
              expect(JSON.stringify(malformed.reply?.error ?? malformed.reply?.result)).toContain(
                fieldMarker,
              );
              yield* delivered(`invalid-resume-${protocolVersion}`, malformed.trace, [
                "tools/call",
              ]);
            }),
          );

        // Managed Cloud reports incidents to its loopback Sentry collector. Read what it holds once each
        // unknown tool's refusal has arrived, so an unread or empty collector fails the check.
        const reported = Object.entries(traces)
          .filter(([path]) => path.startsWith("unknown-tool-"))
          .map(([, trace]) => trace);
        expect(reported).toHaveLength(3);
        const incidents =
          target.metadata.target === "cloud" && target.metadata.mode === "managed"
            ? yield* awaitSentryEvents((events) =>
                reported.every((trace) => traceEvents(events, trace).length > 0),
              ).pipe(Effect.flatMap(() => fs.readFileString(`${target.directory}/sentry.ndjson`)))
            : "";
        yield* evidence.json("leaks.json", { leaks, traces });
        // Every path in one comparison, so a failure names each path and where it leaked.
        expect(leaks).toEqual(Object.fromEntries(Object.keys(leaks).map((path) => [path, []])));
        expect(
          markers.filter((marker) => incidents.includes(marker)),
          "incident reports hold no caller text",
        ).toEqual([]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
