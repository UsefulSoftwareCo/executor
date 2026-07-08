// Cross-target: MCP tool-catalog freshness — the "the server changed its tools
// and executor noticed" promise. A connection's catalog used to be listed once
// at create time and never again: a server-side rename left stale tools failing
// forever and new tools invisible until a human clicked Refresh. These journeys
// prove the catalog now converges on its own, driven only through public
// surfaces (typed API + sandbox executions) against real MCP servers whose
// catalogs mutate mid-scenario:
//
//   1. list_changed — a tool call mutates the server's catalog mid-call; the
//      server pushes `notifications/tools/list_changed` on the open connection
//      and the very next tools read re-lists. No refresh, no second failing
//      invocation: the notification alone drives convergence.
//   2. unknown-tool self-heal — the catalog mutates OUTSIDE any call window
//      (no notification to react to). Invoking the retired tool fails with the
//      typed `mcp_tool_unknown` error telling the agent to re-list, and that
//      failure alone heals the catalog for the next read.
//   3. pagination — a server that pages `tools/list` with `nextCursor` gets
//      its WHOLE catalog registered, not just the first page.
//   4. outage resilience — a re-list against a dead server keeps the
//      previously working catalog instead of wiping it, and converges to the
//      server's new catalog once it comes back.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeMutableCatalogMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

const freshSlug = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

// Sandbox code for the agent path: call one addressed MCP tool and return the
// ToolResult envelope fields the assertions need. Tool failures are values in
// the sandbox (`{ ok: false, error }`), not exceptions.
const invokeToolCode = (slug: string, connection: string, tool: string, args: unknown) => `
const result = await tools.${slug}.org.${connection}.${tool}(${JSON.stringify(args)});
return { ok: result.ok, payload: result.ok ? result.data : result.error };
`;

type SandboxToolOutcome = {
  readonly ok: boolean;
  readonly payload?: {
    readonly code?: string;
    readonly message?: string;
  };
};

// ---------------------------------------------------------------------------
// A minimal streamable-http MCP fixture with a MUTABLE catalog and a kill
// switch, for the journeys the SDK test server can't express: multi-page
// tools/list responses and a server that goes down between listings. Speaks
// just enough JSON-RPC for the discovery path (initialize, notifications/*,
// tools/list).
// ---------------------------------------------------------------------------

type PagedMcpFixture = {
  readonly url: string;
  /** Replace the catalog; each inner array is one tools/list page. */
  readonly setPages: (pages: readonly (readonly string[])[]) => void;
  /** true → every request answers 503, as an unreachable server would. */
  readonly setDead: (dead: boolean) => void;
};

const servePagedMcpFixture = (initialPages: readonly (readonly string[])[]) =>
  Effect.acquireRelease(
    Effect.callback<PagedMcpFixture & { readonly close: () => void }>((resume) => {
      let pages = initialPages;
      let dead = false;

      const server = createServer((request, response) => {
        const respondJson = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };

        if (dead) {
          response.writeHead(503, { "content-type": "text/plain" });
          response.end("fixture is down");
          return;
        }
        if (request.method === "GET") {
          // 405 = "no standalone SSE stream" — an expected shape the client
          // handles without error.
          response.writeHead(405, { "content-type": "text/plain" });
          response.end("SSE disabled");
          return;
        }

        let body = "";
        request.on("data", (chunk: unknown) => {
          body += String(chunk);
        });
        request.on("end", () => {
          const rpc = JSON.parse(body) as {
            readonly id?: string | number | null;
            readonly method?: string;
            readonly params?: { readonly cursor?: string };
          };

          if (rpc.method === "initialize") {
            respondJson(200, {
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "paged-catalog-fixture", version: "1.0.0" },
              },
            });
            return;
          }
          if (rpc.method?.startsWith("notifications/")) {
            response.writeHead(202);
            response.end();
            return;
          }
          if (rpc.method === "tools/list") {
            const cursor = rpc.params?.cursor;
            const index = cursor === undefined ? 0 : Number(cursor.replace("page-", ""));
            const page = pages[index] ?? [];
            const nextCursor = index + 1 < pages.length ? `page-${index + 1}` : undefined;
            respondJson(200, {
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              result: {
                tools: page.map((name) => ({
                  name,
                  description: `Tool ${name}`,
                  inputSchema: { type: "object", properties: {} },
                })),
                ...(nextCursor === undefined ? {} : { nextCursor }),
              },
            });
            return;
          }
          respondJson(200, {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            error: { code: -32601, message: `Method not found: ${rpc.method}` },
          });
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/mcp`,
            setPages: (next: readonly (readonly string[])[]) => {
              pages = next;
            },
            setDead: (next: boolean) => {
              dead = next;
            },
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (fixture) => Effect.sync(fixture.close),
  );

// ---------------------------------------------------------------------------
// 1. list_changed received during a call window → next read re-lists
// ---------------------------------------------------------------------------

scenario(
  "MCP catalog · a list_changed notification during a call refreshes the catalog on the next read",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp_notify");

      // A real MCP server (SDK McpServer over streamable-http) whose
      // `rename_greet` tool renames `greet` → `greet_v2` mid-call, emitting
      // `notifications/tools/list_changed` on the open connection.
      const mutable = makeMutableCatalogMcpServer();
      const server = yield* serveMcpServer(mutable.factory);

      yield* client.mcp.addServer({
        payload: { transport: "remote", name: "Mutable catalog MCP", endpoint: server.url, slug },
      });

      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        const toolNames = Effect.map(
          client.tools.list({ query: { integration: IntegrationSlug.make(slug) } }),
          (tools) => tools.map((tool) => String(tool.name)).sort(),
        );

        expect(yield* toolNames, "the initial catalog holds the v1 tool").toEqual([
          mutable.initialToolName,
          "rename_greet",
        ]);

        // The catalog mutates DURING this call; the notification arrives on
        // the same connection the call rides.
        const executed = yield* client.executions.execute({
          payload: { code: invokeToolCode(slug, "main", "rename_greet", {}), autoApprove: true },
        });
        expect(executed.status, "the mutating call completed").toBe("completed");
        const outcome = JSON.parse(executed.text) as SandboxToolOutcome;
        expect(outcome.ok, executed.text).toBe(true);

        // THE promise: no refresh click, no failing retry — the very next
        // tools read already serves the renamed catalog.
        expect(yield* toolNames, "the next read follows the notification").toEqual([
          mutable.renamedToolName,
          "rename_greet",
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// 2. drift with NO notification → typed unknown-tool failure → self-heal
// ---------------------------------------------------------------------------

scenario(
  "MCP catalog · calling a tool the server retired fails typed and heals the catalog",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp_drift");

      const mutable = makeMutableCatalogMcpServer();
      const server = yield* serveMcpServer(mutable.factory);

      yield* client.mcp.addServer({
        payload: { transport: "remote", name: "Drifting catalog MCP", endpoint: server.url, slug },
      });

      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        const toolNames = Effect.map(
          client.tools.list({ query: { integration: IntegrationSlug.make(slug) } }),
          (tools) => tools.map((tool) => String(tool.name)).sort(),
        );

        expect(yield* toolNames, "the catalog was registered against v1").toContain(
          mutable.initialToolName,
        );

        // The server owner ships a rename while executor holds NO connection —
        // there is no notification to react to; executor's catalog is drifted
        // and it cannot know yet.
        mutable.renameTool();

        // An agent (trusting the stale catalog) calls the retired tool. The
        // spec answer is an unknown-tool error; executor must surface it as a
        // typed, actionable failure — not a generic error the agent retries
        // blindly.
        const executed = yield* client.executions.execute({
          payload: {
            code: invokeToolCode(slug, "main", mutable.initialToolName, { name: "world" }),
            autoApprove: true,
          },
        });
        expect(executed.status, "the failing call still completes the sandbox").toBe("completed");
        const outcome = JSON.parse(executed.text) as SandboxToolOutcome;
        expect(outcome.ok, "the stale invocation reports failure as a value").toBe(false);
        expect(outcome.payload?.code, "the failure is the typed drift error").toBe(
          "mcp_tool_unknown",
        );
        expect(
          outcome.payload?.message,
          "the message tells the agent to re-list, not retry",
        ).toContain("list tools again");

        // The failure alone marked the catalog stale: the next read converges
        // with no refresh click and no waiting on a freshness window.
        const healed = yield* toolNames;
        expect(healed, "the healed catalog serves the renamed tool").toContain(
          mutable.renamedToolName,
        );
        expect(healed, "the retired tool is gone from the catalog").not.toContain(
          mutable.initialToolName,
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// 3. paginated tools/list → the whole catalog registers, not page one
// ---------------------------------------------------------------------------

scenario(
  "MCP catalog · a server that pages tools/list registers its whole catalog",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp_paged");

      // Two pages: [alpha, beta] then [gamma]. A first-page-only client
      // registers two tools and silently loses gamma.
      const fixture = yield* servePagedMcpFixture([["alpha", "beta"], ["gamma"]]);

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Paged catalog MCP",
          endpoint: fixture.url,
          slug,
          remoteTransport: "streamable-http",
        },
      });

      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        const tools = yield* client.tools.list({
          query: { integration: IntegrationSlug.make(slug) },
        });
        expect(
          tools.map((tool) => String(tool.name)).sort(),
          "every page of the catalog registered",
        ).toEqual(["alpha", "beta", "gamma"]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// 4. a re-list against a dead server keeps the working catalog
// ---------------------------------------------------------------------------

scenario(
  "MCP catalog · an outage during refresh keeps the working catalog and recovery converges",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp_outage");

      const fixture = yield* servePagedMcpFixture([["alpha", "beta"]]);

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Flaky MCP",
          endpoint: fixture.url,
          slug,
          remoteTransport: "streamable-http",
        },
      });

      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        const connectionParams = {
          owner: "org",
          integration: IntegrationSlug.make(slug),
          name: ConnectionName.make("main"),
        } as const;
        const toolNames = Effect.map(
          client.tools.list({ query: { integration: IntegrationSlug.make(slug) } }),
          (tools) => tools.map((tool) => String(tool.name)).sort(),
        );

        expect(yield* toolNames, "the catalog registered while the server was up").toEqual([
          "alpha",
          "beta",
        ]);

        // The server goes down; a refresh (the UI button / agent tool path)
        // re-lists against a dead endpoint. The listing is non-authoritative:
        // it must NOT wipe the working catalog.
        fixture.setDead(true);
        const refreshedWhileDown = yield* client.connections.refresh({
          params: connectionParams,
        });
        expect(
          refreshedWhileDown.map((tool) => String(tool.name)).sort(),
          "refresh during the outage answers the kept catalog",
        ).toEqual(["alpha", "beta"]);
        expect(yield* toolNames, "the outage never wiped the working tools").toEqual([
          "alpha",
          "beta",
        ]);

        // The failed sync is recorded as CATALOG trouble on the connection —
        // a consecutive-failure record with the plugin's reason — and stays
        // out of `lastHealth`: a down server says nothing about the credential.
        const findRow = Effect.map(client.connections.list({ query: {} }), (rows) =>
          rows.find((c) => String(c.integration) === String(slug) && String(c.name) === "main"),
        );
        const duringOutage = yield* findRow;
        expect(
          duringOutage?.toolsSyncError?.failures,
          "the failed sync starts a failure streak",
        ).toBe(1);
        expect(
          duringOutage?.toolsSyncError?.reason,
          "the sync-error record carries the plugin's reason",
        ).toContain("MCP");
        expect(
          duringOutage?.lastHealth ?? null,
          "a sync failure never forges a health verdict",
        ).toBeNull();

        // The server comes back CHANGED (beta retired, delta added). A
        // refresh now converges to the live catalog.
        fixture.setDead(false);
        fixture.setPages([["alpha", "delta"]]);
        const refreshedAfterRecovery = yield* client.connections.refresh({
          params: connectionParams,
        });
        expect(
          refreshedAfterRecovery.map((tool) => String(tool.name)).sort(),
          "refresh after recovery serves the server's new catalog",
        ).toEqual(["alpha", "delta"]);
        expect(yield* toolNames, "the read surface follows").toEqual(["alpha", "delta"]);

        // Recovery clears the streak: the sync-error record is gone.
        const afterRecovery = yield* findRow;
        expect(
          afterRecovery?.toolsSyncError ?? null,
          "a successful sync clears the failure record",
        ).toBeNull();
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);
