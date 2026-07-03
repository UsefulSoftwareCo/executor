import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const api = composePluginApi([toolkitsPlugin()] as const);

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const allowedCode = `
const result = await tools.executor.coreTools.integrations.list({});
if (!result.ok) throw new Error(result.error.message);
return result.data.integrations.map((integration) => integration.slug).includes("executor");
`;

const blockedCode = `
const result = await tools.executor.coreTools.policies.list({});
if (!result.ok) throw new Error(result.error.message);
return result.data.policies.length;
`;

const initializeSession = async (url: string, bearer: string): Promise<string> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "toolkit-e2e", version: "1" },
      },
    }),
  });
  expect(response.status, "toolkit initialize succeeds").toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId, "initialize returns a session id").toEqual(expect.any(String));
  return sessionId!;
};

const callToolsListWithSession = async (
  url: string,
  bearer: string,
  sessionId: string,
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });

scenario(
  "Toolkits · self-host MCP exposes only the toolkit's allowed tools",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const suffix = randomBytes(4).toString("hex");

    const toolkit = yield* client.toolkits.create({
      payload: {
        owner: "org",
        name: `toolkits-e2e-${suffix}`,
      },
    });

    yield* Effect.gen(function* () {
      yield* client.toolkits.createConnection({
        params: { toolkitId: toolkit.id },
        payload: {
          pattern: "executor.*",
        },
      });
      yield* client.toolkits.createPolicy({
        params: { toolkitId: toolkit.id },
        payload: {
          pattern: "executor.coreTools.integrations.list",
          action: "approve",
        },
      });
      yield* client.toolkits.createPolicy({
        params: { toolkitId: toolkit.id },
        payload: {
          pattern: "executor.coreTools.policies.list",
          action: "block",
        },
      });

      // Self-host advertises the BARE MCP path (no org prefix — see the
      // host-selfhost __root shell and `toolkitUrlFor`, which only prefixes a
      // slug when one is present, i.e. on cloud). A made-up `/e2e-org` prefix is
      // a cloud-shaped URL self-host never serves as canonical: the server's
      // RFC 9728 protected-resource doc reports the bare resource, and MCP SDK
      // 1.29's `selectResourceURL` rejects the prefix/bare mismatch. Connect to
      // the URL self-host actually publishes.
      const toolkitUrl = new URL(`/mcp/toolkits/${toolkit.slug}`, target.baseUrl).toString();
      const toolkitSession = mcp.session(identity, { url: toolkitUrl });
      const toolkitTools = yield* toolkitSession.listTools();
      expect(toolkitTools, "the toolkit endpoint still advertises execute").toContain("execute");

      const allowed = yield* toolkitSession.call("execute", { code: allowedCode });
      expect(allowed.ok, `allowed toolkit tool call succeeds; response:\n${allowed.text}`).toBe(
        true,
      );
      expect(allowed.text, "allowed call returns the integration result").toContain("true");

      const blocked = yield* toolkitSession.call("execute", { code: blockedCode });
      expect(blocked.ok, `blocked toolkit tool call fails; response:\n${blocked.text}`).toBe(false);
      expect(blocked.text, "blocked call explains that the tool is unavailable").toMatch(
        /blocked|not found|not available/i,
      );

      const normalSession = mcp.session(identity);
      const normal = yield* normalSession.call("execute", { code: blockedCode });
      expect(normal.ok, "normal MCP is not scoped by the toolkit rules").toBe(true);

      const bearer = yield* mcp.mintBearer(emailOf(identity));
      const sessionId = yield* Effect.promise(() => initializeSession(toolkitUrl, bearer));
      const reusedOnDefault = yield* Effect.promise(() =>
        callToolsListWithSession(target.mcpUrl, bearer, sessionId),
      );
      expect(reusedOnDefault.status, "toolkit session id cannot be reused on /mcp").toBe(403);
    }).pipe(
      Effect.ensuring(
        client.toolkits.remove({ params: { toolkitId: toolkit.id } }).pipe(Effect.ignore),
      ),
    );
  }),
);
