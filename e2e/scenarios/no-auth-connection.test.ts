// The agentic no-auth wire-up: an agent registers a public REST API over MCP
// and then creates its connection PROGRAMMATICALLY through the gateway core
// tool — `coreTools.connections.create` with `template: "none"` and no
// credential origin. This is the path that used to be impossible: the core
// tool's arg schema demanded "exactly one provider credential origin", so an
// agent wiring up a public, no-auth integration (public MCP server, public
// REST API) was forced to bounce the user into the web UI via createHandoff,
// even though the engine fully supports a zero-credential connection.
//
// This scenario walks the WHOLE path against a real public no-auth API (the
// npm registry downloads endpoint, https://api.npmjs.org) so the proof is an
// actual 200 over the wire, not a stub:
//
//   1. MCP `execute` → `openapi.addSpec` registers a tiny no-auth spec
//      (no securitySchemes ⇒ the integration is no-auth)
//   2. MCP `execute` → `coreTools.connections.create` with template "none"
//      and NEITHER `from` NOR `inputs` — the call that used to fail validation
//   3. The operation is now a callable tool: invoke it and read back a 200
//      with the real download count
//   4. Guard the relaxed-but-still-strict contract: a no-auth create that
//      DOES carry an origin (here an empty `inputs: {}`) is still rejected
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// A real public, no-auth REST API. No `components.securitySchemes` and no
// top-level `security`, so addSpec derives no auth method and the integration
// is no-auth — exactly the shape a connection on `template: "none"` targets.
const NPM_DOWNLOADS_SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "npm Registry Downloads", version: "1.0.0" },
  servers: [{ url: "https://api.npmjs.org" }],
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

const addSpecCode = (slug: string) => `
const added = await tools.executor.openapi.addSpec({
  spec: { kind: "blob", value: ${JSON.stringify(NPM_DOWNLOADS_SPEC)} },
  slug: ${JSON.stringify(slug)},
  baseUrl: "https://api.npmjs.org",
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

// The relaxed filter must still reject an origin on a no-auth create — an
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
  "Connections · an agent creates a no-auth connection over the core tool and the public API answers 200",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: makeApiClient } = yield* Api;

    const integration = unique("npmdl");
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);
    const client = yield* makeApiClient(api, identity);

    yield* Effect.gen(function* () {
      // 1. Register the public no-auth API over MCP.
      const added = yield* executeJson(session, addSpecCode(integration));
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
      const downloads = (invoked.data as { downloads?: number } | undefined)?.downloads;
      expect(typeof downloads, "the public API returned a download count").toBe("number");
      expect(downloads as number, "react has a non-zero weekly download count").toBeGreaterThan(0);

      // 4. The relaxation is narrow: a no-auth create that carries an origin
      //    (empty `inputs: {}`) is still rejected.
      const rejected = yield* executeJson(session, createNoAuthWithEmptyInputsCode(integration));
      expect(
        rejected.ok,
        `a no-auth create with an empty inputs origin is rejected: ${JSON.stringify(rejected)}`,
      ).toBe(false);
    }).pipe(
      // Selfhost shares one workspace identity — leaked connections fail other
      // scenarios' zero-state assertions, so drop everything this run made.
      // `connections.remove` is approval-gated, so the cleanup execute pauses
      // per connection; `executeJson` auto-approves each pause so the removes
      // actually run.
      Effect.ensuring(
        Effect.gen(function* () {
          yield* executeJson(session, removeConnectionsCode(integration));
          yield* client.openapi.removeSpec({ params: { slug: integration } });
        }).pipe(Effect.ignore),
      ),
    );
  }),
);
