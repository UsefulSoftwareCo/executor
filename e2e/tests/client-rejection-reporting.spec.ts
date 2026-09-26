/** Client request rejections are recorded on their request span and stay out of incident reporting. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { awaitSentryEvents, traceExceptionTypes } from "../support/sentry-events.ts";
import { staleOpenapiUpstream } from "../support/stale-openapi-upstream.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const kindTag = "executor.request.rejection.kind",
  issuesTag = "executor.request.rejection.issues";
/** Values sent in rejected requests. None may appear in telemetry. */
const privateValues = ["a".repeat(40), "service-requirement", "many-items", "unscoped-name"];

interface Rejection {
  readonly label: string;
  readonly trace: string;
  readonly status: number;
  /** The span attributes the rejected Executor request must carry; undefined for declared errors. */
  readonly expected?: { readonly kind: string; readonly issue: string };
}

layer(HostedLive, { excludeTestServices: true })("Client rejection reporting", (it) => {
  it.effect(scenarios.clientRejectionReporting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        const cloud = target.metadata.target === "cloud";
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Rejections ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, mutation, object, number } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  queries: { strict: query({ input: object({ count: number() }) }, async (_context, input) => input) },
  mutations: { crash: mutation({ input: object({}) }, async () => { throw new Error("private-fixture-message"); }) },
}));`,
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const latestTrace = evidence.requests.pipe(
          Effect.map((requests) => {
            const id = requests.at(-1)?.traceId;
            if (id === undefined) throw new Error("The request trace was not recorded");
            return id;
          }),
        );
        const rejections: Array<Rejection> = [];
        // Callers holding a previous contract send shapes the server now rejects.
        for (const [label, method, path, payload, status, expected] of [
          [
            "deploy payload from before deployments were separated from Git writes",
            "POST",
            `${prefix}/apps/${app.id}/deploy`,
            { expectedSource: "a".repeat(40), expectedDeployment: null },
            400,
            { kind: "Payload", issue: "$.files: MissingKey" },
          ],
          [
            "connection payload from before selections moved into profiles",
            "POST",
            `${prefix}/apps/${app.id}/connections`,
            { requirement: "service-requirement" },
            400,
            { kind: "Payload", issue: "$.profile: MissingKey" },
          ],
          [
            "path parameter that is not an app ID",
            "GET",
            `${prefix}/apps/not-an-app`,
            undefined,
            400,
            { kind: "Params", issue: "$.app: Filter" },
          ],
          // A declared tool input rejection is already typed; it has no schema rejection to record.
          [
            "tool input that does not match the declared input schema",
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "queries.strict", input: { count: "many-items" } },
            422,
            undefined,
          ],
          // Cloud serves the public registry.
          ...(cloud
            ? ([
                [
                  "registry query value that does not satisfy the published pattern",
                  "GET",
                  "/api/registry/apps?name=unscoped-name",
                  undefined,
                  400,
                  { kind: "Query", issue: "$.name: Filter" },
                ],
              ] as const)
            : []),
        ] as const) {
          const response = yield* api.request(actors.owner, method, path, payload);
          expect(response.status, label).toBe(status);
          rejections.push({
            label,
            trace: yield* latestTrace,
            status: response.status,
            ...(expected === undefined ? {} : { expected }),
          });
        }
        // The first-party failure behind these reports: an OpenAPI app built from an older
        // contract calls Executor, which rejects the request inside the tool call's trace.
        const stale = cloud
          ? yield* Effect.gen(function* () {
              const upstream = yield* staleOpenapiUpstream;
              const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
                source: {
                  kind: "openapi",
                  name: `Stale registry ${randomUUID().slice(0, 8)}`,
                  url: `${upstream}/openapi.json`,
                  baseUrl: target.metadata.origin,
                },
              });
              expect(imported.status, JSON.stringify(imported.body)).toBe(200);
              const staleApp = yield* body(App, imported);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/apps/${staleApp.id}`)
                  .pipe(Effect.orDie),
              );
              const rest = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/apps/${staleApp.id}/tools/call`,
                { tool: "queries.listApps", input: { query: { name: "unscoped-name" } } },
              );
              expect(rest.status).toBeGreaterThanOrEqual(400);
              const restTrace = yield* latestTrace;
              const issued = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
                name: "Client rejection reporting",
              });
              expect(issued.status).toBe(200);
              const key = yield* body(Token, issued);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                  .pipe(Effect.orDie),
              );
              const client = yield* (yield* McpClient).connect(key.key, "client-rejections", {
                organization,
              });
              const mcp = yield* client.use(
                "Call the stale operation through MCP",
                (client, signal) =>
                  client.callTool(
                    {
                      name: "execute",
                      arguments: {
                        code: `return await tools[${JSON.stringify(staleApp.slug)}].queries.listApps({query:{name:"unscoped-name"}});`,
                      },
                    },
                    undefined,
                    { signal },
                  ),
              );
              const mcpTrace = yield* latestTrace;
              const expected = { kind: "Query", issue: "$.name: Filter" };
              rejections.push(
                {
                  label: "stale OpenAPI app over REST",
                  trace: restTrace,
                  status: rest.status,
                  expected,
                },
                { label: "stale OpenAPI app over MCP", trace: mcpTrace, status: 200, expected },
              );
              return { rest: rest.body, mcp: mcp.structuredContent ?? mcp.content };
            })
          : undefined;
        // A failing app operation is a server-side failure and still reaches reporting.
        const crashed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "mutations.crash", input: {} },
        );
        expect(crashed.status).toBeGreaterThanOrEqual(500);
        const crashTrace = yield* latestTrace;
        // Find the server span of each Executor request that answered 400.
        const spans = yield* Effect.forEach(rejections, (rejection) =>
          rejection.expected === undefined
            ? Effect.succeed(undefined)
            : telemetry.query(rejection.trace).pipe(
                Effect.flatMap((result) => {
                  const span = result.data.find(
                    ({ span }) =>
                      span.operationName.startsWith("http.server") &&
                      span.tags["http.response.status_code"] === "400",
                  );
                  return span === undefined
                    ? Effect.fail(new Error(`No rejected request span for ${rejection.label}`))
                    : Effect.succeed(span.span);
                }),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              ),
        );
        const recorded = rejections.map((rejection, index) => {
          const span = spans[index];
          return {
            label: rejection.label,
            status: rejection.status,
            span:
              span === undefined
                ? null
                : {
                    operation: span.operationName,
                    path: span.tags["url.path"],
                    status: span.tags["http.response.status_code"],
                    errorType: span.tags["error.type"],
                    kind: span.tags[kindTag],
                    issues: span.tags[issuesTag],
                  },
          };
        });
        // The server failure is the barrier for incident exports; every rejected request's span has arrived.
        const events = cloud
          ? yield* awaitSentryEvents((events) =>
              events.some((event) => event.contexts?.trace?.trace_id === crashTrace),
            )
          : [];
        const reported = rejections.map((rejection) =>
          traceExceptionTypes(events, rejection.trace),
        );
        yield* evidence.json("rejections.json", {
          rejections: recorded.map((item, index) => ({
            ...item,
            ...(cloud ? { reported: reported[index] } : {}),
          })),
          ...(stale === undefined ? {} : { stale }),
          ...(cloud ? { crash: traceExceptionTypes(events, crashTrace) } : {}),
        });
        for (const [index, rejection] of rejections.entries()) {
          if (rejection.expected === undefined) continue;
          const span = recorded[index]?.span;
          expect(span, rejection.label).toMatchObject({
            errorType: "HttpApiSchemaError",
            kind: rejection.expected.kind,
          });
          expect(span?.issues, rejection.label).toContain(rejection.expected.issue);
        }
        const telemetryText = JSON.stringify(recorded);
        for (const value of privateValues) expect(telemetryText).not.toContain(value);
        if (!cloud) return;
        for (const [index, rejection] of rejections.entries()) {
          const types = reported[index] ?? [];
          // The REST tool call reports its public ToolCallFailed today; whether an upstream
          // client rejection is an incident is outside this scenario. Internal errors never are.
          if (rejection.label === "stale OpenAPI app over REST")
            expect(
              types.filter(
                (type) =>
                  type.startsWith("Host") ||
                  type === "SchemaError" ||
                  type === "HttpApiSchemaError",
              ),
              rejection.label,
            ).toEqual([]);
          else expect(types, rejection.label).toEqual([]);
        }
        // The public failure is reported once; internal host protocol errors never are.
        expect(traceExceptionTypes(events, crashTrace)).toEqual(["ToolCallFailed"]);
        expect(JSON.stringify(events)).not.toContain("private-fixture-message");
        for (const value of privateValues) expect(JSON.stringify(events)).not.toContain(value);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localRejectionRecording.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        const anonymous = yield* api.session();
        const trace = randomBytes(16).toString("hex");
        // The deploy payload before deployments were separated from Git writes. Local API
        // keys are not browser-origin requests, so this bypasses the origin-bearing client.
        const response = yield* anonymous.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", expectedSource: "a".repeat(40), expectedDeployment: null },
          {
            authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01`,
          },
        );
        expect(response.status).toBe(400);
        const span = yield* telemetry.query(trace).pipe(
          Effect.flatMap((result) => {
            const span = result.data.find(
              ({ span }) =>
                span.operationName.startsWith("http.server") &&
                span.tags["http.response.status_code"] === "400",
            );
            return span === undefined
              ? Effect.fail(new Error("No rejected request span"))
              : Effect.succeed(span.span);
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        const recorded = {
          operation: span.operationName,
          errorType: span.tags["error.type"],
          kind: span.tags[kindTag],
          issues: span.tags[issuesTag],
        };
        yield* evidence.json("rejection-span.json", recorded);
        expect(recorded).toMatchObject({ errorType: "HttpApiSchemaError", kind: "Payload" });
        expect(recorded.issues).toContain("MissingKey");
        expect(JSON.stringify(recorded)).not.toContain("a".repeat(40));
      }),
    ),
  );
});
