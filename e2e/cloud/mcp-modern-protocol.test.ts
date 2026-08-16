import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { isInputRequiredResult } from "@modelcontextprotocol/client";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import {
  callModernToolWithInputRequired,
  connectModernMcpClient,
  MODERN_MCP_PROTOCOL_VERSION,
  modernToolText,
  readModernMcpAuthChallenge,
} from "../src/surfaces/modern-mcp";
import type { Identity } from "../src/target";

const coreApi = composePluginApi([] as const);
const LEGACY_PROTOCOL_VERSION = "2025-03-26";
const JSON_AND_SSE = "application/json, text/event-stream";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const legacyInitialize = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-modern-e2e-control", version: "1.0.0" },
  },
};

const postLegacy = (
  url: string,
  body: unknown,
  options?: { readonly bearer?: string; readonly sessionId?: string },
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: JSON_AND_SSE,
      "content-type": "application/json",
      "mcp-protocol-version": LEGACY_PROTOCOL_VERSION,
      ...(options?.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...(options?.sessionId ? { "mcp-session-id": options.sessionId } : {}),
    },
    body: JSON.stringify(body),
  });

scenario(
  "MCP modern protocol · a pinned 2026 client discovers, lists, and executes while legacy isolation stays intact",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const bearer = yield* mcp.mintBearer(emailOf(identity));
      const client = yield* connectModernMcpClient({
        url: target.mcpUrl,
        bearer,
        mode: { pin: MODERN_MCP_PROTOCOL_VERSION },
      });

      expect(client.getProtocolEra(), "the pinned client selected the modern era").toBe("modern");
      expect(client.getNegotiatedProtocolVersion(), "the exact revision was selected").toBe(
        MODERN_MCP_PROTOCOL_VERSION,
      );
      expect(
        client.getDiscoverResult()?.supportedVersions,
        "server/discover advertises the pinned revision",
      ).toContain(MODERN_MCP_PROTOCOL_VERSION);

      const tools = yield* Effect.promise(() => client.listTools());
      expect(
        tools.tools.map((tool) => tool.name),
        "the modern catalog advertises Executor's execute tool",
      ).toContain("execute");

      const result = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: "return 6 * 7;" } }),
      );
      expect(result.isError, "the modern execute call completes successfully").not.toBe(true);
      expect(modernToolText(result), "the sandbox result crosses the modern wire").toBe("42");

      const foreignSession = yield* Effect.promise(() =>
        postLegacy(
          target.mcpUrl,
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          { bearer, sessionId: `foreign-${randomUUID()}` },
        ),
      );
      expect(
        foreignSession.status,
        "a foreign legacy session id remains a clean not-found response",
      ).toBe(404);
      const foreignBody = (yield* Effect.promise(() => foreignSession.json())) as {
        readonly error?: { readonly code?: number; readonly message?: string };
      };
      expect(foreignBody.error?.code, "the legacy rejection remains a JSON-RPC error").toBe(-32001);
      expect(
        foreignBody.error?.message,
        "the unknown legacy session stays a clean not-found error",
      ).toBe("Session not found");

      const [modernChallenge, legacyChallenge] = yield* Effect.all([
        readModernMcpAuthChallenge(target.mcpUrl),
        Effect.promise(() => postLegacy(target.mcpUrl, legacyInitialize)),
      ]);
      expect(modernChallenge.status, "the unauthenticated modern probe is challenged").toBe(401);
      expect(legacyChallenge.status, "the unauthenticated legacy initialize is challenged").toBe(
        401,
      );
      expect(
        modernChallenge.wwwAuthenticate,
        "modern and legacy entry paths publish the same Bearer challenge",
      ).toBe(legacyChallenge.headers.get("www-authenticate"));
    }),
  ),
);

scenario(
  "MCP modern protocol · a default v2 auto client probes Executor and selects modern",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const bearer = yield* mcp.mintBearer(emailOf(identity));
      const client = yield* connectModernMcpClient({
        url: target.mcpUrl,
        bearer,
        mode: "auto",
      });

      expect(client.getProtocolEra(), "auto negotiation selected the modern path").toBe("modern");
      expect(client.getNegotiatedProtocolVersion(), "auto selected the current revision").toBe(
        MODERN_MCP_PROTOCOL_VERSION,
      );
      expect(
        client.getDiscoverResult()?.supportedVersions,
        "the probe result records the server's modern offer",
      ).toContain(MODERN_MCP_PROTOCOL_VERSION);
      expect(
        (yield* Effect.promise(() => client.listTools())).tools.map((tool) => tool.name),
        "the selected path is usable",
      ).toContain("execute");
    }),
  ),
);

scenario(
  "MCP modern protocol · native input_required resumes an approval-gated execution",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const api = yield* makeApiClient(coreApi, identity);
      const bearer = yield* mcp.mintBearer(emailOf(identity));
      const pattern = `modern-native-${randomBytes(4).toString("hex")}.*`;
      const code = `
const result = await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(pattern)},
  action: "block",
});
return JSON.stringify(result);
`;

      const cleanup = api.policies.list().pipe(
        Effect.flatMap((policies) =>
          Effect.forEach(
            policies.filter((policy) => policy.pattern === pattern),
            (policy) =>
              api.policies
                .remove({ params: { policyId: policy.id }, payload: { owner: "user" } })
                .pipe(Effect.ignore),
          ),
        ),
        Effect.ignore,
      );

      yield* Effect.gen(function* () {
        const nativeUrl = new URL(target.mcpUrl);
        nativeUrl.searchParams.set("elicitation_mode", "native");
        const client = yield* connectModernMcpClient({
          url: nativeUrl.toString(),
          bearer,
          mode: { pin: MODERN_MCP_PROTOCOL_VERSION },
          manualInputRequired: true,
        });

        const first = yield* callModernToolWithInputRequired(client, {
          name: "execute",
          arguments: { code },
        });
        expect(isInputRequiredResult(first), "the gated action requests native input").toBe(true);
        if (!isInputRequiredResult(first)) return;
        expect(
          first.inputRequests?.elicitation,
          "the pause carries an elicitation request",
        ).toMatchObject({ method: "elicitation/create" });
        expect(first.requestState, "the continuation state is opaque and present").toEqual(
          expect.any(String),
        );

        const completed = yield* callModernToolWithInputRequired(client, {
          name: "execute",
          arguments: { code },
          inputResponses: { elicitation: { action: "accept", content: {} } },
          requestState: first.requestState,
        });
        expect(isInputRequiredResult(completed), "the accepted round completes").toBe(false);
        if (isInputRequiredResult(completed)) return;
        expect(completed.isError, "the resumed execution succeeds").not.toBe(true);
        expect(
          modernToolText(completed),
          "the tool result returns after the second round",
        ).toContain('"ok":true');

        expect(
          (yield* api.policies.list()).map((policy) => policy.pattern),
          "the approved side effect ran",
        ).toContain(pattern);
      }).pipe(Effect.ensuring(cleanup));
    }),
  ),
);
