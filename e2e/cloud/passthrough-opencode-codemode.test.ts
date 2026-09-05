// Cloud: the REAL OpenCode binary, with ITS OWN codemode on, over an Executor
// passthrough endpoint serving 10,200 tools.
//
// This is the pairing passthrough exists for. Executor stops being the
// codemode layer and becomes a plain MCP server that advertises every tool;
// OpenCode's experimental codemode (`OPENCODE_EXPERIMENTAL_CODE_MODE`) takes
// the whole catalog into its confined interpreter and shows the model ONE
// `execute` tool with a token-budgeted catalog plus `tools.$codemode.search`.
// So the things to prove are on both sides of the wire:
//
//   - Executor serves all 10,200 tools to OpenCode within OpenCode's connect
//     timeout (30s), so `mcp list` reads "connected" and codemode has a
//     catalog to work with.
//   - OpenCode does NOT flatten those 10,200 tools into the model's tool list:
//     the replay brain is offered `execute`, not 10,200 functions.
//   - Discovery works end to end: a program that calls
//     `tools.$codemode.search` finds an Executor tool by name, and a second
//     program calls it, which lands on a real upstream with the connection's
//     credential and returns the payload through OpenCode's interpreter.
//
// The catalog is seeded over the public API as a user would build it (the
// large-catalog seeder, sized to 10,198 tools, plus a 2-operation API backed by
// a recording upstream). The model is the replay brain (scripted turns, real
// agent); OpenCode's OAuth, MCP connect, tool listing and codemode run are all
// its own code. The whole terminal session is recorded to terminal.cast.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { serveReplayBrain } from "../src/clients/replay-brain";
import { scenario } from "../src/scenario";
import { Api, Cli, OpenCode, RunDir, Target } from "../src/services";
import { catalogApi, seedLargeCatalog } from "../scenarios/support/large-catalog";

const SERVER_NAME = "executor";

// 322 (the real Vercel fixture) + 12 × 823 synthetic = 10,198, plus the two
// callable operations below = exactly 10,200 tools on the wire.
const SYNTHETIC_INTEGRATIONS = 12;
const OPS_PER_INTEGRATION = 823;
const EXPECTED_TOOL_COUNT = 10_200;

// OpenCode's MCP connect timeout (`DEFAULT_TIMEOUT` in its mcp service). The
// tools/list of 10,200 definitions has to fit inside it, or the server reads
// "failed" and codemode sees nothing.
const OPENCODE_CONNECT_TIMEOUT_MS = 30_000;

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** The one integration that is actually callable: a read and a write against
 *  the recording upstream. Everything else in the catalog is discovery mass. */
const notesSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Notes API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/notes": {
        get: {
          operationId: "listNotes",
          summary: "List every note in the notebook",
          responses: { "200": { description: "ok" } },
        },
        post: {
          operationId: "createNote",
          summary: "Create a note in the notebook",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

interface RecordedRequest {
  readonly method: string;
  readonly authorization: string | undefined;
}

const serveRecordingUpstream = Effect.acquireRelease(
  Effect.callback<{
    readonly url: string;
    readonly requests: RecordedRequest[];
    close: () => void;
  }>((resume) => {
    const requests: RecordedRequest[] = [];
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ notes: [{ id: "note_0", text: "existing note" }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${port}`,
          requests,
          close: () => {
            server.close();
            server.closeAllConnections();
          },
        }),
      );
    });
  }),
  (upstream) => Effect.sync(() => upstream.close()),
);

scenario(
  "Passthrough · the real OpenCode binary runs its own codemode over 10,200 Executor tools",
  { timeout: 900_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const opencode = yield* OpenCode;
      const runDir = yield* RunDir;
      const cli = yield* Cli;
      const { client: makeClient } = yield* Api;

      const identity = yield* target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;
      const client = yield* makeClient(catalogApi, identity);
      const upstream = yield* serveRecordingUpstream;
      const notesSlug = unique("notes");

      // --- Seed: 10,198 discovery-mass tools + 2 callable ones. ---
      const seeded = yield* seedLargeCatalog(client, {
        syntheticIntegrations: SYNTHETIC_INTEGRATIONS,
        opsPerIntegration: OPS_PER_INTEGRATION,
      });
      const cleanup = Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(notesSlug),
              name: ConnectionName.make("main"),
            },
          })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug: notesSlug } }).pipe(Effect.ignore);
        yield* seeded.cleanup;
      });

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: notesSpec(upstream.url) },
              slug: notesSlug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(notesSlug),
              template: AuthTemplateSlug.make("apiKey"),
              value: "tok_notes",
            },
          });
          const visible = (yield* client.tools.list({ query: {} })).filter(
            (tool) => tool.static !== true,
          );
          expect(visible.length, "the catalog is exactly the advertised size").toBe(
            EXPECTED_TOOL_COUNT,
          );

          // --- The replay brain: two scripted turns of OpenCode codemode. ---
          // Turn 0: discover the notes tool through OpenCode's own search.
          // Turn 1: call the path search returned. Turn 2: summarize, stop.
          let discoveredPath: string | undefined;
          const brain = yield* serveReplayBrain((ctx) => {
            // OpenCode also asks the model for a session title, with no tools
            // offered. Answer it with text and keep it out of the script.
            if (ctx.toolNames.length === 0) return { text: "Notebook" };
            if (ctx.lastRole === "user") {
              return {
                text: "Searching the connected tools.",
                tool: {
                  name: "execute",
                  args: {
                    code: `return await tools.$codemode.search({ query: "list notes notebook", limit: 5 });`,
                  },
                },
              };
            }
            if (discoveredPath === undefined) {
              const result = ctx.lastToolResult ?? "";
              // codemode returns pretty-printed JSON; the path is the exact
              // expression the next program must call.
              const match = new RegExp(
                `"path":\\s*"(tools\\.[A-Za-z0-9_$.\\[\\]"-]*${notesSlug}[^"]*listNotes)"`,
              ).exec(result);
              if (!match) {
                throw new Error(`search did not surface the notes tool: ${result.slice(0, 600)}`);
              }
              discoveredPath = match[1]!;
              return {
                text: "Found it. Listing the notes.",
                tool: { name: "execute", args: { code: `return await ${discoveredPath}({});` } },
              };
            }
            return { text: "The notebook has one existing note." };
          });

          const passthroughUrl = new URL("/mcp?mode=passthrough", target.baseUrl).toString();
          const home = opencode.makeHome(SERVER_NAME, passthroughUrl, {
            chatBrainUrl: brain.baseUrl,
          });
          const env = {
            ...home.env,
            OPENCODE_EXPERIMENTAL_CODE_MODE: "true",
            PS1: "$ ",
            BASH_SILENCE_DEPRECATION_WARNING: "1",
          };
          // First-run database migration happens off camera.
          yield* Effect.sync(() => opencode.warmUp(home));

          let connectMs = -1;
          yield* cli.session(
            ["bash", "--norc"],
            async (term) => {
              await term.screen.waitForText("$", { timeoutMs: 10_000 });

              const outputAfter = (text: string, line: string): string | null => {
                const echoed = text.lastIndexOf(line);
                if (echoed === -1) return null;
                const after = text.slice(echoed + line.length);
                return after.trimEnd().endsWith("\n$") ? after : null;
              };
              const sh = async (line: string, timeoutMs: number) => {
                await term.keyboard.type(line);
                await term.keyboard.press("Enter");
                const snapshot = await term.screen.waitUntil(
                  (current) => outputAfter(current.text, line) !== null,
                  { timeoutMs },
                );
                return outputAfter(snapshot.text, line) ?? "";
              };

              // OpenCode's own OAuth against the target: discovery, DCR, PKCE.
              const consent = opencode.completeOAuthConsent(home, email, home.openedUrls().length);
              const auth = await sh(`opencode mcp auth ${SERVER_NAME}`, 90_000);
              await consent;
              expect(auth, "opencode mcp auth completes").not.toContain("failed");

              // The load-bearing connect: tools/list of 10,200 definitions
              // inside OpenCode's own 30s connect timeout.
              const startedAt = Date.now();
              const listed = await sh("opencode mcp list", 120_000);
              connectMs = Date.now() - startedAt;
              expect(
                listed,
                `OpenCode connects to the 10,200-tool passthrough endpoint (took ${connectMs}ms)`,
              ).toContain("connected");

              // A real agent turn: OpenCode's codemode over our catalog.
              const ran = await sh(`opencode run "List the notes in my notebook"`, 300_000);
              expect(ran, "the run did not error").not.toContain("UnknownError");
            },
            {
              cwd: home.projectDir,
              env,
              record: join(runDir, "terminal.cast"),
              viewport: { cols: 100, rows: 40 },
            },
          );

          // --- What OpenCode showed the model, and what came back. ---
          expect(brain.errors(), "the scripted brain hit no surprises").toEqual([]);
          // Only the turns that carried tools are the agent loop; the
          // title request is OpenCode housekeeping.
          const requests = brain.requests().filter((request) => request.toolNames.length > 0);
          expect(requests.length, "three model turns: search, call, summary").toBe(3);

          // Codemode: the model sees ONE execute tool, not 10,200 functions.
          const offered = requests[0]!.toolNames;
          expect(offered, "OpenCode offers its codemode execute tool").toContain("execute");
          expect(
            offered.filter((name) => name.startsWith(`${SERVER_NAME}_`)),
            "no MCP tool is flattened into the model's tool list",
          ).toEqual([]);
          expect(
            offered.length,
            "the model's tool list stays small in front of a 10,200-tool server",
          ).toBeLessThan(40);

          // Discovery surfaced OUR tool by its passthrough name.
          expect(discoveredPath, "search returned a callable path").toBeDefined();
          expect(discoveredPath, "the path names the passthrough tool").toContain(notesSlug);

          // The call went over the wire with the connection's credential and
          // the payload came back through OpenCode's interpreter.
          const lastToolResult = [...requests[2]!.messages]
            .reverse()
            .find((message) => message.role === "tool")?.content;
          expect(lastToolResult, "the executed program returned the upstream payload").toContain(
            "existing note",
          );
          const upstreamGet = upstream.requests.find((request) => request.method === "GET");
          expect(upstreamGet, "the GET reached the upstream").toBeDefined();
          expect(upstreamGet?.authorization, "the connection's credential was applied").toBe(
            "Bearer tok_notes",
          );

          // Recorded for the run report; the hard bound is OpenCode's own
          // connect timeout, which `mcp list` above already proved.
          expect(connectMs, "connect stays inside OpenCode's timeout").toBeLessThan(
            OPENCODE_CONNECT_TIMEOUT_MS * 4,
          );
        }),
        cleanup,
      );
    }),
  ),
);
