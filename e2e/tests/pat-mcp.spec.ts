import { managementApp } from "../support/management-app.ts";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Result, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const Token = Schema.Struct({
  key: Schema.RedactedFromValue(Schema.String),
  id: Schema.String,
  expiresAt: Schema.NullOr(Schema.DateFromString),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const BrowserPending = Schema.Struct({ ...Pending.fields, approvalUrl: Schema.String });

layer(HostedLive, { excludeTestServices: true })("PAT MCP", (it) => {
  it.effect(scenarios.patMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const anonymous = yield* api.session();
        const keys: { actor: Session; id: string }[] = [];
        let appId: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const key of keys)
              yield* api.request(key.actor, "POST", "/api/auth/api-key/delete", {
                keyId: key.id,
              });
            if (appId !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${appId}`);
          }).pipe(Effect.orDie),
        );
        const create = (actor: Session, expiresIn?: number) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: "MCP test",
              ...(expiresIn === undefined ? {} : { expiresIn }),
            });
            expect(response.status).toBe(200);
            const key = yield* body(Token, response);
            keys.push({ actor, id: key.id });
            return key;
          });
        const owner = yield* create(actors.owner),
          other = yield* create(actors.owner),
          member = yield* create(actors.member);
        const headers = {
          authorization: `Bearer ${Redacted.value(owner.key)}`,
          "x-executor-organization": organization,
        };
        yield* evidence.step(
          "PAT authentication requires a permitted organization and never falls back to cookies",
          Effect.gen(function* () {
            expect(
              (yield* api.request(anonymous, "GET", "/mcp", undefined, {
                authorization: headers.authorization,
              })).status,
            ).toBe(403);
            expect(
              (yield* api.request(anonymous, "GET", "/mcp", undefined, {
                ...headers,
                "x-executor-organization": "missing-organization",
              })).status,
            ).toBe(403);
            expect(
              (yield* api.request(actors.owner, "GET", "/mcp", undefined, {
                ...headers,
                authorization: "Bearer exp_" + "x".repeat(43),
              })).status,
            ).toBe(401);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                "/mcp?elicitation_mode=invalid",
                undefined,
                headers,
              )).status,
            ).toBe(400);
          }),
        );
        const receipt = randomUUID();
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `PAT MCP ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, mutation, object } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({  mutations: {
  echo: mutation({ description: "Echo receipt", input: object({}) }, async () => ({ receipt: ${JSON.stringify(receipt)} })),
  approved: mutation({ description: "Requires approval", input: object({}), approval: always() }, async () => ({ receipt: ${JSON.stringify(receipt)} }))
} }));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        appId = app.id;
        const code = (tool: string) =>
          `return await tools[${JSON.stringify(app.slug)}].mutations.${tool}({})`;
        const ownerClient = yield* mcp.connect(owner.key, "pat-model", { organization });
        const tools = yield* ownerClient.use("List MCP tools with a PAT", (client) =>
          client.listTools(),
        );
        expect(tools.tools.map((tool) => tool.name)).toContain("execute");
        const call = yield* ownerClient.use("Execute a tool with a PAT", (client, signal) =>
          client.callTool({ name: "execute", arguments: { code: code("echo") } }, undefined, {
            signal,
          }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(call.structuredContent)).execution,
        ).toEqual({ ok: true, value: { receipt } });
        const native = yield* mcp.connect(other.key, "pat-native", {
          organization: actors.organization.slug,
          mode: "native",
        });
        const nativeCall = yield* native.use(
          "PAT supports native mode and organization slugs",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: code("echo") } }, undefined, {
              signal,
            }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(nativeCall.structuredContent)).execution.ok,
        ).toBe(true);
        const nativeApproved = yield* native.use(
          "Native PAT execution asks the client for approval",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: code("approved") } }, undefined, {
              signal,
            }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(nativeApproved.structuredContent)).execution
            .ok,
        ).toBe(true);
        expect(yield* native.elicitationCount).toBe(1);
        const memberClient = yield* mcp.connect(member.key, "pat-member", { organization });
        const denied = yield* memberClient.use(
          "A member PAT cannot use the owner’s private app",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: code("echo") } }, undefined, {
              signal,
            }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(denied.structuredContent)).execution.ok,
        ).toBe(false);
        yield* evidence.step(
          "An existing MCP client uses the user's current role",
          Effect.gen(function* () {
            const admin = yield* create(actors.admin);
            const adminClient = yield* mcp.connect(admin.key, "pat-role-change", { organization });
            const { profile } = yield* managementApp(actors.admin);
            const inspect = `return await tools.executor.profiles[${JSON.stringify(profile.id)}].queries.appManagement_source(${JSON.stringify({ path: { organization, app: app.id } })})`;
            const before = yield* adminClient.use(
              "An admin PAT can inspect app source",
              (client, signal) =>
                client.callTool({ name: "execute", arguments: { code: inspect } }, undefined, {
                  signal,
                }),
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Completed)(before.structuredContent)).execution.ok,
            ).toBe(true);
            const members = yield* body(
              Schema.Struct({
                members: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
              }),
              yield* api.request(
                actors.owner,
                "GET",
                `/api/auth/organization/list-members?organizationId=${organization}`,
              ),
            );
            const member = members.members.find((member) => member.role === "admin");
            if (member === undefined) return yield* Effect.fail(new Error("Admin fixture missing"));
            yield* Effect.acquireUseRelease(
              api.request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
                organizationId: organization,
                memberId: member.id,
                role: "member",
              }),
              () =>
                Effect.gen(function* () {
                  const after = yield* adminClient.use(
                    "Downgrade takes effect without reconnecting",
                    (client, signal) =>
                      client.callTool(
                        { name: "execute", arguments: { code: inspect } },
                        undefined,
                        { signal },
                      ),
                  );
                  expect(
                    (yield* Schema.decodeUnknownEffect(Completed)(after.structuredContent))
                      .execution.ok,
                  ).toBe(false);
                }),
              () =>
                api
                  .request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
                    organizationId: organization,
                    memberId: member.id,
                    role: "admin",
                  })
                  .pipe(Effect.orDie),
            );
          }),
        );
        const paused = yield* ownerClient.use(
          "Tool approvals still pause PAT execution",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: code("approved") } }, undefined, {
              signal,
            }),
        );
        const pending = yield* Schema.decodeUnknownEffect(Pending)(paused.structuredContent);
        const otherClient = yield* mcp.connect(other.key, "pat-other", { organization });
        const wrong = yield* otherClient.use(
          "A different PAT cannot resume this continuation",
          (client, signal) =>
            client.callTool(
              {
                name: "resume",
                arguments: { requestId: pending.requestId, response: { action: "accept" } },
              },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(
            wrong.structuredContent,
          )).status,
        ).toBe("unavailable");
        const resumed = yield* ownerClient.use(
          "The original PAT resumes its approved tool",
          (client, signal) =>
            client.callTool(
              {
                name: "resume",
                arguments: { requestId: pending.requestId, response: { action: "accept" } },
              },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent)).execution,
        ).toEqual({ ok: true, value: { receipt } });
        const browser = yield* mcp.connect(owner.key, "pat-browser", {
          organization,
          mode: "browser",
        });
        const browserResult = yield* browser.use(
          "PAT browser mode creates a review link without the token secret",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: code("approved") } }, undefined, {
              signal,
            }),
        );
        const browserPending = yield* Schema.decodeUnknownEffect(BrowserPending)(
          browserResult.structuredContent,
        );
        expect(browserPending.approvalUrl.includes(Redacted.value(owner.key))).toBe(false);
        const url = new URL(browserPending.approvalUrl);
        const review = `/api/mcp/approvals/${encodeURIComponent(browserPending.requestId)}${url.search}`;
        expect((yield* api.request(actors.member, "GET", review)).status).toBe(401);
        expect((yield* api.request(actors.owner, "GET", review)).status).toBe(200);
        expect(
          (yield* api.request(actors.owner, "POST", review, { response: { action: "accept" } }))
            .status,
        ).toBe(200);
        const browserResume = yield* browser.use(
          "Resume after the token owner approves in the browser",
          (client, signal) =>
            client.callTool(
              {
                name: "resume",
                arguments: { requestId: browserPending.requestId, response: { action: "accept" } },
              },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(browserResume.structuredContent)).execution
            .ok,
        ).toBe(true);
        const next = yield* browser.use(
          "Create another pending review before revoking the token",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: code("approved") } }, undefined, {
              signal,
            }),
        );
        const nextPending = yield* Schema.decodeUnknownEffect(BrowserPending)(
          next.structuredContent,
        );
        const nextUrl = new URL(nextPending.approvalUrl);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
            keyId: owner.id,
          })).status,
        ).toBe(200);
        const revoked = yield* Effect.result(
          ownerClient.use(
            "Revocation rejects calls from the already-connected client",
            (client, signal) =>
              client.callTool({ name: "execute", arguments: { code: code("echo") } }, undefined, {
                signal,
              }),
          ),
        );
        expect(Result.isFailure(revoked)).toBe(true);
        expect((yield* api.request(anonymous, "GET", "/mcp", undefined, headers)).status).toBe(401);
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `/api/mcp/approvals/${encodeURIComponent(nextPending.requestId)}${nextUrl.search}`,
          )).status,
        ).toBe(401);
        const remaining = yield* otherClient.use(
          "Revoking one token leaves another token working",
          (client) => client.listTools(),
        );
        expect(remaining.tools.map((tool) => tool.name)).toContain("execute");
        // The token must remain valid for the two-request network handshake.
        // Wait for its server-issued expiry, not a fixed delay after connecting.
        const expiring = yield* create(actors.owner, 10);
        const expiringClient = yield* mcp.connect(expiring.key, "pat-expiry", { organization });
        if (expiring.expiresAt === null) return yield* Effect.die("Missing token expiry");
        const remainingMs = expiring.expiresAt.getTime() - (yield* Clock.currentTimeMillis);
        expect(remainingMs).toBeGreaterThan(0);
        yield* Effect.sleep(remainingMs + 100);
        expect(
          (yield* api.request(anonymous, "GET", "/mcp", undefined, {
            ...headers,
            authorization: `Bearer ${Redacted.value(expiring.key)}`,
          })).status,
        ).toBe(401);
        const expired = yield* Effect.result(
          expiringClient.use("Expiry rejects an existing MCP client", (client) =>
            client.listTools(),
          ),
        );
        expect(Result.isFailure(expired)).toBe(true);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
