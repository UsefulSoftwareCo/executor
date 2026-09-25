/** Hosted MCP journeys use isolated grants and run against Node and Cloudflare. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployMcpApp } from "../support/mcp-app.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

layer(HostedLive, { excludeTestServices: true })("MCP server", (it) => {
  it.effect(scenarios.mcpProtocol.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const anonymous = yield* api.session();
        yield* evidence.step(
          "MCP rejects requests without a grant",
          Effect.gen(function* () {
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                "/mcp",
                {
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "anonymous-e2e", version: "1" },
                  },
                },
                { accept: "application/json, text/event-stream" },
              )).status,
            ).toBe(401);
          }),
        );
        const { app, name, receipt } = yield* deployMcpApp;
        yield* browser.login(actors.owner);
        const grant = yield* evidence.step(
          "Authorize an organization-bound MCP grant in the browser",
          oauth.authorize,
        );
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "original",
        );
        const listed = yield* client.use("Discover Executor's MCP tools", (client) =>
          client.listTools(),
        );
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "execute",
          "resume",
          "skills",
        ]);
        yield* evidence.json(
          "mcp-tools.json",
          listed.tools.map(({ name, inputSchema }) => ({ name, inputSchema })),
        );
        const search = yield* client.use(
          "Discover the deployed app through MCP execute",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools.search({query: ${JSON.stringify(name)}, limit: 10})`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const found = yield* Schema.decodeUnknownEffect(Completed)(search.structuredContent);
        // Discovery must expose the callable public path for this exact app.
        const discovered = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ path: Schema.String })),
          }),
        )(found.execution.value);
        expect(discovered.items.map((item) => item.path)).toContain(
          `tools[${JSON.stringify(app.slug)}].mutations.echo`,
        );
        yield* evidence.json("mcp-discovery.json", found);
        const code = `return await tools[${JSON.stringify(app.slug)}].mutations.echo({message: "from MCP"})`;
        const call = yield* client.use("Invoke the deployed tool through MCP", (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(call.structuredContent)).execution.value,
        ).toEqual({ message: "from MCP", receipt });
        yield* evidence.json("mcp-invocation.json", call.structuredContent);
        // Narrow the persisted grant through its public browser API. The open MCP session must obey it immediately.
        const grants = yield* body(
          Schema.Array(
            Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
          ),
          yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants"),
        );
        const granted = grants.find((item) => item.clientId === grant.clientId);
        if (granted === undefined) return yield* Effect.die("The OAuth grant was not persisted");
        const narrow = yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
          id: granted.grant.id,
          policy: {
            kind: "tools",
            approval: "client",
            apps: [{ app: app.id, tools: { kind: "selected", names: ["mutations.echo"] } }],
          },
        });
        expect(narrow.status).toBe(200);
        const refreshed = yield* evidence.step("Refresh the OAuth grant", oauth.refresh(grant));
        expect(
          Redacted.value(refreshed.tokens).refresh_token ===
            Redacted.value(grant.tokens).refresh_token,
        ).toBe(false);
        const renewed = yield* mcp.connect(
          Redacted.make(Redacted.value(refreshed.tokens).access_token),
          "refreshed",
        );
        const afterRefresh = yield* renewed.use(
          "The refreshed grant can still execute",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(afterRefresh.structuredContent)).execution
            .value,
        ).toEqual({ message: "from MCP", receipt });
        yield* evidence.step(
          "Revoking consent rejects access and refresh",
          Effect.gen(function* () {
            yield* oauth.revoke(refreshed);
            const denied = yield* api.request(anonymous, "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(refreshed.tokens).access_token}`,
            });
            expect(denied.status).toBe(401);
            expect(yield* oauth.refreshStatus(refreshed)).toBe(400);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.mcpSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const [{ app }, hidden] = yield* Effect.all([deployMcpApp, deployMcpApp], {
          concurrency: 2,
        });
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "skills",
        );
        const skillIndex = Schema.Struct({
          skills: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              app: Schema.Struct({ id: Schema.String, slug: Schema.String }),
            }),
          ),
        });
        const skillDocument = Schema.Struct({
          content: Schema.String,
          deployment: Schema.String,
        });
        // The default app installs asynchronously after signup. Observe its public
        // MCP catalog instead of depending on how long earlier test actions took.
        const guide = yield* client
          .use("Discover the default Executor app's authoring skill", (client, signal) =>
            client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(skillIndex)(result.structuredContent),
            ),
            Effect.map((index) =>
              index.skills.find(
                (entry) => entry.app.slug === "executor" && entry.name === "app-authoring",
              ),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("250 millis"),
              until: (guide) => guide !== undefined,
            }),
            Effect.timeout("15 seconds"),
          );
        if (guide === undefined)
          return yield* Effect.die("The installed Executor app must contain its authoring skill");
        const guideResponse = yield* client.use(
          "Read authoring instructions before connecting the Executor OAuth account",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: guide.app.slug, name: guide.name } },
              undefined,
              { signal },
            ),
        );
        const guideDocument = yield* Schema.decodeUnknownEffect(skillDocument)(
          guideResponse.structuredContent,
        );
        expect(guideDocument.content).toContain("# Build an Executor app");
        const executorSource = yield* body(
          Schema.Struct({
            id: Schema.String,
            files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
          }),
          yield* api.request(
            actors.owner,
            "GET",
            `/api/organizations/${actors.organization.id}/apps/${guide.app.id}/source`,
          ),
        );
        expect(executorSource.id).toBe(guideDocument.deployment);
        expect(executorSource.files.some((file) => file.path.startsWith("skills/"))).toBe(false);
        expect(executorSource.files.find((file) => file.path === "index.ts")?.content).toContain(
          "wellKnownSkills",
        );
        const skill = yield* client.use("Read a deployed app skill through MCP", (client, signal) =>
          client.callTool(
            { name: "skills", arguments: { app: app.slug, name: "echo" } },
            undefined,
            { signal },
          ),
        );
        const doc = yield* Schema.decodeUnknownEffect(skillDocument)(skill.structuredContent);
        expect(doc.content).toContain("[examples](references/examples.md)");
        const reference = yield* client.use("Read a pinned skill reference", (client, signal) =>
          client.callTool(
            {
              name: "skills",
              arguments: {
                app: app.slug,
                name: "echo",
                deployment: doc.deployment,
                file: "references/examples.md",
              },
            },
            undefined,
            { signal },
          ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(skillDocument)(reference.structuredContent)).content,
        ).toBe("Call mutations.echo with a message.");
        // Narrow the persisted grant through its public browser API. The open MCP session must obey it immediately.
        const grants = yield* body(
          Schema.Array(
            Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
          ),
          yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants"),
        );
        const granted = grants.find((item) => item.clientId === grant.clientId);
        if (granted === undefined) return yield* Effect.die("The OAuth grant was not persisted");
        const narrow = yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
          id: granted.grant.id,
          policy: {
            kind: "tools",
            approval: "client",
            apps: [{ app: app.id, tools: { kind: "selected", names: ["mutations.echo"] } }],
          },
        });
        expect(narrow.status).toBe(200);
        const index = yield* client.use("List only the granted app's skills", (client, signal) =>
          client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
        );
        const entries = (yield* Schema.decodeUnknownEffect(skillIndex)(index.structuredContent))
          .skills;
        expect(entries.map((entry) => entry.app.id)).toEqual([app.id]);
        expect(entries.some((entry) => entry.app.id === guide.app.id)).toBe(false);
        const deniedGuide = yield* client.use(
          "Authoring instructions obey the Executor app's grant",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: guide.app.slug, name: guide.name } },
              undefined,
              { signal },
            ),
        );
        expect(deniedGuide.isError).toBe(true);
        const deniedSkill = yield* client.use(
          "A hidden app's skill cannot be read by slug",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: hidden.app.slug, name: "echo" } },
              undefined,
              { signal },
            ),
        );
        expect(deniedSkill.isError).toBe(true);
        const stillAllowed = yield* client.use(
          "Selected tool access permits reading its app's instructions",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: app.slug, name: "echo" } },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(skillDocument)(stillAllowed.structuredContent))
            .deployment,
        ).toBe(doc.deployment);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
