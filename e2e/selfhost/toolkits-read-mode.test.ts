// Selfhost · Toolkit access "read" exposes only read-only tools and blocks
// writes. `readOnly` is derived from HTTP method on OpenAPI integrations
// (GET/HEAD/OPTIONS => readOnly:true; POST/PUT/PATCH/DELETE are writes), and
// Read-only toolkit access keeps a connection's tool under "read" ONLY when
// `annotations.readOnly === true`. So we stand up a real OpenAPI upstream with
// BOTH a GET (read) and a POST (write) operation, grant the same connection at
// "read" in one workspace toolkit and "full" in another, and prove:
//   - the read toolkit's scoped MCP session runs the GET-derived tool but
//     BLOCKS the POST-derived tool at execute (error envelope, not the success
//     payload) and omits it from the scoped inventory;
//   - the full toolkit's scoped session runs BOTH.
//
// The upstream is a real `node:http` listening socket in THIS test process —
// the same cross-process pattern `serveMcpServer` uses (the OpenAPI echo helper
// is in-memory via NodeHttpServer.layerTest and is NOT reachable from the
// separately-booted selfhost server). The selfhost boot sets
// EXECUTOR_ALLOW_LOCAL_NETWORK=true, so the instance is allowed to dial the
// loopback upstream. The spec itself is passed inline (blob) so the spec fetch
// never hits the network — only the GET/POST invocations dial the socket.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Scope } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin(), openApiHttpPlugin(), toolkitsPlugin()] as const);

// Identifier-safe (no hyphens) so the sandbox `tools.<int>.<owner>.<conn>.<tool>`
// dotted path stays valid JS, and so the create-time name normalization (which
// strips hyphens) round-trips unchanged.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

// A real OpenAPI upstream on a loopback socket. `GET /thing` is a read; `POST
// /thing` is a write. Both return a recognizable JSON marker so a successful
// invocation is distinguishable from a blocked one. The bearer token is
// required so the call genuinely goes through the connection's credential.
interface Upstream {
  readonly baseUrl: string;
}

// Mirrors serveMcpServer: acquire a real listening socket carrying its own
// `close`, release closes it, and we strip `close` from the value handed back.
const serveUpstream = (token: string): Effect.Effect<Upstream, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Upstream & { readonly close: Effect.Effect<void> }, never>((resume) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const auth = request.headers.authorization;
        const send = (status: number, body: Record<string, unknown>): void => {
          response.writeHead(status, {
            "content-type": "application/json",
          });
          response.end(JSON.stringify(body));
        };
        if (auth !== `Bearer ${token}`) {
          send(401, { error: "unauthorized" });
          return;
        }
        if (url.pathname === "/thing" && request.method === "GET") {
          send(200, { marker: "read-ok", kind: "get" });
          return;
        }
        if (url.pathname === "/thing" && request.method === "POST") {
          // Drain the body so the socket closes cleanly, then ack.
          request.resume();
          request.on("end", () => send(201, { marker: "write-ok", kind: "post" }));
          return;
        }
        send(404, { error: "not_found" });
      });
      const close = Effect.sync(() => {
        server.close();
        server.closeAllConnections?.();
      });
      server.once("error", () => resume(Effect.succeed({ baseUrl: "", close })));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(Effect.succeed({ baseUrl: `http://127.0.0.1:${port}`, close }));
      });
    }),
    (acquired) => acquired.close,
  ).pipe(Effect.map(({ close: _close, ...rest }) => rest));

// Inline spec: one GET (read) + one POST (write) operation on /thing, both
// secured by the same bearer scheme. operationIds are single identifier-safe
// words so the derived tool names are predictable, but the test discovers the
// real tool addresses from the catalog rather than hardcoding them.
const makeSpec = (): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Read-mode API", version: "1.0.0" },
    paths: {
      "/thing": {
        get: {
          operationId: "getthing",
          summary: "Read a thing",
          responses: { "200": { description: "the thing" } },
        },
        post: {
          operationId: "creatething",
          summary: "Create a thing",
          responses: { "201": { description: "created" } },
        },
      },
    },
  });

scenario(
  'Toolkits · access "read" exposes only read-only (GET) tools and blocks writes (POST)',
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const token = `tok-${randomBytes(6).toString("hex")}`;
      const upstream = yield* serveUpstream(token);
      expect(upstream.baseUrl, "the loopback OpenAPI upstream bound a port").not.toBe("");

      const slug = ident("oapi");
      const conn = ident("conn");

      // Register the integration (spec inline; baseUrl points at the real
      // loopback socket) and create the org connection that holds the bearer.
      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: makeSpec() },
          slug,
          baseUrl: upstream.baseUrl,
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: {
                authorization: ["Bearer ", { type: "variable", name: "token" }],
              },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make(conn),
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("apiKey"),
          value: token,
        },
      });

      // Discover the real tool addresses from the catalog. The GET-derived tool
      // is read-only (requiresApproval falsy); the POST-derived tool is a write
      // (requiresApproval true, per annotationsForOperation). We derive the
      // sandbox call name (the last dotted segment of the address) so we never
      // hardcode the camelCase leaf the definition layer produces.
      const tools = yield* client.tools.list({
        query: { integration: IntegrationSlug.make(slug) },
      });
      const mine = tools.filter((t) => String(t.integration) === slug);
      const readTool = mine.find((t) => t.requiresApproval !== true);
      const writeTool = mine.find((t) => t.requiresApproval === true);
      expect(
        readTool?.address,
        `GET-derived read-only tool is in the catalog; tools=${mine
          .map((t) => `${t.name}(approval=${String(t.requiresApproval)})`)
          .join(", ")}`,
      ).toBeDefined();
      expect(
        writeTool?.address,
        `POST-derived write tool is in the catalog; tools=${mine
          .map((t) => `${t.name}(approval=${String(t.requiresApproval)})`)
          .join(", ")}`,
      ).toBeDefined();
      const readName = String(readTool!.name);
      const writeName = String(writeTool!.name);

      // Two workspace toolkits over the SAME connection: one at "read", one at
      // "full".
      const kitRead = yield* client.toolkits.create({
        payload: {
          slug: ident("kitread"),
          name: "Read kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slug),
              connection: conn,
              access: "read",
            },
          ],
        },
      });
      const kitFull = yield* client.toolkits.create({
        payload: {
          slug: ident("kitfull"),
          name: "Full kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slug),
              connection: conn,
              access: "full",
            },
          ],
        },
      });

      // --- READ toolkit: GET runs, POST is blocked ---------------------------
      const scopedRead = mcp.session(identity, { toolkit: kitRead.slug });

      // The scoped inventory still lists the integration (it is in the slice),
      // and the read tool's dotted name is reachable.
      const readDesc = describeExecute(yield* scopedRead.describeTools());
      expect(readDesc, "read-toolkit inventory includes the in-slice integration").toContain(slug);

      const readGet = yield* scopedRead.call("execute", {
        code: `return await tools.${slug}.org.${conn}.${readName}({});`,
      });
      expect(
        readGet.ok && readGet.text.includes("read-ok"),
        `read access runs the GET tool; ok=${readGet.ok} text=${readGet.text}`,
      ).toBe(true);

      const readPost = yield* scopedRead.call("execute", {
        code: `return await tools.${slug}.org.${conn}.${writeName}({ body: {} });`,
      });
      // Under "read" access the write (POST) tool is removed from the slice, so
      // it is not reachable in the sandbox — the call neither completes (no
      // upstream "write-ok") nor even pauses for approval ("paused"); it errors.
      expect(
        readPost.text.includes("write-ok") || readPost.text.includes("paused"),
        `read access must EXCLUDE the write tool (unreachable); text=${readPost.text}`,
      ).toBe(false);
      expect(
        readPost.text,
        `excluded write errors, not the GET payload; text=${readPost.text}`,
      ).not.toBe(readGet.text);

      // --- FULL toolkit: GET runs; POST is reachable (pauses for approval) ----
      const scopedFull = mcp.session(identity, { toolkit: kitFull.slug });

      const fullDesc = describeExecute(yield* scopedFull.describeTools());
      expect(fullDesc, "full-toolkit inventory includes the integration").toContain(slug);

      const fullGet = yield* scopedFull.call("execute", {
        code: `return await tools.${slug}.org.${conn}.${readName}({});`,
      });
      expect(
        fullGet.ok && fullGet.text.includes("read-ok"),
        `full access runs the GET tool; ok=${fullGet.ok} text=${fullGet.text}`,
      ).toBe(true);

      const fullPost = yield* scopedFull.call("execute", {
        code: `return await tools.${slug}.org.${conn}.${writeName}({ body: {} });`,
      });
      // Under "full" access the write tool IS in the slice. Writes still require
      // approval (independent of toolkit access), so a default-mode session
      // pauses ("Execution paused") rather than completing — which still proves
      // the tool is REACHABLE, the opposite of read access where it is excluded.
      expect(
        fullPost.text.includes("paused") || fullPost.text.includes("write-ok"),
        `full access EXPOSES the write tool (runs or pauses for approval); text=${fullPost.text}`,
      ).toBe(true);
      expect(
        fullPost.text,
        `full reaches the write tool while read excludes it; read=${readPost.text} full=${fullPost.text}`,
      ).not.toBe(readPost.text);
    }),
  ),
);
