// When OAuth integration setup fails — malformed discovery metadata, a broken
// authorization server — the sandbox must see the typed failure's own message
// (`oauth_probe_error` / `oauth_start_error` with the discovery cause), never
// the scrubbed "Internal tool error [hex]" defect.
//
// Regression guard for the swallowed-cause report in #1330: `oauth.probe` and
// `oauth.start` against a broken server used to reach agents only as
// "Internal tool error [id]", with the real OAuthProbeError/OAuthStartError
// cause visible solely in the daemon log. The user-actionable error contract
// now carries the authored message across the tool-dispatch boundary.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([mcpHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`;

/** A server whose every response is 200 with a non-JSON body: RFC 9728/8414
 *  discovery reaches it fine and then fails on malformed metadata — the "the
 *  provider is broken, tell me HOW" case. */
const serveBrokenMetadata = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("this is not metadata{");
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
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

/** Run `execute`, auto-approving any paused (approval-gated) calls, and parse
 *  the sandbox's JSON return value. */
const executeJson = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", { code });
    let guard = 0;
    while (result.text.includes("executionId:") && guard < 10) {
      result = yield* session.approvePaused(result.text);
      guard += 1;
    }
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return JSON.parse(result.text) as {
      readonly ok: boolean;
      readonly code?: string;
      readonly message?: string;
    };
  });

const probeCode = (url: string) => `
const result = await tools.executor.coreTools.oauth.probe({ url: ${JSON.stringify(url)} });
return result.ok
  ? { ok: true }
  : { ok: false, code: result.error.code, message: result.error.message };
`;

const startCode = (input: {
  readonly client: string;
  readonly integration: string;
  readonly connection: string;
}) => `
const started = await tools.executor.coreTools.oauth.start({
  client: ${JSON.stringify(input.client)},
  clientOwner: "org",
  owner: "org",
  name: ${JSON.stringify(input.connection)},
  integration: ${JSON.stringify(input.integration)},
  template: "oauth2",
});
return started.ok
  ? { ok: true, status: started.data.status }
  : { ok: false, code: started.error.code, message: started.error.message };
`;

// ---------------------------------------------------------------------------
// oauth.probe — a broken discovery endpoint reports WHAT failed.
// ---------------------------------------------------------------------------

scenario(
  "OAuth setup · a failed oauth.probe surfaces the discovery cause, not an opaque internal error",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const session = mcp.session(identity);
      const broken = yield* serveBrokenMetadata();

      yield* session.listTools();
      const result = yield* executeJson(session, probeCode(`${broken.url}/mcp`));

      expect(result.ok, "the probe against broken metadata fails").toBe(false);
      expect(result.code, "the failure carries the typed probe code").toBe("oauth_probe_error");
      expect(
        result.message,
        "the failure names the discovery problem, so the caller can act on it",
      ).toContain("metadata is malformed");
      expect(result.message, "the opaque defect mask is not used").not.toContain(
        "Internal tool error",
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// oauth.start — a scope-discovery failure reports its cause chain.
// ---------------------------------------------------------------------------

scenario(
  "OAuth setup · a failed oauth.start scope discovery surfaces its cause, not an opaque internal error",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const session = mcp.session(identity);
      const client = yield* makeApiClient(api, identity);
      const broken = yield* serveBrokenMetadata();

      // An OAuth2 MCP integration with NO declared scopes: `oauth.start` must
      // discover them from the server's metadata — which is broken.
      const slug = unique("oauth-cause-mcp");
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Broken-metadata MCP",
          endpoint: `${broken.url}/mcp`,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        client.mcp
          .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      );

      const clientSlug = OAuthClientSlug.make(unique("oauth-cause-app"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: `${broken.url}/authorize`,
          tokenUrl: `${broken.url}/token`,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: `${broken.url}/mcp`,
        },
      });
      yield* Effect.addFinalizer(() =>
        client.oauth
          .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      );

      yield* session.listTools();
      const result = yield* executeJson(
        session,
        startCode({ client: String(clientSlug), integration: slug, connection: "main" }),
      );

      expect(result.ok, "the start against broken metadata fails").toBe(false);
      expect(result.code, "the failure carries the typed start code").toBe("oauth_start_error");
      expect(result.message, "the failure names the scope-discovery step that broke").toContain(
        "Failed to discover OAuth scopes",
      );
      expect(result.message, "the failure carries the discovery cause beneath it").toContain(
        "metadata is malformed",
      );
      expect(result.message, "the opaque defect mask is not used").not.toContain(
        "Internal tool error",
      );
    }),
  ),
);
