// The agentic no-auth wire-up: an agent registers a public REST API over MCP
// and then creates its connection PROGRAMMATICALLY through the gateway core
// tool, `coreTools.connections.create` with `template: "none"` and no
// credential origin. This is the path that used to be impossible: the core
// tool's arg schema demanded "exactly one provider credential origin", so an
// agent wiring up a public, no-auth integration (public MCP server, public
// REST API) was forced to bounce the user into the web UI via createHandoff,
// even though the engine fully supports a zero-credential connection.
//
// This scenario walks the WHOLE path against a deterministic wire-level
// no-auth API, so the proof is an actual 200 over the wire plus the upstream
// request ledger, without depending on the public npm registry:
//
//   1. MCP `execute` → `openapi.addSpec` registers a tiny no-auth spec
//      (no securitySchemes ⇒ the integration is no-auth)
//   2. MCP `execute` → `coreTools.connections.create` with template "none"
//      and NEITHER `from` NOR `inputs`, the call that used to fail validation
//   3. The operation is now a callable tool: invoke it and read back a 200
//      with the deterministic download count
//   4. Guard the relaxed-but-still-strict contract: a no-auth create that
//      DOES carry an origin (here an empty `inputs: {}`) is still rejected
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

interface DownloadsApi {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<{ readonly method: string; readonly path: string }>;
  readonly server: Server;
}

const serveDownloadsApi = Effect.acquireRelease(
  Effect.callback<DownloadsApi>((resume) => {
    const requests: Array<{ method: string; path: string }> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://executor.test");
      requests.push({ method: request.method ?? "GET", path: url.pathname });
      if (request.method === "GET" && url.pathname === "/downloads/point/last-week/react") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            downloads: 4242,
            start: "2026-06-15",
            end: "2026-06-21",
            package: "react",
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resume(
        Effect.succeed({
          // Suite-owned app targets run on this host, and the production
          // Docker lane uses host networking for loopback test servers.
          baseUrl: `http://127.0.0.1:${port}`,
          requests,
          server,
        }),
      );
    });
  }),
  ({ server }) =>
    Effect.sync(() => {
      server.close();
      server.closeAllConnections?.();
    }),
);

// No `components.securitySchemes` and no top-level `security`, so addSpec
// derives no auth method and the integration is no-auth, exactly the shape a
// connection on `template: "none"` targets.
const downloadsSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Deterministic Downloads API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/downloads/point/{period}/{package}": {
        get: {
          operationId: "getPackageDownloads",
          summary: "Total downloads for a package over a fixed period",
          parameters: [
            { name: "period", in: "path", required: true, schema: { type: "string" } },
            { name: "package", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Download counts for the package",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      downloads: { type: "number" },
                      start: { type: "string" },
                      end: { type: "string" },
                      package: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const addSpecCode = (slug: string, baseUrl: string) => `
const added = await tools.executor.openapi.addSpec({
  spec: { kind: "blob", value: ${JSON.stringify(downloadsSpec(baseUrl))} },
  slug: ${JSON.stringify(slug)},
  baseUrl: ${JSON.stringify(baseUrl)},
});
return added.ok ? { ok: true, slug: added.data.slug, toolCount: added.data.toolCount } : { ok: false, error: added.error };
`;

// THE call under test: a no-auth connection with no credential origin at all.
const createNoAuthConnectionCode = (slug: string) => `
const created = await tools.executor.coreTools.connections.create({
  owner: "org",
  name: "public",
  integration: ${JSON.stringify(slug)},
  template: "none",
});
return created.ok ? { ok: true, connection: created.data } : { ok: false, error: created.error };
`;

// The relaxed filter must still reject an origin on a no-auth create. An
// empty `inputs: {}` is a (degenerate) origin and a credential the connection
// can't hold, so it stays a validation failure.
const createNoAuthWithEmptyInputsCode = (slug: string) => `
const created = await tools.executor.coreTools.connections.create({
  owner: "org",
  name: "public-bad",
  integration: ${JSON.stringify(slug)},
  template: "none",
  inputs: {},
});
return created.ok ? { ok: true, connection: created.data } : { ok: false, error: created.error };
`;

const invokeDownloadsCode = (slug: string) => `
const found = await tools.search({ namespace: ${JSON.stringify(slug)}, query: "downloads", limit: 5 });
const path = found.items[0]?.path;
if (!path) return { ok: false, error: "no downloads tool found", items: found.items };
let t = tools;
for (const seg of path.split(".")) t = t[seg];
const result = await t({ period: "last-week", package: "react" });
return { ok: result.ok, path, data: result.ok ? result.data : result.error };
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
  "Connections · an agent creates a no-auth connection and the upstream API answers 200",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeApiClient } = yield* Api;
      const upstream = yield* serveDownloadsApi;

      const integration = unique("downloads");
      const identity = yield* target.newIdentity();
      const session = mcp.session(identity);
      const client = yield* makeApiClient(api, identity);

      yield* Effect.gen(function* () {
        // 1. Register the no-auth API over MCP.
        const added = yield* executeJson(session, addSpecCode(integration, upstream.baseUrl));
        expect(added.ok, `addSpec succeeded: ${JSON.stringify(added)}`).toBe(true);
        expect(added.toolCount, "the spec's operation was extracted as a tool").toBe(1);

        // 2. THE FIX: create the connection with template "none" and NO origin.
        //    Pre-fix this failed arg validation with
        //    "Expected exactly one provider credential origin".
        const created = yield* executeJson(session, createNoAuthConnectionCode(integration));
        expect(
          created.ok,
          `no-auth connection created via the core tool: ${JSON.stringify(created)}`,
        ).toBe(true);
        expect(
          (created.connection as { template?: string } | undefined)?.template,
          "the connection is saved on the no-auth template",
        ).toBe("none");

        // 3. The operation is a live tool: invoke it and read back a real 200.
        const invoked = yield* executeJson(session, invokeDownloadsCode(integration));
        expect(
          invoked.ok,
          `the no-auth operation answered over the wire: ${JSON.stringify(invoked)}`,
        ).toBe(true);
        expect(
          (invoked.data as { downloads?: number } | undefined)?.downloads,
          "the deterministic API response crossed the full tool path",
        ).toBe(4242);
        expect(
          upstream.requests,
          "the upstream ledger recorded the exact no-auth request",
        ).toContainEqual({ method: "GET", path: "/downloads/point/last-week/react" });

        // 4. The relaxation is narrow: a no-auth create that carries an origin
        //    (empty `inputs: {}`) is still rejected.
        const rejected = yield* executeJson(session, createNoAuthWithEmptyInputsCode(integration));
        expect(
          rejected.ok,
          `a no-auth create with an empty inputs origin is rejected: ${JSON.stringify(rejected)}`,
        ).toBe(false);
      }).pipe(
        // Install cleanup before any product resource is created. Selfhost
        // shares one workspace identity, so every connection and the spec must
        // be removed even when an assertion or upstream call fails.
        Effect.ensuring(
          Effect.gen(function* () {
            yield* executeJson(session, removeConnectionsCode(integration)).pipe(Effect.ignore);
            yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);
