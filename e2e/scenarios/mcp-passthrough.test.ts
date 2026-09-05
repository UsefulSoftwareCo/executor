// The passthrough tool surface. A plain MCP endpoint serves `execute`
// (codemode); a connection that says `?mode=passthrough` instead serves every
// visible integration tool as its own MCP tool, with the workspace policy
// folded into each tool's annotations at list time, and NONE of `execute`,
// `skills` or `resume`. The harness's own approval flow reads the hints; the
// server never pauses. The proof is comparative where it can be (two sessions,
// same identity, differing only in the query) and end-to-end where it must be:
// a real call reaches a real upstream, and a `block` rule is enforced on both
// the list and the call.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** A two-operation API: a read and a write, so the surface carries one tool
 *  per policy outcome. The write takes a JSON body with a shared `$ref`, so
 *  the advertised schema must be self-contained to be usable. */
const spec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Passthrough API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    components: {
      schemas: {
        NewNote: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    },
    paths: {
      "/notes": {
        get: {
          operationId: "listNotes",
          summary: "List notes",
          responses: { "200": { description: "ok" } },
        },
        post: {
          operationId: "createNote",
          summary: "Create a note",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/NewNote" } },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A real upstream that records what reached it, so a passthrough call can be
 *  proven to have gone over the wire with the connection's credential. */
const serveRecordingUpstream = Effect.acquireRelease(
  Effect.callback<{
    readonly url: string;
    readonly requests: RecordedRequest[];
    close: () => void;
  }>((resume) => {
    const requests: RecordedRequest[] = [];
    const readBody = (request: IncomingMessage) =>
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
    const server = createServer((request, response) => {
      void readBody(request).then((body) => {
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            request.method === "POST"
              ? { id: "note_1", ...(body ? (JSON.parse(body) as object) : {}) }
              : { notes: [{ id: "note_0", text: "existing" }] },
          ),
        );
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

const rawResultOf = (result: { readonly raw: unknown }) =>
  result.raw as {
    content?: ReadonlyArray<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };

scenario(
  "Passthrough · a session connected with mode=passthrough serves the catalog as tools, no execute, no resume",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;

      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveRecordingUpstream;
      const slug = unique("ptapi");
      const otherSlug = unique("ptother");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // Two integrations, one connection each: the filter scenario below
          // needs a second one to leave out.
          for (const s of [slug, otherSlug]) {
            yield* client.openapi.addSpec({
              payload: {
                spec: { kind: "blob", value: spec(upstream.url) },
                slug: s,
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
                integration: IntegrationSlug.make(s),
                template: AuthTemplateSlug.make("apiKey"),
                value: `tok_${s}`,
              },
            });
          }

          // The OpenAPI plugin names an operation `<group>.<leaf>` (group from
          // the tag or path, here `notes`), and passthrough mangles the dot to
          // `_`, so the wire name is `<slug>__notes_listNotes`. Resolve by
          // suffix rather than hardcode the group: the mangling is what this
          // scenario proves, the grouping is the plugin's own contract.
          const toolNamed = (names: readonly string[], integration: string, leaf: string) =>
            names.find((name) => name.startsWith(`${integration}__`) && name.endsWith(`_${leaf}`));

          // --- The default is untouched: codemode, no per-tool surface. ---
          const codemode = mcp.session(identity);
          const codemodeTools = yield* codemode.listTools();
          expect(codemodeTools, "a plain session still serves execute").toContain("execute");
          expect(
            toolNamed(codemodeTools, slug, "listNotes"),
            "a plain session serves no passthrough tools",
          ).toBeUndefined();

          // --- Passthrough: same identity, `?mode=passthrough`. ---
          const passthrough = mcp.session(identity, { mode: "passthrough" });
          const described = yield* passthrough.describeTools();
          const names = described.map((tool) => tool.name);
          const listTool = toolNamed(names, slug, "listNotes");
          const createTool = toolNamed(names, slug, "createNote");
          expect(
            listTool,
            `the read operation is served as its own tool (got ${names.join(", ")})`,
          ).toBeDefined();
          expect(createTool, "the write operation is served as its own tool").toBeDefined();
          expect(
            toolNamed(names, otherSlug, "listNotes"),
            "the second integration is served too",
          ).toBeDefined();
          // Names obey the MCP grammar and carry the integration prefix.
          for (const name of names) expect(name, "MCP-safe name").toMatch(/^[A-Za-z0-9_-]+$/);
          expect(names, "execute is not served in passthrough").not.toContain("execute");
          expect(names, "skills is not served in passthrough").not.toContain("skills");
          expect(names, "resume is not served in passthrough").not.toContain("resume");
          expect(
            names.filter((name) => name.startsWith("search_")),
            "no search_<integration> tools either",
          ).toEqual([]);

          if (!listTool || !createTool) return; // narrowed above; keeps TS honest
          // --- Policy is advertised, not enforced by a pause. ---
          // The OpenAPI plugin derives approval from the HTTP method: GET is
          // read-only and free, POST requires approval by default.
          const listDef = described.find((tool) => tool.name === listTool);
          const createDef = described.find((tool) => tool.name === createTool);
          expect(listDef?.annotations, "GET advertises read-only, non-destructive").toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
          });
          expect(createDef?.annotations, "POST advertises destructive").toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
          });
          // The body schema arrives self-contained: the `$ref` and its target
          // both ride along, so a client can validate without a second fetch.
          expect(
            JSON.stringify(createDef?.inputSchema),
            "the write tool's schema names the body field",
          ).toContain("text");

          // --- A read call reaches the upstream with the connection's credential. ---
          const listed = yield* passthrough.call(listTool, {});
          expect(listed.ok, `the read call completes: ${listed.text}`).toBe(true);
          expect(listed.text, "the upstream payload comes back").toContain("existing");
          const listReq = upstream.requests.find((r) => r.method === "GET");
          expect(listReq, "the GET reached the upstream").toBeDefined();
          expect(listReq?.authorization, "the connection's credential was applied").toBe(
            `Bearer tok_${slug}`,
          );

          // --- An approval-gated call runs to completion: no pause, no resume. ---
          const created = yield* passthrough.call(createTool, { body: { text: "hello" } });
          expect(created.ok, `the gated call completes without a pause: ${created.text}`).toBe(
            true,
          );
          expect(created.text, "the call did not pause").not.toContain("Execution paused");
          expect(created.text, "the call did not ask for a resume").not.toContain("executionId");
          const createReq = upstream.requests.find((r) => r.method === "POST");
          expect(createReq, "the POST reached the upstream").toBeDefined();
          expect(createReq?.body, "the JSON body went over the wire").toContain('"text":"hello"');
          expect(
            rawResultOf(created).structuredContent?.status,
            "the result is a completed execution",
          ).toBe("completed");

          // --- Arguments are validated against the advertised schema. ---
          // The server answers with a JSON-RPC invalid-params error, which the
          // client library surfaces as a rejection (`ok: false` here). Either
          // way the proof is the same: the upstream never saw a second POST.
          const invalid = yield* passthrough.call(createTool, { body: { wrong: 1 } }).pipe(
            Effect.map((r) => r.ok),
            Effect.catchCause(() => Effect.succeed(false)),
          );
          expect(invalid, "a body missing its required field is refused").toBe(false);
          expect(
            upstream.requests.filter((r) => r.method === "POST").length,
            "the invalid call never reached the upstream",
          ).toBe(1);

          // --- `?integrations=` narrows the surface. ---
          const narrowed = mcp.session(identity, {
            mode: "passthrough",
            integrations: [otherSlug],
          });
          const narrowedNames = yield* narrowed.listTools();
          expect(
            toolNamed(narrowedNames, otherSlug, "listNotes"),
            "the requested integration is served",
          ).toBeDefined();
          expect(narrowedNames, "the other integration is left out").not.toContain(listTool);

          // --- `block` is enforced on the list AND the call. ---
          const blockRule = yield* client.policies.create({
            payload: { owner: "org", pattern: `${slug}.*.*.*.createNote`, action: "block" },
          });
          yield* Effect.ensuring(
            Effect.gen(function* () {
              const afterBlock = mcp.session(identity, { mode: "passthrough" });
              const afterNames = yield* afterBlock.listTools();
              expect(afterNames, "a blocked tool is not listed").not.toContain(createTool);
              expect(afterNames, "the unblocked sibling still is").toContain(listTool);
              // A client that cached the old name cannot call it either: the
              // executor refuses the call at invoke time, which passthrough
              // renders as an MCP error result.
              const stale = yield* passthrough.call(createTool, { body: { text: "again" } });
              expect(stale.ok, "a blocked tool fails when called").toBe(false);
              expect(stale.text, "the failure names the policy").toContain("tool_blocked");
              expect(
                upstream.requests.filter((r) => r.method === "POST").length,
                "the blocked call never reached the upstream",
              ).toBe(1);
            }),
            client.policies
              .remove({ params: { policyId: blockRule.id }, payload: { owner: "org" } })
              .pipe(Effect.ignore),
          );
        }),
        Effect.gen(function* () {
          for (const s of [slug, otherSlug]) {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(s),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.openapi.removeSpec({ params: { slug: s } }).pipe(Effect.ignore);
          }
        }),
      );
    }),
  ),
);
