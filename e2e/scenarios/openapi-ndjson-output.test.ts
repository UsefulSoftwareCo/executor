// Cross-target: the advertised output type of an NDJSON streaming operation
// must match what invoking it actually returns.
//
// NDJSON endpoints (Vercel's getRuntimeLogs is the motivating real case) are
// spec'd with a PER-LINE schema under `application/stream+json`: the schema
// describes one log line, the body is many of them. Executor's invoke path
// already understands this: it collects the stream and returns an ARRAY of
// parsed rows. But extraction stores the per-line schema as the operation's
// outputSchema unchanged, so `tools.schema` / `tools.describe.tool()` advertise
// `data: { level; message; ... }` (a single object) while the runtime value is
// `Array<{ level; message; ... }>`.
//
// An agent that trusts the typedef writes broken code; an agent that has been
// burned falls back to Object.keys/JSON.stringify shape-probing, defeating the
// point of shipping type definitions at all. This scenario pins the contract:
// what describe advertises is what invoke returns.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// Three real-shaped runtime-log lines, one JSON document per line, exactly
// what Vercel's runtime-logs endpoint sends over application/stream+json.
const LOG_LINES = [
  { level: "info", message: "build started", rowId: "r1", timestampInMs: 1_700_000_000_000 },
  { level: "warning", message: "slow cold start", rowId: "r2", timestampInMs: 1_700_000_000_100 },
  { level: "error", message: "unhandled rejection", rowId: "r3", timestampInMs: 1_700_000_000_200 },
] as const;

/** A real 127.0.0.1 server answering GET /logs with an NDJSON body. */
const serveNdjsonLogs = Effect.acquireRelease(
  Effect.callback<{ readonly baseUrl: string; readonly close: () => void }>((resume) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/stream+json" });
      response.end(LOG_LINES.map((line) => JSON.stringify(line)).join("\n"));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resume(
        Effect.succeed({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => {
            server.close();
            server.closeAllConnections();
          },
        }),
      );
    });
  }),
  (server) => Effect.sync(server.close),
);

// The response declares the schema of ONE line under application/stream+json,
// the same convention Vercel's spec uses for getRuntimeLogs.
const runtimeLogsSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Runtime Logs API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/logs": {
        get: {
          operationId: "getRuntimeLogs",
          summary: "Stream runtime logs for a deployment",
          responses: {
            "200": {
              description: "Log lines as newline-delimited JSON",
              content: {
                "application/stream+json": {
                  schema: {
                    type: "object",
                    properties: {
                      level: { type: "string", enum: ["info", "warning", "error"] },
                      message: { type: "string" },
                      rowId: { type: "string" },
                      timestampInMs: { type: "number" },
                    },
                    required: ["level", "message", "rowId", "timestampInMs"],
                  },
                },
              },
            },
          },
        },
      },
    },
  });

// No securitySchemes in the spec ⇒ the integration is no-auth, so the agent
// can wire the connection itself over the core tool (template "none").
const createNoAuthConnectionCode = (slug: string) => `
const created = await tools.executor.coreTools.connections.create({
  owner: "org",
  name: "main",
  integration: ${JSON.stringify(slug)},
  template: "none",
});
return created.ok ? { ok: true } : { ok: false, error: created.error };
`;

// Invoke through the sandbox exactly as an agent would, and report the shape
// of what came back next to the shape describe.tool advertised for it.
const invokeAndDescribeCode = (slug: string) => `
const found = await tools.search({ namespace: ${JSON.stringify(slug)}, query: "logs", limit: 5 });
const path = found.items[0]?.path;
if (!path) return { ok: false, error: "tool not found", items: found.items };

const described = await tools.describe.tool({ path });
const outputTypeScript = described?.data?.outputTypeScript ?? described?.outputTypeScript ?? null;

let t = tools;
for (const seg of path.split(".")) t = t[seg];
const result = await t({});
if (!result.ok) return { ok: false, error: result.error };

return {
  ok: true,
  path,
  outputTypeScript,
  runtimeIsArray: Array.isArray(result.data),
  data: result.data,
};
`;

const removeConnectionsCode = (slug: string) => `
const list = await tools.executor.coreTools.connections.list({});
const mine = (list.ok ? list.data.connections : []).filter((c) => c.integration === ${JSON.stringify(slug)});
for (const c of mine) {
  await tools.executor.coreTools.connections.remove({ owner: c.owner, integration: c.integration, name: c.name });
}
return { removed: mine.length };
`;

/** Run `execute`, auto-approving any policy-paused execution, and parse the
 *  sandbox's JSON return value. */
const executeJson = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", { code });
    let guard = 0;
    while (result.text.includes("executionId:") && guard < 10) {
      result = yield* session.approvePaused(result.text);
      guard += 1;
    }
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  });

scenario(
  "OpenAPI · an NDJSON operation's advertised output type matches what invoking it returns",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client } = yield* Api;

      const slug = unique("ndjson");
      const identity = yield* target.newIdentity();
      const session = mcp.session(identity);
      const apiClient = yield* client(api, identity);
      const upstream = yield* serveNdjsonLogs;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const added = yield* apiClient.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: runtimeLogsSpec(upstream.baseUrl) },
              slug,
              baseUrl: upstream.baseUrl,
            },
          });
          expect(added.toolCount, "the NDJSON operation was extracted as a tool").toBe(1);

          const connected = yield* executeJson(session, createNoAuthConnectionCode(slug));
          expect(
            connected.ok,
            `the no-auth connection was created: ${JSON.stringify(connected)}`,
          ).toBe(true);

          // What the agent sees before writing code: the schema view (the same
          // compiled TypeScript previews tools.describe.tool() serves).
          const tools = yield* apiClient.tools.list({
            query: { integration: IntegrationSlug.make(slug) },
          });
          expect(tools.length, "the tool is in the catalog").toBe(1);
          const schema = yield* apiClient.tools.schema({
            query: { address: tools[0]!.address },
          });

          // What the agent gets when it runs that code: the real invocation,
          // through the sandbox, against the live NDJSON upstream.
          const invoked = yield* executeJson(session, invokeAndDescribeCode(slug));
          expect(invoked.ok, `the tool answered over the wire: ${JSON.stringify(invoked)}`).toBe(
            true,
          );

          // The invoke path parses NDJSON into an array of rows. This half of
          // the contract already holds and documents the actual runtime shape.
          expect(invoked.runtimeIsArray, "the runtime value is an array of log lines").toBe(true);
          const rows = invoked.data as ReadonlyArray<Record<string, unknown>>;
          expect(rows.length, "every NDJSON line became a row").toBe(LOG_LINES.length);
          expect(rows[0], "rows are the parsed per-line objects").toMatchObject({
            level: "info",
            message: "build started",
          });

          // THE CONTRACT UNDER TEST: the advertised type must describe that
          // array. Today extraction stores the per-line schema unwrapped, so
          // the typedef claims `data` is a single log-line object, the exact
          // mismatch that pushes agents into JSON.stringify shape-probing.
          const advertised = schema.outputTypeScript ?? "";
          expect(
            /\[\]|Array</.test(advertised),
            `the advertised output type describes an array of lines, not one line.\n` +
              `  advertised: ${advertised}\n` +
              `  runtime:    Array<{ level; message; rowId; timestampInMs }> (${rows.length} rows)`,
          ).toBe(true);

          // And the sandbox's describe.tool must tell the same story: it is
          // the surface agents actually consult before writing code.
          const sandboxAdvertised = String(invoked.outputTypeScript ?? "");
          expect(
            /\[\]|Array</.test(sandboxAdvertised),
            `describe.tool advertises an array of lines, not one line.\n` +
              `  advertised: ${sandboxAdvertised}`,
          ).toBe(true);
        }),
        // Selfhost shares one workspace identity; leaked connections fail
        // other scenarios' zero-state assertions.
        Effect.gen(function* () {
          yield* executeJson(session, removeConnectionsCode(slug)).pipe(Effect.ignore);
          yield* apiClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
