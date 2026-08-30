// Cross-target: the dynamic tool-call contract over MCP — the exact envelope
// an agent sees when it calls a tool, misaddresses one, or has its approval
// declined. The invoke path resolves several storage reads per call (tool row,
// policy rules, connection row, credentials, integration row); this pins the
// externally observable guarantees that must hold no matter how those reads
// are scheduled internally:
//
//   1. A well-addressed call on a live connection reaches the upstream and
//      returns its payload.
//   2. A wrong tool name fails with `tool_not_found` and suggests the
//      connection's real tools; a wrong connection name and a call after the
//      connection was removed fail with the same shape — never the opaque
//      "Internal tool error" defect mask.
//   3. An approval-gated call that the user DECLINES is never executed: the
//      upstream sees no request, and credential resolution never starts — the
//      authorization server records no refresh grant, even when the stored
//      token is expired and an executed call would have had to refresh. The
//      counterfactual (the same call approved) proves the refresh was real
//      work the decline suppressed, not an assertion that would pass vacuously.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

type UpstreamHandle = {
  readonly url: string;
  /** How many times the route was actually served — the ground truth for
   *  "this call executed" / "this call never executed". */
  readonly requests: () => number;
};

/** Upstream on 127.0.0.1 that answers `GET <route>` with `payload` for any
 *  caller and records every hit. */
const serveUpstream = (route: string, payload: unknown) =>
  Effect.acquireRelease(
    Effect.callback<UpstreamHandle & { readonly close: () => void }>((resume) => {
      let hits = 0;
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith(route)) {
          hits += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            requests: () => hits,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const invokeByAddressCode = (address: string, args: unknown) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node(${JSON.stringify(args)});
return JSON.stringify(result);
`;

/** The ToolResult envelope every sandbox tool call resolves to. */
type ToolEnvelope = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: {
      readonly path?: string;
      readonly suggestions?: readonly string[];
    };
  };
};

/** Run `execute`, auto-approving any paused execution, and require the MCP
 *  call itself to complete (the tool call inside may still be `ok: false`). */
const executeApproved = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", { code });
    let guard = 0;
    while (result.text.includes("executionId:") && guard < 10) {
      result = yield* session.approvePaused(result.text);
      guard += 1;
    }
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return result.text;
  });

/** Invoke a dynamic tool by full address and parse the envelope it returns. */
const invokeEnvelope = (session: McpSession, address: string, args: unknown = {}) =>
  Effect.map(
    executeApproved(session, invokeByAddressCode(address, args)),
    (text) => JSON.parse(text) as ToolEnvelope,
  );

// ---------------------------------------------------------------------------
// 1 + 2: success and the not-found error identity.
// ---------------------------------------------------------------------------

/** OpenAPI 3 spec with one no-auth operation (no securitySchemes ⇒ the
 *  integration is no-auth, so a `template: "none"` connection can call it). */
const widgetsSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Widgets API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          summary: "List widgets",
          responses: { "200": { description: "widgets" } },
        },
      },
    },
  });

/** Create the no-auth connection through the gateway core tool — the same
 *  programmatic wire-up an agent performs. */
const createConnectionCode = (slug: string) => `
const created = await tools.executor.coreTools.connections.create({
  owner: "org",
  name: "public",
  integration: ${JSON.stringify(slug)},
  template: "none",
});
return JSON.stringify(created.ok ? { ok: true } : { ok: false, error: created.error });
`;

scenario(
  "Tool calls · a live tool answers, and every misaddressed call fails with tool_not_found, never an internal error",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream("/widgets", {
        widgets: [{ id: 1, name: "anvil" }],
      });
      const slug = unique("toolcall");
      const session = mcp.session(identity);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: widgetsSpec(upstream.url) },
              slug,
              baseUrl: upstream.url,
            },
          });
          const created = JSON.parse(
            yield* executeApproved(session, createConnectionCode(slug)),
          ) as ToolEnvelope;
          expect(created.ok, `the no-auth connection was created: ${JSON.stringify(created)}`).toBe(
            true,
          );

          const tools = yield* client.tools.list({ query: {} });
          const address = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((addr) => addr.endsWith("listWidgets"));
          expect(address, "the listWidgets tool is in the catalog").toBeDefined();
          const path = address!.replace(/^tools\./, "");

          // 1. A well-addressed call executes and carries the upstream's payload.
          const success = yield* invokeEnvelope(session, address!);
          expect(
            success.ok,
            `the call succeeded (got: ${JSON.stringify(success.error ?? {}).slice(0, 400)})`,
          ).toBe(true);
          expect(JSON.stringify(success.data), "the upstream's payload comes back").toContain(
            "anvil",
          );
          expect(upstream.requests(), "the upstream served exactly one call").toBe(1);

          // 2a. A wrong TOOL name on a live connection: tool_not_found, and the
          // suggestions name the connection's real tools so the agent can
          // self-correct.
          const wrongTool = address!.replace(/listWidgets$/, "makeWidget");
          const notFound = yield* invokeEnvelope(session, wrongTool);
          expect(notFound.ok, "a wrong tool name fails").toBe(false);
          expect(notFound.error?.code, "the failure is identified as tool_not_found").toBe(
            "tool_not_found",
          );
          expect(notFound.error?.message ?? "", "the message names the problem").toContain(
            "Tool not found",
          );
          expect(notFound.error?.details?.path, "the failing path is a structured field").toBe(
            wrongTool.replace(/^tools\./, ""),
          );
          expect(
            notFound.error?.details?.suggestions ?? [],
            "the connection's real tool is suggested",
          ).toContain(path);

          // 2b. A wrong CONNECTION name: same identity — tool_not_found.
          const ghost = yield* invokeEnvelope(session, address!.replace(".public.", ".ghost."));
          expect(ghost.ok, "a wrong connection name fails").toBe(false);
          expect(ghost.error?.code, "an unknown connection reports tool_not_found").toBe(
            "tool_not_found",
          );

          // 2c. The connection is REMOVED: the previously working address now
          // fails with the same identifiable shape — never the scrubbed
          // "Internal tool error [id]" defect mask.
          yield* client.connections.remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("public"),
            },
          });
          const gone = yield* invokeEnvelope(session, address!);
          expect(gone.ok, "a call on a removed connection fails").toBe(false);
          expect(
            gone.error?.code,
            `a missing connection reports tool_not_found (got: ${JSON.stringify(gone.error ?? {}).slice(0, 400)})`,
          ).toBe("tool_not_found");
          expect(
            gone.error?.message ?? "",
            "the defect mask never surfaces for a missing connection",
          ).not.toContain("Internal tool error");

          expect(upstream.requests(), "no misaddressed call ever reached the upstream").toBe(1);
        }),
        // Selfhost shares one workspace identity — leaked resources fail other
        // scenarios' zero-state assertions.
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: ConnectionName.make("public"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// 3: a declined approval leaves the call unexecuted — and never even starts
// credential resolution.
// ---------------------------------------------------------------------------

const issuesSpec = (
  baseUrl: string,
  oauth: {
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
  },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Issues API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          summary: "List issues",
          security: [{ oauth: ["issues.read"] }],
          responses: { "200": { description: "issues" } },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: { "issues.read": "Read issues" },
            },
          },
        },
      },
    },
  });

scenario(
  "Tool calls · a declined approval leaves the call unexecuted and never touches the credential",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream("/issues", {
        issues: [{ id: 1, title: "first" }],
      });
      // Instantly-expiring access tokens: any EXECUTED call must first redeem
      // a refresh grant at the AS. That makes credential resolution itself
      // observable from the AS's request ledger — the signal that must stay
      // at zero for a declined call.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["issues.read"],
        tokenExpiresInSeconds: 0,
      });
      const slug = unique("declined");
      const clientSlug = OAuthClientSlug.make(unique("declinedc"));
      const pattern = `${slug}.*`;

      const refreshGrants = Effect.map(
        oauth.requests,
        (requests) =>
          requests.filter(
            (request) =>
              request.path === "/token" &&
              request.method === "POST" &&
              request.body.includes("grant_type=refresh_token"),
          ).length,
      );

      const cleanup = Effect.gen(function* () {
        const policies = yield* client.policies.list();
        yield* Effect.forEach(
          policies.filter((policy) => policy.pattern === pattern),
          (policy) =>
            client.policies
              .remove({
                params: { policyId: policy.id },
                payload: { owner: "org" },
              })
              .pipe(Effect.ignore),
        );
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("main"),
            },
          })
          .pipe(Effect.ignore);
        yield* client.oauth
          .removeClient({
            params: { slug: clientSlug },
            payload: { owner: "org" },
          })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }).pipe(Effect.ignore);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: issuesSpec(upstream.url, oauth) },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "oauth",
                  kind: "oauth2",
                  authorizationUrl: oauth.authorizationEndpoint,
                  tokenUrl: oauth.tokenEndpoint,
                  scopes: ["issues.read"],
                },
              ],
            },
          });
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: clientSlug,
              grant: "authorization_code",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              clientId: "test-client",
              clientSecret: "test-secret",
              originIntegration: IntegrationSlug.make(slug),
            },
          });

          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("oauth"),
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");

          // Drive the test IdP's consent by hand (authorize → login → code).
          const code = yield* Effect.promise(async () => {
            const authorize = await fetch(started.authorizationUrl, {
              redirect: "manual",
            });
            const loginUrl = authorize.headers.get("location");
            if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
            const login = await fetch(loginUrl, {
              method: "POST",
              headers: {
                authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
              },
              redirect: "manual",
            });
            const callbackUrl = login.headers.get("location");
            if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
            const minted = new URL(callbackUrl).searchParams.get("code");
            if (!minted) throw new Error("callback carried no authorization code");
            return minted;
          });
          yield* client.oauth.complete({
            payload: { state: started.state, code },
          });

          const tools = yield* client.tools.list({ query: {} });
          const address = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((addr) => addr.endsWith("listIssues"));
          expect(address, "the listIssues tool is in the catalog").toBeDefined();

          // Gate every tool of this integration behind human approval. The
          // pattern is unique per run, so a leak cannot gate another scenario.
          yield* client.policies.create({
            payload: { owner: "org", pattern, action: "require_approval" },
          });

          const session = mcp.session(identity);
          const grantsBefore = yield* refreshGrants;

          const paused = yield* session.call("execute", {
            code: invokeByAddressCode(address!, {}),
          });
          expect(
            paused.text,
            `the gated call paused for approval (got: ${paused.text.slice(0, 400)})`,
          ).toContain("Execution paused");
          const match = /\bexecutionId:\s*(\S+)/.exec(paused.text);
          expect(match, "the paused result carries an executionId").not.toBeNull();

          // While paused, NOTHING has run: the upstream saw no request and —
          // although the stored token is expired, so an executing call would
          // have to refresh first — the AS recorded no refresh grant. The
          // approval gate sits before credential resolution.
          expect(upstream.requests(), "the upstream saw nothing while the call was paused").toBe(0);
          expect(
            yield* refreshGrants,
            "credential resolution did not start while the call was paused",
          ).toBe(grantsBefore);

          const declined = yield* session.call("resume", {
            executionId: match![1],
            action: "decline",
          });
          expect(
            declined.text.toLowerCase(),
            `the declined resume tells the agent the approval was refused (got: ${declined.text.slice(0, 400)})`,
          ).toContain("declined");

          expect(upstream.requests(), "a declined call never reached the upstream").toBe(0);
          expect(
            yield* refreshGrants,
            "a declined call never redeemed a refresh grant — credential resolution never started",
          ).toBe(grantsBefore);

          // Counterfactual: the SAME call, approved, refreshes and executes —
          // proving the zeros above measured real work the decline suppressed.
          let approved = yield* session.call("execute", {
            code: invokeByAddressCode(address!, {}),
          });
          let guard = 0;
          while (approved.text.includes("executionId:") && guard < 10) {
            approved = yield* session.approvePaused(approved.text);
            guard += 1;
          }
          expect(
            approved.ok,
            `the approved execute completed (got: ${approved.text.slice(0, 400)})`,
          ).toBe(true);
          const envelope = JSON.parse(approved.text) as ToolEnvelope;
          expect(
            envelope.ok,
            `the approved call succeeded (got: ${JSON.stringify(envelope.error ?? {}).slice(0, 400)})`,
          ).toBe(true);
          expect(upstream.requests(), "the approved call reached the upstream exactly once").toBe(
            1,
          );
          expect(
            yield* refreshGrants,
            "the approved call is the one that redeemed a refresh grant",
          ).toBe(grantsBefore + 1);
        }),
        cleanup,
      );
    }),
  ),
);
