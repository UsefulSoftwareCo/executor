import { request as nodeRequest } from "node:http";
/** Real local pairing, OAuth/PKCE, grant checks, and MCP transport; only synthetic data. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpExecutionResult, BrowserExecutionResult } from "@executor-js/mcp";
import { AppId, ToolName } from "@executor-js/sdk/core";
import { GrantPolicy } from "@executor-js/mcp-auth";
import { startLocalServer } from "../src/node.ts";
import { ServerConfig } from "../src/contracts/config.ts";

const navigate = (url: string, headers: Record<string, string>) =>
  new Promise<Response>((resolve, reject) => {
    const req = nodeRequest(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (data: Buffer) => chunks.push(data));
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined)
            for (const item of typeof value === "string" ? [value] : value)
              headers.append(key, item);
        assert.ok(res.statusCode);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on("error", reject);
    req.end();
  });
const adminKey = "synthetic-local-oauth-admin-000000000000";
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String });
test(
  "local OAuth grants cannot pair, administer, or approve outside their authority",
  { timeout: 60_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-local-oauth-" });
          const server = yield* startLocalServer(
            Schema.decodeUnknownSync(ServerConfig)({
              directory,
              port: 0,
              apiKey: adminKey,
              encryptionKey: "ab".repeat(32),
            }),
          );
          const pair = yield* server.issuePairingLink;
          yield* Effect.promise(async () => {
            const origin = server.url;
            const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
              fetch(`${origin}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
                redirect: "manual",
              });
            const paired = await post(
              "/auth/exchange",
              {
                token: new URLSearchParams(new URL(Redacted.value(pair.url)).hash.slice(1)).get(
                  "pair",
                ),
              },
              { origin },
            );
            assert.equal(paired.status, 200);
            const cookie = paired.headers.get("set-cookie")?.split(";")[0];
            assert.ok(cookie);
            const deployment = await post(
              "/v1/apps/deploy",
              {
                owner: "local-oauth-test",
                name: "Grant probe",
                files: [
                  {
                    path: "index.ts",
                    content: `import {defineApp,object,mutation} from "apps";import {always} from "apps/operations/approval";let effects=0;export default defineApp({accounts:{}},async()=>({mutations:{count:mutation({description:"Count",input:object({})},async()=>effects),write:mutation({description:"Write",input:object({}),approval:always()},async()=>++effects)}}));`,
                  },
                ],
              },
              { authorization: `Bearer ${adminKey}` },
            );
            assert.equal(deployment.status, 200);
            const { app } = Schema.decodeUnknownSync(
              Schema.Struct({ app: Schema.Struct({ id: AppId, slug: Schema.String }) }),
            )(await deployment.json());
            const registered = await post("/api/auth/oauth2/register", {
              client_name: "Local test",
              redirect_uris: ["http://127.0.0.1:9999/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            });
            assert.equal(registered.status, 201);
            const { client_id } = Schema.decodeUnknownSync(
              Schema.Struct({ client_id: Schema.String }),
            )(await registered.json());
            const verifier = "synthetic-local-verifier-".repeat(3);
            const challenge = Buffer.from(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
            ).toString("base64url");
            const grant = async (
              policy?: GrantPolicy,
              mode: "model" | "native" | "browser" = "model",
            ) => {
              const resource =
                mode === "model" ? `${origin}/mcp` : `${origin}/mcp?elicitation_mode=${mode}`;
              const authorize = await navigate(
                `${origin}/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://127.0.0.1:9999/callback", code_challenge: challenge, code_challenge_method: "S256", scope: "mcp offline_access", resource, state: "synthetic" })}`,
                {
                  cookie,
                  accept: "text/html",
                  "sec-fetch-mode": "navigate",
                  "sec-fetch-site": "cross-site",
                  "sec-fetch-dest": "document",
                },
              );
              assert.equal(authorize.status, 302);
              const location = authorize.headers.get("location");
              assert.ok(location);
              const consent = await post(
                "/api/auth/oauth2/consent",
                { accept: true, oauth_query: new URL(location, origin).search.slice(1) },
                {
                  cookie,
                  origin,
                  ...(policy === undefined ? {} : { "x-executor-grant": JSON.stringify(policy) }),
                },
              );
              assert.equal(consent.status, 200);
              assert.equal(consent.headers.get("set-cookie"), null);
              const { url } = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
                await consent.json(),
              );
              const code = new URL(url).searchParams.get("code");
              assert.ok(code);
              const token = await fetch(`${origin}/api/auth/oauth2/token`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "authorization_code",
                  client_id,
                  code,
                  code_verifier: verifier,
                  redirect_uri: "http://127.0.0.1:9999/callback",
                  resource,
                }),
              });
              assert.equal(token.status, 200);
              return Schema.decodeUnknownSync(Tokens)(await token.json());
            };
            for (const mode of ["native", "browser"] as const) {
              const challenge = await post(`/mcp?elicitation_mode=${mode}`, {});
              assert.equal(challenge.status, 401);
              const metadataUrl = challenge.headers
                .get("www-authenticate")
                ?.match(/resource_metadata="([^"]+)"/)?.[1];
              assert.ok(metadataUrl);
              const metadata = Schema.decodeUnknownSync(Schema.Struct({ resource: Schema.String }))(
                await (await fetch(metadataUrl)).json(),
              );
              assert.equal(metadata.resource, `${origin}/mcp?elicitation_mode=${mode}`);
              const tokens = await grant(undefined, mode);
              assert.equal(
                (
                  await fetch(`${origin}/mcp`, {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                  })
                ).status,
                403,
              );
            }
            const rejectedNavigation = await navigate(`${origin}/api/auth/oauth2/authorize`, {
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
            });
            assert.equal(rejectedNavigation.status, 403);
            const crossSiteConsent = await post(
              "/api/auth/oauth2/consent",
              {},
              { cookie, "sec-fetch-site": "cross-site" },
            );
            assert.equal(crossSiteConsent.status, 403);
            const selection: GrantPolicy = {
              kind: "tools",
              apps: [
                {
                  app: app.id,
                  tools: { kind: "selected", names: [ToolName.make("mutations.count")] },
                },
              ],
              approval: "client",
            };
            const tokens = await grant(selection);
            const bearer = { authorization: `Bearer ${tokens.access_token}` };
            for (const path of ["/auth/pair", "/v1/tools/resume"]) {
              const response = await post(
                path,
                path.includes("resume")
                  ? { requestId: "apr_fake", response: { action: "accept" } }
                  : {},
                bearer,
              );
              assert.equal(response.status, 401);
            }
            const client = new Client({ name: "restricted", version: "1" });
            const transport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: { headers: bearer },
              });
            await client.connect(transport);
            try {
              const invoke = async (tool: string) => {
                const wire = await client.callTool({
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].mutations[${JSON.stringify(tool)}]({});`,
                  },
                });
                return Schema.decodeUnknownSync(McpExecutionResult)(wire.structuredContent);
              };
              const read = await invoke("count");
              assert.ok(
                read.status === "completed" && read.execution.ok && read.execution.value === 0,
              );
              const denied = await invoke("write");
              assert.ok(denied.status === "completed" && !denied.execution.ok);
              const browser = await grant(
                {
                  kind: "tools",
                  approval: "browser",
                  apps: [{ app: app.id, tools: { kind: "all" } }],
                },
                "browser",
              );
              for (const mode of ["", "?elicitation_mode=model", "?elicitation_mode=native"]) {
                const response = await fetch(`${origin}/mcp${mode}`, {
                  headers: { authorization: `Bearer ${browser.access_token}` },
                });
                assert.equal(response.status, 403);
              }

              const browserBearer = { authorization: `Bearer ${browser.access_token}` };
              const reviewer = new Client({ name: "browser-only", version: "1" });
              const reviewTransport: Omit<StreamableHTTPClientTransport, "sessionId"> =
                new StreamableHTTPClientTransport(
                  new URL(`${origin}/mcp?elicitation_mode=browser`),
                  {
                    requestInit: { headers: browserBearer },
                  },
                );
              await reviewer.connect(reviewTransport);
              try {
                const wire = await reviewer.callTool({
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].mutations.write({});`,
                  },
                });
                const pending = Schema.decodeUnknownSync(BrowserExecutionResult)(
                  wire.structuredContent,
                );
                if (pending.status !== "approval-required")
                  throw new Error("Expected browser approval");
                const link = new URL(pending.approvalUrl);
                const endpoint = `/dashboard/api/mcp/approvals/${pending.requestId}${link.search}`;
                assert.equal(
                  (await post(endpoint, { response: { action: "accept" } }, browserBearer)).status,
                  403,
                );
                assert.equal(
                  (
                    await post(
                      "/v1/tools/resume",
                      { requestId: pending.requestId, response: { action: "accept" } },
                      browserBearer,
                    )
                  ).status,
                  401,
                );
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 100);
                try {
                  await assert.rejects(
                    reviewer.callTool(
                      {
                        name: "resume",
                        arguments: { requestId: pending.requestId, response: { action: "accept" } },
                      },
                      undefined,
                      { signal: controller.signal },
                    ),
                  );
                } finally {
                  clearTimeout(timer);
                }
                const waitingCount = await invoke("count");
                assert.ok(
                  waitingCount.status === "completed" &&
                    waitingCount.execution.ok &&
                    waitingCount.execution.value === 0,
                );
                assert.equal(
                  (await post(endpoint, { response: { action: "accept" } }, { cookie, origin }))
                    .status,
                  200,
                );
                const resumed = await reviewer.callTool({
                  name: "resume",
                  arguments: { requestId: pending.requestId },
                });
                const done = Schema.decodeUnknownSync(BrowserExecutionResult)(
                  resumed.structuredContent,
                );
                assert.ok(
                  done.status === "completed" && done.execution.ok && done.execution.value === 1,
                );
                const nextWire = await reviewer.callTool({
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].mutations.write({});`,
                  },
                });
                const next = Schema.decodeUnknownSync(BrowserExecutionResult)(
                  nextWire.structuredContent,
                );
                if (next.status !== "approval-required")
                  throw new Error("Expected another browser approval");
                const nextUrl = new URL(next.approvalUrl);
                assert.equal(
                  (
                    await post(
                      `/dashboard/api/mcp/approvals/${next.requestId}${nextUrl.search}`,
                      { response: { action: "accept" } },
                      { cookie, origin },
                    )
                  ).status,
                  200,
                );
                const grantId = nextUrl.searchParams.get("grantId");
                assert.ok(grantId);
                assert.equal(
                  (await post("/api/auth/mcp/grants/revoke", { id: grantId }, { cookie, origin }))
                    .status,
                  200,
                );
                await assert.rejects(
                  reviewer.callTool({ name: "resume", arguments: { requestId: next.requestId } }),
                );
                const afterRevocation = await invoke("count");
                assert.ok(
                  afterRevocation.status === "completed" &&
                    afterRevocation.execution.ok &&
                    afterRevocation.execution.value === 1,
                );
              } finally {
                await reviewer.close();
              }
              const listed = await fetch(`${origin}/api/auth/mcp/grants`, {
                headers: { cookie, origin },
              });
              assert.equal(listed.status, 200);
              const grants = Schema.decodeUnknownSync(
                Schema.Array(
                  Schema.Struct({
                    grant: Schema.Struct({ id: Schema.String, policy: GrantPolicy }),
                  }),
                ),
              )(await listed.json());
              const target = grants.find(
                (g) => g.grant.policy.kind === "tools" && g.grant.policy.approval === "client",
              );
              assert.ok(target);
              const revoke = await post(
                "/api/auth/mcp/grants/revoke",
                { id: target.grant.id },
                { cookie, origin },
              );
              assert.equal(revoke.status, 200);
              assert.equal((await fetch(`${origin}/mcp`, { headers: bearer })).status, 401);
            } finally {
              await client.close();
            }
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);
