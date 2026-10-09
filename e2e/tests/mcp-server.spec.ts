/** Hosted MCP journeys use isolated grants and run against Node and Cloudflare. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import { appsManifest } from "../support/apps-release.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
/**
 * MCP clients print a refused request's body after their own prefix, such as "Error POSTing to
 * endpoint:", so the JSON-RPC error names the grant's own reason for the refusal.
 */
const refusal = (message: string) => ({
  jsonrpc: "2.0",
  id: null,
  error: {
    // JSON-RPC Invalid Request, as for the MCP transport's own rejections.
    code: -32600,
    message: `GrantForbidden (HTTP 403): ${message}`,
    data: { code: "GrantForbidden", status: 403 },
  },
});
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

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
          `tools[${JSON.stringify(app.slug)}].echo`,
        );
        yield* evidence.json("mcp-discovery.json", found);
        const code = `return await tools[${JSON.stringify(app.slug)}].echo({message: "from MCP"})`;
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
            apps: [{ app: app.id, tools: { kind: "selected", names: ["echo"] } }],
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

  it.effect(scenarios.mcpOAuthWithoutResource.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        yield* browser.login(actors.owner);
        const grant = yield* evidence.step(
          "Authorize a client that sends no resource parameter",
          oauth.authorizeWithoutResource,
        );
        const token = Redacted.make(Redacted.value(grant.tokens).access_token);
        const client = yield* mcp.connect(token, "without-resource");
        const listed = yield* client.use("The plain MCP URL accepts the grant", (client) =>
          client.listTools(),
        );
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "execute",
          "resume",
          "skills",
        ]);
        // The default is the plain URL's model mode only, not every approval mode.
        const other = yield* Effect.exit(
          mcp.connect(token, "without-resource-browser-mode", { mode: "browser" }),
        );
        expect(Exit.isFailure(other)).toBe(true);
        const anonymous = yield* api.session();
        const bearer = { authorization: `Bearer ${Redacted.value(token)}` };
        const browserMode = yield* api.request(
          anonymous,
          "POST",
          "/mcp?elicitation_mode=browser",
          listTools,
          bearer,
        );
        expect(browserMode.status).toBe(403);
        expect(browserMode.body).toMatchObject(
          refusal(
            "This credential works only at the MCP URL ending in /mcp, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp, or connect again at this URL to get a credential for it, then retry.",
          ),
        );
        yield* evidence.step(
          "A grant issued at the model-mode URL cannot be narrowed to browser approval",
          Effect.gen(function* () {
            // No URL could serve it: its own URL cannot ask for browser approval.
            const narrowed = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/mcp/grants/narrow",
              {
                id: grant.grantId,
                policy: { kind: "tools", apps: [], approval: "browser" },
              },
            );
            expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(403);
            expect(narrowed.body).toMatchObject({
              message:
                "Browser approval needs a grant issued at an MCP URL with elicitation_mode=browser.",
            });
            const relisted = yield* client.use("The grant still serves its own URL", (client) =>
              client.listTools(),
            );
            expect(relisted.tools.map((tool) => tool.name).sort()).toEqual([
              "execute",
              "resume",
              "skills",
            ]);
          }),
        );
        yield* oauth.revoke(grant);
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
        const instructions = yield* client.use("Read the server's MCP instructions", (client) =>
          Promise.resolve(client.getInstructions()),
        );
        // The default app installs asynchronously after signup. Observe its public
        // MCP catalog instead of depending on how long earlier test actions took.
        const executorSkills = yield* client
          .use("Discover the default Executor app's skills", (client, signal) =>
            client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(skillIndex)(result.structuredContent),
            ),
            Effect.map((index) => index.skills.filter((entry) => entry.app.slug === "executor")),
            Effect.repeat({
              schedule: Schedule.spaced("250 millis"),
              until: (skills) => skills.length > 0,
            }),
            Effect.timeout("15 seconds"),
          );
        expect(executorSkills.map((entry) => entry.name).sort()).toEqual([
          "app-authoring",
          "code-mode",
          "executor",
        ]);
        const guide = executorSkills.find((entry) => entry.name === "executor");
        if (guide === undefined)
          return yield* Effect.die("The installed Executor app must contain its entry skill");
        const readExecutorSkill = (name: string, operation: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool(
                { name: "skills", arguments: { app: guide.app.slug, name } },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                Schema.decodeUnknownEffect(skillDocument)(response.structuredContent),
              ),
            );
        const entry = yield* readExecutorSkill("executor", "Read the Executor app's entry skill");
        // The instructions are the entry skill without its frontmatter, so the two cannot drift.
        expect(entry.content).toMatch(/^---\nname: executor\n/);
        expect(instructions).toBe(entry.content.replace(/^---\n[\s\S]*?\n---\n/, "").trim());
        expect(instructions).toContain("`code-mode`");
        expect(instructions).toContain("`app-authoring`");
        const guideDocument = yield* readExecutorSkill(
          "app-authoring",
          "Read authoring instructions before connecting the Executor OAuth account",
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
        // An app that never deployed and an app still waiting for its account must not hide
        // other apps' skills, and a direct read must say what the agent should do next.
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/apps`, {
          name: `Undeployed ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: "export default {};" }, appsManifest],
        });
        expect(created).toMatchObject({ status: 200 });
        const undeployed = yield* body(App, created);
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Needs account ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "skills/connect/SKILL.md",
              content: "---\nname: connect\ndescription: Needs an account.\n---\nConnected.\n",
            },
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const provider=defineProvider({name:"Skills account",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({ accounts: { service: provider.many() } }, async () => ({ tools: router({}) }));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed).toMatchObject({ status: 200 });
        const needsAccount = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          Effect.forEach([undeployed, needsAccount], (removed) =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${removed.id}`),
          ).pipe(Effect.orDie),
        );
        const partial = yield* client.use(
          "Skill discovery survives undeployed and account-less apps",
          (client, signal) =>
            client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
        );
        expect(partial.isError).not.toBe(true);
        const partialIndex = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            ...skillIndex.fields,
            unavailableApps: Schema.Array(
              Schema.Struct({ app: Schema.String, reason: Schema.String }),
            ),
          }),
        )(partial.structuredContent);
        expect(partialIndex.skills.some((entry) => entry.app.id === app.id)).toBe(true);
        expect(partialIndex.skills.some((entry) => entry.app.id === guide.app.id)).toBe(true);
        expect(partialIndex.unavailableApps.map((entry) => entry.app)).toContain(undeployed.id);
        const accountless = yield* client.use(
          "Reading an account-less app's skills explains the missing account",
          (client, signal) =>
            client.callTool({ name: "skills", arguments: { app: needsAccount.slug } }, undefined, {
              signal,
            }),
        );
        expect(accountless.isError).toBe(true);
        expect(accountless.content).toEqual([
          expect.objectContaining({
            type: "text",
            text: `${needsAccount.slug} needs a connected account before its skills can be read. Connect one through Executor's account connection tool, then retry.`,
          }),
        ]);
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
        ).toBe("Call echo with a message.");
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
            apps: [{ app: app.id, tools: { kind: "selected", names: ["echo"] } }],
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
