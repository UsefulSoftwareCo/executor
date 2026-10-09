/** The paired local operator's scoped connection limits a real OAuth client and revokes it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployLocalMcpApp } from "../support/mcp-app.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import {
  ConnectionView,
  Execution,
  clientGrantId,
  consentTo,
  readWriteAppFiles,
  revokeClientGrants,
} from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { Profile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";

/**
 * MCP clients print a refused request's body after their own prefix, such as "Error POSTing to
 * endpoint:", so the JSON-RPC error names the grant's own reason for the refusal.
 */
const refusal = (message: string) => ({
  jsonrpc: "2.0",
  id: null,
  error: {
    // JSON-RPC Invalid Request, as for the MCP transport's own rejections.
    code: -32600,
    message: `GrantForbidden (HTTP 403): ${message}`,
    data: { code: "GrantForbidden", status: 403 },
  },
});
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
/** A resumed call that failed, with the refusal's one-line summary. */
const Refused = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({ code: Schema.String, status: Schema.Number }),
    }),
  }),
});
/** An account-free app whose `review` waits for the client to approve it. */
const reviewAppFiles = [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    review: mutation({ description: "Review after approval", input: object({}), approval: always() }, async () => ({ reviewed: true })),
  }),
}));
`,
  },
  appsManifest,
];

layer(TestLive, { excludeTestServices: true })("Local scoped MCP connections", (it) => {
  it.effect(scenarios.localScopedConnections.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const receipt = randomUUID();
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Scoped app ${receipt.slice(0, 8)}`,
            files: readWriteAppFiles(receipt),
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const hidden = yield* deployLocalMcpApp;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Read only",
          apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        expect(connection.url).toBe(`${target.metadata.origin}/mcp?connection=${connection.id}`);
        const consent = yield* evidence.step(
          "Authorize the connection's URL as the paired operator",
          consentTo(operator, connection.url),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const client = yield* mcp.connect(token, "local-scoped", {
          connection: connection.id,
        });
        const run = (operation: string, code: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
            );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const [read, write, excluded] = yield* Effect.all(
          [
            run("Call the read tool", `return await ${appPath}.read({})`),
            run("Call the write tool", `return await ${appPath}.write({message: "x"})`),
            run(
              "Call an excluded app",
              `return await tools[${JSON.stringify(hidden.app.slug)}].echo({message: "x"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
        expect(write.execution.ok).toBe(false);
        expect(excluded.execution.ok).toBe(false);
        // The administrative key keeps full access on the plain URL but cannot enter a connection.
        const adminMoved = yield* Effect.exit(
          mcp.connect(Redacted.make(Redacted.value(target.apiKey)), "admin-connection", {
            connection: connection.id,
          }),
        );
        expect(Exit.isFailure(adminMoved)).toBe(true);
        yield* evidence.step(
          "A credential used at another MCP URL names the URL it works at",
          Effect.gen(function* () {
            const anonymous = yield* api.session();
            const admin = yield* api.request(
              anonymous,
              "POST",
              `/mcp?connection=${connection.id}`,
              listTools,
              headers,
            );
            expect(admin.status).toBe(403);
            expect(admin.body).toMatchObject(
              refusal(
                "This credential works only at the MCP URL ending in /mcp, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp, or connect again at this URL to get a credential for it, then retry.",
              ),
            );
            const unscoped = yield* api.request(anonymous, "POST", "/mcp", listTools, {
              authorization: `Bearer ${Redacted.value(token)}`,
            });
            expect(unscoped.status).toBe(403);
            expect(unscoped.body).toMatchObject(
              refusal(
                `This credential works only at the MCP URL ending in /mcp?connection=${connection.id}, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp?connection=${connection.id}, or connect again at this URL to get a credential for it, then retry.`,
              ),
            );
            // A malformed URL names no MCP address, so it is invalid rather than refused.
            const malformed = yield* api.request(
              anonymous,
              "POST",
              "/mcp?elicitation_mode=invalid",
              listTools,
              headers,
            );
            expect(malformed.status).toBe(400);
            expect(malformed.body).toEqual({
              error: "Unsupported elicitation_mode or connection.",
            });
          }),
        );
        yield* evidence.step(
          "Revoking the connection stops its client",
          Effect.gen(function* () {
            const revoked = yield* api.request(
              operator,
              "POST",
              `/dashboard/api/mcp/connections/${connection.id}/revoke`,
            );
            expect(revoked.status).toBe(200);
            const after = yield* Effect.exit(
              run("Call after revocation", `return await ${appPath}.read({})`),
            );
            expect(Exit.isFailure(after)).toBe(true);
            const listed = yield* body(
              Schema.Array(ConnectionView),
              yield* api.request(operator, "GET", "/dashboard/api/mcp/connections"),
            );
            expect(listed).toEqual([]);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpOAuthWithoutResource.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const consent = yield* evidence.step(
          "Authorize a client that sends no resource parameter",
          consentTo(operator, undefined),
        );
        clients.push(consent.clientId);
        // The consent page names the plain MCP URL the grant is bound to.
        expect(consent.consentResources).toEqual([`${target.metadata.origin}/mcp`]);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const client = yield* mcp.connect(token, "local-without-resource");
        const listed = yield* client.use("The plain MCP URL accepts the grant", (client) =>
          client.listTools(),
        );
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "execute",
          "resume",
          "skills",
        ]);
        // The default is the plain URL's model mode only, not every approval mode.
        const other = yield* Effect.exit(
          mcp.connect(token, "local-without-resource-browser-mode", { mode: "browser" }),
        );
        expect(Exit.isFailure(other)).toBe(true);
        const anonymous = yield* api.session();
        const bearer = { authorization: `Bearer ${Redacted.value(token)}` };
        const browserMode = yield* api.request(
          anonymous,
          "POST",
          "/mcp?elicitation_mode=browser",
          listTools,
          bearer,
        );
        expect(browserMode.status).toBe(403);
        expect(browserMode.body).toMatchObject(
          refusal(
            "This credential works only at the MCP URL ending in /mcp, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp, or connect again at this URL to get a credential for it, then retry.",
          ),
        );
        yield* evidence.step(
          "A grant issued at the model-mode URL cannot be narrowed to browser approval",
          Effect.gen(function* () {
            // No URL could serve it: its own URL cannot ask for browser approval.
            const narrowed = yield* api.request(operator, "POST", "/api/auth/mcp/grants/narrow", {
              id: yield* clientGrantId(operator, consent.clientId),
              policy: { kind: "tools", apps: [], approval: "browser" },
            });
            expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(403);
            expect(narrowed.body).toMatchObject({
              message:
                "Browser approval needs a grant issued at an MCP URL with elicitation_mode=browser.",
            });
            const relisted = yield* client.use("The grant still serves its own URL", (client) =>
              client.listTools(),
            );
            expect(relisted.tools.map((tool) => tool.name).sort()).toEqual([
              "execute",
              "resume",
              "skills",
            ]);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpGrantRefusals.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Refused app ${randomUUID().slice(0, 8)}`,
            files: reviewAppFiles,
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const profile = yield* body(
          Profile,
          yield* operator.send(
            "POST",
            `/v1/apps/${app.id}/profiles`,
            { owner: "local", subject: "local", accounts: {}, idempotencyKey: randomUUID() },
            headers,
          ),
        );
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Narrowed",
          apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(operator, "POST", `/dashboard/api/mcp/connections/${connection.id}/revoke`)
            .pipe(Effect.orDie),
        );
        const save = (apps: unknown) =>
          api.request(operator, "PUT", `/dashboard/api/mcp/connections/${connection.id}`, {
            name: "Narrowed",
            apps,
          });
        const consent = yield* consentTo(operator, connection.url);
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const client = yield* mcp.connect(yield* consent.tokens, "local-refusals", {
          connection: connection.id,
        });
        const review = client
          .use("Start a review that waits for approval", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: `return await tools[${JSON.stringify(app.slug)}].review({})` },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Pending)(result.structuredContent),
            ),
          );
        const pending = yield* Effect.all([review, review, review], { concurrency: 3 });
        // Each approval is answered after the connection stops including part of the call.
        const refusedAfter = (requestId: string, apps: unknown) =>
          Effect.gen(function* () {
            const saved = yield* save(apps);
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const resumed = yield* client.use("Approve the review", (client, signal) =>
              client.callTool(
                { name: "resume", arguments: { requestId, response: { action: "accept" } } },
                undefined,
                { signal },
              ),
            );
            const refused = yield* Schema.decodeUnknownEffect(Refused)(resumed.structuredContent);
            expect(refused.execution.error.response).toEqual({
              code: "GrantForbidden",
              status: 403,
            });
            return refused.execution.error.message;
          });
        yield* evidence.step(
          "A read-only connection names the tool it excludes",
          Effect.gen(function* () {
            expect(
              yield* refusedAfter(pending[0].requestId, [
                { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
              ]),
            ).toBe(
              `GrantForbidden (HTTP 403): This credential’s grant does not include the tool “review” of the app ${app.id}. Recovery: Use a tool the grant includes, or add this tool to its connection or grant, then retry.`,
            );
          }),
        );
        yield* evidence.step(
          "A connection that runs the app only as a profile names the target it excludes",
          Effect.gen(function* () {
            expect(
              yield* refusedAfter(pending[1].requestId, [
                {
                  app: app.id,
                  runsAs: [{ kind: "profile", id: profile.id }],
                  tools: { kind: "all" },
                },
              ]),
            ).toBe(
              `GrantForbidden (HTTP 403): This credential’s grant includes the app ${app.id}, but not running it without a profile. Recovery: Run the app as the grant allows, or add this target to its connection, then retry.`,
            );
          }),
        );
        yield* evidence.step(
          "A connection without the app names the app it excludes",
          Effect.gen(function* () {
            expect(yield* refusedAfter(pending[2].requestId, [])).toBe(
              `GrantForbidden (HTTP 403): This credential’s grant does not include the app ${app.id}. Recovery: Use an app the grant includes, or add this app to its connection or grant, then retry.`,
            );
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpResumeAcrossSessions.title, (context) =>
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
          {
            owner: "local",
            name: `Resumed app ${randomUUID().slice(0, 8)}`,
            files: reviewAppFiles,
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const grant = Effect.gen(function* () {
          const consent = yield* consentTo(operator, undefined);
          clients.push(consent.clientId);
          expect(consent.status).toBe(200);
          return yield* consent.tokens;
        });
        const [owner, other] = yield* Effect.all([grant, grant]);
        const paused = yield* (yield* mcp.connect(owner, "local-resume-first")).use(
          "Pause an approval-gated tool in the first MCP session",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: `return await tools[${JSON.stringify(app.slug)}].review({})` },
              },
              undefined,
              { signal },
            ),
        );
        const pending = yield* Schema.decodeUnknownEffect(Pending)(paused.structuredContent);
        // Some clients open a new MCP session for every tool call, so each resume below uses one.
        const resume = (label: string, token: typeof owner, name: string) =>
          Effect.gen(function* () {
            const session = yield* mcp.connect(token, name);
            const result = yield* session.use(label, (client, signal) =>
              client.callTool(
                {
                  name: "resume",
                  arguments: { requestId: pending.requestId, response: { action: "accept" } },
                },
                undefined,
                { signal },
              ),
            );
            return result.structuredContent;
          });
        const Status = Schema.Struct({ status: Schema.String });
        const status = (content: unknown) =>
          Schema.decodeUnknownEffect(Status)(content).pipe(Effect.map(({ status }) => status));
        expect(
          yield* status(yield* resume("Another grant cannot resume", other, "local-resume-other")),
        ).toBe("unavailable");
        expect(
          yield* status(
            yield* resume(
              "The administrative key cannot resume a grant's program",
              Redacted.make(Redacted.value(target.apiKey)),
              "local-resume-admin",
            ),
          ),
        ).toBe("unavailable");
        const resumed = yield* resume(
          "The same grant resumes from a new MCP session",
          owner,
          "local-resume-next",
        );
        expect(yield* status(resumed)).toBe("completed");
        expect((yield* Schema.decodeUnknownEffect(Execution)(resumed)).execution).toEqual({
          ok: true,
          value: { reviewed: true },
        });
        expect(
          yield* status(
            yield* resume(
              "A replayed resume from yet another session is unavailable",
              owner,
              "local-resume-replay",
            ),
          ),
        ).toBe("unavailable");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
