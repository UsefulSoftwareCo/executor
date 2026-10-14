/** Imported tools ask before destructive calls through approval rules kept in the app's own source. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { approvalMcpTools, approvalMcpUpstream } from "../support/approval-mcp-upstream.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { scenarios } from "../test-plan.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean }),
});

layer(HostedLive, { excludeTestServices: true })("Imported approvals", (it) => {
  it.effect(scenarios.importApprovals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient,
          upstream = yield* approvalMcpUpstream;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const cleanup: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(cleanup, (path) => api.request(actors.owner, "DELETE", path)).pipe(
            Effect.orDie,
          ),
        );
        const call = (path: string, tool: string, kind: "query" | "mutation") =>
          api.request(actors.owner, "POST", `${path}/tools/call`, { tool, kind, input: {} });

        const imported = yield* evidence.step(
          "Quick add generates the destructive-hint approval rule in editable source",
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
              source: {
                kind: "mcp",
                name: `Approvals ${randomUUID().slice(0, 8)}`,
                url: `${upstream.origin}/mcp`,
              },
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            const path = `${prefix}/apps/${app.id}`;
            cleanup.push(path);
            const source = yield* body(
              Source,
              yield* api.request(actors.owner, "GET", `${path}/source`),
            );
            const index = source.files.find((file) => file.path === "index.ts")?.content;
            expect(index).toContain("withApprovals(await mcpRouter(");
            expect(index).toContain(
              "toolAnnotations(tool)?.destructiveHint === true ? always() : undefined",
            );
            return { app, path };
          }),
        );

        yield* evidence.step(
          "Only tools marked destructive wait for approval, and they never reach the server",
          Effect.gen(function* () {
            for (const [tool, annotations] of Object.entries(approvalMcpTools)) {
              const guarded =
                annotations !== undefined && "destructiveHint" in annotations
                  ? annotations.destructiveHint
                  : false;
              const kind =
                annotations !== undefined && "readOnlyHint" in annotations ? "query" : "mutation";
              const before = yield* upstream.calls;
              const result = yield* call(imported.path, tool, kind);
              if (guarded) {
                expect(result.status, `${tool}: ${JSON.stringify(result.body)}`).toBe(409);
                expect(result.body).toMatchObject({ _tag: "ToolApprovalRequired" });
                expect(yield* upstream.calls, tool).toEqual(before);
              } else {
                expect(result.status, `${tool}: ${JSON.stringify(result.body)}`).toBe(200);
                expect(yield* upstream.calls, tool).toEqual([...before, tool]);
              }
            }
          }),
        );

        yield* evidence.step(
          "An MCP client approves or declines the destructive call before it runs",
          Effect.gen(function* () {
            const token = yield* body(
              Token,
              yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
                name: "Imported approval verification",
              }),
            );
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
                .pipe(Effect.orDie),
            );
            const client = yield* mcp.connect(token.key, "import-approvals", { organization });
            const request = (name: "execute" | "resume", args: Record<string, unknown>) =>
              client.use(`MCP ${name}`, (client, signal) =>
                client.callTool({ name, arguments: args }, undefined, { signal }),
              );
            const code = `return await tools[${JSON.stringify(imported.app.slug)}].erase({});`;
            for (const action of ["accept", "decline"] as const) {
              const before = yield* upstream.calls;
              const pending = yield* Schema.decodeUnknownEffect(Pending)(
                (yield* request("execute", { code })).structuredContent,
              );
              expect(yield* upstream.calls).toEqual(before);
              const resumed = yield* Schema.decodeUnknownEffect(Execution)(
                (yield* request("resume", {
                  requestId: pending.requestId,
                  response: { action },
                })).structuredContent,
              );
              expect(resumed.execution.ok, action).toBe(action === "accept");
              expect(yield* upstream.calls).toEqual(
                action === "accept" ? [...before, "erase"] : before,
              );
            }
          }),
        );

        yield* evidence.step(
          "withApprovals covers nested static tools and keeps a tool's own approval",
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Approval rules ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `
import { defineApp, mutation, object, query, router, withApprovals } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: withApprovals(
    router({
      read: query({ input: object({}) }, async () => "read"),
      own: query({ input: object({}), approval: always() }, async () => "own"),
      nested: router({
        write: mutation({ input: object({}) }, async () => "write"),
        skipped: mutation({ input: object({}) }, async () => "skipped"),
      }),
    }),
    (tool, name) => (tool.kind === "mutation" && name !== "nested.skipped" ? always() : undefined),
  ),
}));`,
                },
                appsManifest,
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const path = `${prefix}/apps/${(yield* body(App, deployed)).id}`;
            cleanup.push(path);
            const expected = [
              ["read", "query", 200],
              ["own", "query", 409],
              ["nested.write", "mutation", 409],
              ["nested.skipped", "mutation", 200],
            ] as const;
            for (const [tool, kind, status] of expected) {
              const result = yield* call(path, tool, kind);
              expect(result.status, `${tool}: ${JSON.stringify(result.body)}`).toBe(status);
            }
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
