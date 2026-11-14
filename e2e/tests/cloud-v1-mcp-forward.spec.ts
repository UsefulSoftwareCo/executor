/**
 * MCP requests v1 forwards for a workspace that moved to v2 (`notes/v1-shutdown.md`, Forwarding):
 * v1 authenticates the caller and sends the request on with a bearer it signs for that request,
 * naming the v1 account and organization, and for a toolkit URL the toolkit and the caller's copy
 * of it. Cloud maps them through the v1 import's records. The scenario records the scenario's
 * organization and owner as a moved v1 workspace, and the owner's scoped connections as their
 * copies of two v1 toolkits, as the import recorded them, then signs bearers as v1 does with the
 * secret the managed Cloud shares with its synthetic v1.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Execution } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import {
  V1McpForwardSecret,
  v1ForwardBearer,
  v1McpForwardFile,
  v1ToolkitConnectionId,
  type V1ForwardClaims,
} from "../support/v1-mcp-forward.ts";
import { recordMovedV1Organization, v1OrganizationId, v1UserId } from "../support/v1-moved.ts";
import { scenarios } from "../test-plan.ts";

const Identity = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const Found = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });

type Client = Effect.Success<ReturnType<McpClient["Service"]["connect"]>>;

/** An account-free app whose two tools both mention `word`: one lists, one creates. */
const widgetsApp = (word: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Widgets ${word}`,
      files: [
        {
          path: "index.ts",
          content: `
import { defineApp, mutation, object, query, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({
    listWidgets: query({ description: "List the ${word} widgets", input: object({}) }, async () => ({ widgets: ["${word}"] })),
    createWidget: mutation({ description: "Create a ${word} widget", input: object({}) }, async () => ({ created: "${word}" })),
  }),
}));
`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
    );
    return app;
  });

layer(HostedLive, { excludeTestServices: true })("Cloud v1 MCP forwarding", (it) => {
  it.effect(scenarios.v1McpForward.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          fs = yield* FileSystem.FileSystem,
          target = yield* Target,
          mcp = yield* McpClient;
        const { secret } = yield* fs
          .readFileString(`${target.directory}/${v1McpForwardFile}`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))),
          );
        const organization = actors.organization.id;
        const owner = (yield* body(
          Identity,
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        )).user.id;
        const word = `w${randomUUID().slice(0, 8)}`;
        const app = yield* widgetsApp(word);

        // The owner's copies of two v1 toolkits, each granting only the listing tool: one under
        // the id v1 computes for a first copy, one under another id the import map records.
        const v1 = { organization: v1OrganizationId(), account: v1UserId() };
        const row = "tk_forward";
        const connection = v1ToolkitConnectionId(organization, row, v1.account);
        const keptRow = "tk_kept";
        const kept = randomUUID();
        for (const id of [connection, kept]) {
          const created = yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${organization}/mcp-connections`,
            {
              id,
              name: `v1 toolkit ${id.slice(0, 8)}`,
              apps: [
                {
                  app: app.id,
                  runsAs: [{ kind: "app" }],
                  tools: { kind: "selected", names: ["listWidgets"] },
                },
              ],
            },
          );
          expect(created.status, JSON.stringify(created.body)).toBe(200);
        }
        yield* recordMovedV1Organization({
          v1Organization: v1.organization,
          v2Organization: organization,
          users: [{ v1: v1.account, v2: owner }],
          toolkits: [
            { row, member: v1.account, connection },
            { row: keptRow, member: v1.account, connection: kept },
          ],
        });

        /** A bearer as v1 signs it for one request; each is distinct and lives a few minutes. */
        let minted = 0;
        const sign = (claims: Partial<V1ForwardClaims> = {}, signedWith = secret) =>
          Redacted.make(
            v1ForwardBearer(signedWith, {
              account: v1.account,
              organization: v1.organization,
              exp: Math.floor(Date.now() / 1000) + 300 + minted++,
              ...claims,
            }),
          );
        const toolkit = { toolkit: row, connection };

        const run = (client: Client, operation: string, code: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
            );
        const search = (client: Client, query: string) =>
          run(
            client,
            `Search for ${query}`,
            `return await tools.search({query: ${JSON.stringify(query)}, limit: 50})`,
          ).pipe(
            Effect.flatMap((done) => Schema.decodeUnknownEffect(Found)(done.execution.value)),
            Effect.map((found) => found.items.map((item) => item.path)),
          );
        const has = (paths: readonly string[], name: string) =>
          paths.some((path) => path.endsWith(name));
        const call = (client: Client, tool: string) =>
          run(
            client,
            `Call ${tool}`,
            `return await tools[${JSON.stringify(app.slug)}].${tool}({})`,
          );

        // The account and organization alone reach every app, with a new bearer for each request
        // of the one session.
        const before = minted;
        const workspace = yield* mcp.connect(() => sign(), "forwarded-workspace");
        const listed = yield* workspace.use(
          "List the forwarded session's tools",
          (client, signal) => client.listTools(undefined, { signal }),
        );
        expect(listed.tools.map((tool) => tool.name)).toContain("execute");
        const everything = yield* search(workspace, word);
        expect(has(everything, "listWidgets")).toBe(true);
        expect(has(everything, "createWidget")).toBe(true);
        // Initialize, its notification, the listing and a search each signed their own bearer.
        expect(minted - before).toBeGreaterThanOrEqual(4);

        // A toolkit's bearer and URL reach only what the caller's copy of the toolkit grants, and
        // its tool calls run under it.
        const scoped = yield* mcp.connect(() => sign(toolkit), "forwarded-toolkit", {
          connection,
        });
        const granted = yield* search(scoped, word);
        // The listing tool, and not the tool the copy leaves out.
        expect(granted).toHaveLength(1);
        expect(has(granted, "listWidgets")).toBe(true);
        expect(has(granted, "createWidget")).toBe(false);
        const listedWidgets = yield* call(scoped, "listWidgets");
        expect(listedWidgets.execution, JSON.stringify(listedWidgets)).toEqual({
          ok: true,
          value: { widgets: [word] },
        });
        const created = yield* call(scoped, "createWidget");
        expect(created.execution.ok, JSON.stringify(created)).toBe(false);
        // A copy the import map records under another id than v1 computes runs under that copy.
        const keptClient = yield* mcp.connect(
          () => sign({ toolkit: keptRow, connection: kept }),
          "forwarded-kept-toolkit",
          { connection: kept },
        );
        const keptFound = yield* search(keptClient, word);
        expect(keptFound).toHaveLength(1);
        expect(has(keptFound, "listWidgets")).toBe(true);

        /** The status of one initialize request carrying this bearer, at this URL query. */
        const initialize = (bearer: Redacted.Redacted<string>, query = "") =>
          Effect.scoped(
            Effect.gen(function* () {
              const http = yield* HttpClient.HttpClient;
              const request = HttpClientRequest.post(`${target.metadata.origin}/mcp${query}`).pipe(
                HttpClientRequest.setHeaders({
                  accept: "application/json, text/event-stream",
                  authorization: `Bearer ${Redacted.value(bearer)}`,
                }),
              );
              const response = yield* http.execute(
                yield* HttpClientRequest.bodyJson(request, {
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "forwarded-refusal", version: "1" },
                  },
                }),
              );
              yield* response.text;
              return response.status;
            }),
          ).pipe(Effect.provide(FetchHttpClient.layer));
        const now = Math.floor(Date.now() / 1000);
        const toolkitQuery = `?connection=${connection}`;
        expect(yield* initialize(sign())).toBe(200);
        // v1 vouches for no one else, and a signature or lifetime v1 did not give is refused.
        expect(yield* initialize(sign({}, "x".repeat(64)))).toBe(401);
        expect(yield* initialize(sign({ exp: now - 10 }))).toBe(401);
        expect(yield* initialize(sign({ exp: now + 3_600 }))).toBe(401);
        expect(yield* initialize(sign({ toolkit: row }), toolkitQuery)).toBe(401);
        // A valid bearer for an account or organization the import never mapped.
        expect(yield* initialize(sign({ account: v1UserId() }))).toBe(403);
        expect(yield* initialize(sign({ organization: v1OrganizationId() }))).toBe(403);
        // A toolkit connection that is not the caller's copy: another member's, or another row's.
        const otherMember = v1ToolkitConnectionId(organization, row, v1UserId());
        expect(
          yield* initialize(
            sign({ toolkit: row, connection: otherMember }),
            `?connection=${otherMember}`,
          ),
        ).toBe(403);
        const otherRow = v1ToolkitConnectionId(organization, "tk_other", v1.account);
        expect(
          yield* initialize(
            sign({ toolkit: "tk_other", connection: otherRow }),
            `?connection=${otherRow}`,
          ),
        ).toBe(403);
        expect(yield* initialize(sign(toolkit), toolkitQuery)).toBe(200);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
