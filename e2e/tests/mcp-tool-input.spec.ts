/**
 * A running tool of an account-free app asks for input through `ctx.elicit`. The call has no
 * profile, so its pending interaction names only the app and tool. Model mode returns it to the
 * agent and browser mode adds a review link; each answer resumes the same program and invocation.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

const message = "What should this result be called?";
/** An account-free app whose tools ask the user to name their result while they run. */
const appFiles = [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
const ask = async ({ elicit }) => {
  const response = await elicit({
    mode: "form",
    message: ${JSON.stringify(message)},
    requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  });
  return response.action === "accept" ? { action: "accept", name: response.content?.name } : { action: response.action };
};
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    name: mutation({ description: "Ask the user to name the result", input: object({}) }, ask),
    approvedName: mutation({ description: "Ask for a name after approval", input: object({}), approval: always() }, ask),
  }),
}));
`,
  },
  appsManifest,
];

const ApprovalRequired = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  invocation: Schema.Record(Schema.String, Schema.Unknown),
});
const InputRequired = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: Schema.String,
  tool: Schema.Unknown,
  elicitation: Schema.Struct({ mode: Schema.Literal("form"), message: Schema.String }),
});
const BrowserInputRequired = Schema.Struct({ ...InputRequired.fields, approvalUrl: Schema.String });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Unknown,
});
const ReviewView = Schema.Struct({
  status: Schema.Literal("pending"),
  request: Schema.Struct({ status: Schema.Literal("input-required"), tool: Schema.Unknown }),
});
type Connection = Effect.Success<ReturnType<McpClient["Service"]["connect"]>>;

/** One MCP tool call. A result the server could not encode fails here with the server's message. */
const call = (
  client: Connection,
  step: string,
  name: "execute" | "resume",
  args: Record<string, unknown>,
) =>
  client
    .use(step, (client, signal) =>
      client.callTool({ name, arguments: args }, undefined, { signal }),
    )
    .pipe(
      Effect.tap((result) =>
        Effect.sync(() => expect(result.isError, JSON.stringify(result.content)).not.toBe(true)),
      ),
      Effect.map((result) => result.structuredContent),
    );

/** The program keeps its own local value across the pause, so it continued rather than restarted. */
const program = (slug: string, tool = "name") =>
  `const before = "kept";
const named = await tools[${JSON.stringify(slug)}].${tool}({});
return { before, named };`;
const answered = (name: string) => ({
  ok: true,
  value: { before: "kept", named: { action: "accept", name } },
  toolCalls: [expect.objectContaining({ outcome: "success" })],
});
/** Answer an input request through resume and expect the program to finish with that answer. */
const answer = (client: Connection, step: string, requestId: string, name: string) =>
  call(client, step, "resume", {
    requestId,
    response: { action: "accept", content: { name } },
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Completed)),
    Effect.tap((resumed) =>
      Effect.sync(() => expect(resumed.execution).toMatchObject(answered(name))),
    ),
  );

/** Model mode: the agent receives the question and answers it through resume. */
const modelMode = (client: Connection, app: { id: string; slug: string }) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const pending = yield* call(client, "Execute until the tool asks for input", "execute", {
      code: program(app.slug),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)));
    yield* evidence.json("model-input-required.json", pending);
    expect(pending.requestId).toMatch(/^elc_/);
    // An account-free call has no profile, so the request names only the app and tool.
    expect(pending.tool).toStrictEqual({ app: app.id, tool: "name" });
    expect(pending.elicitation.message).toBe(message);
    yield* answer(client, "Answer the question through resume", pending.requestId, "Model answer");

    // After an approval, the question comes from the resumed invocation, which also has no profile.
    const approval = yield* call(client, "Execute until the tool needs approval", "execute", {
      code: program(app.slug, "approvedName"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ApprovalRequired)));
    expect(approval.invocation).toMatchObject({ app: app.id, tool: "approvedName" });
    expect(Object.keys(approval.invocation)).not.toContain("profile");
    const approved = yield* call(client, "Approve the tool, which then asks for input", "resume", {
      requestId: approval.requestId,
      response: { action: "accept" },
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)));
    yield* evidence.json("approved-input-required.json", approved);
    expect(approved.tool).toStrictEqual({ app: app.id, tool: "approvedName" });
    yield* answer(
      client,
      "Answer the approved tool's question",
      approved.requestId,
      "Approved answer",
    );
  });

/** Browser mode: the user answers on the review page, then the agent collects it through resume. */
const browserMode = (
  client: Connection,
  app: { id: string; slug: string },
  reviewer: Session,
  reviewPath: (requestId: string, url: URL) => string,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      evidence = yield* Evidence;
    const pending = yield* call(
      client,
      "Execute until the tool asks for browser input",
      "execute",
      {
        code: program(app.slug),
      },
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(BrowserInputRequired)));
    yield* evidence.json("browser-input-required.json", pending);
    expect(pending.tool).toStrictEqual({ app: app.id, tool: "name" });
    const review = reviewPath(pending.requestId, new URL(pending.approvalUrl));
    const shown = yield* api.request(reviewer, "GET", review);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect((yield* body(ReviewView, shown)).request.tool).toStrictEqual({
      app: app.id,
      tool: "name",
    });
    const submitted = yield* api.request(reviewer, "POST", review, {
      response: { action: "accept", content: { name: "Browser answer" } },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const resumed = yield* call(client, "Collect the browser answer through resume", "resume", {
      requestId: pending.requestId,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Completed)));
    expect(resumed.execution).toMatchObject(answered("Browser answer"));
  });

layer(HostedLive, { excludeTestServices: true })("Hosted MCP tool input", (it) => {
  it.effect(scenarios.mcpToolInput.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Tool input ${randomUUID().slice(0, 8)}`,
          files: appFiles,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Tool input",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        yield* modelMode(
          yield* mcp.connect(key.key, "tool-input-model", { organization, mode: "model" }),
          app,
        );
        yield* browserMode(
          yield* mcp.connect(key.key, "tool-input-browser", { organization, mode: "browser" }),
          app,
          actors.owner,
          (requestId, url) => `/api/mcp/approvals/${encodeURIComponent(requestId)}${url.search}`,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local MCP tool input", (it) => {
  it.effect(scenarios.localMcpToolInput.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", name: `Tool input ${randomUUID().slice(0, 8)}`, files: appFiles },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        yield* modelMode(
          yield* mcp.connect(target.apiKey, "local-tool-input-model", { mode: "model" }),
          app,
        );
        // The paired dashboard session reviews; the programmatic key never answers in the browser.
        yield* browserMode(
          yield* mcp.connect(target.apiKey, "local-tool-input-browser", { mode: "browser" }),
          app,
          operator,
          (requestId, url) =>
            `/dashboard/api/mcp/approvals/${encodeURIComponent(requestId)}${url.search}`,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
