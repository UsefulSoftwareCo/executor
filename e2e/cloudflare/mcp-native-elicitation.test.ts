// Cloudflare self-host native elicitation through the real Streamable HTTP
// transport. A policy gates a built-in read tool, so the test observes both
// directions on the same tools/call stream: elicitation/create reaches the
// client, and accept/decline decisions return to the execution engine.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const coreApi = composePluginApi([] as const);
const GATED_TOOL = "executor.coreTools.policies.list";
const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

scenario(
  "Cloudflare · native MCP elicitation carries approval decisions on the tool call stream",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const apiClient = yield* api.client(coreApi, identity);
    const policy = yield* apiClient.policies.create({
      payload: { owner: "org", pattern: GATED_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      let decision: "accept" | "decline" | "cancel" = "accept";
      let elicitationCount = 0;
      const client = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const connectedClient = new Client(
            { name: "executor-cloudflare-native-elicitation-e2e", version: "1.0.0" },
            { capabilities: { elicitation: { form: {}, url: {} } } },
          );
          connectedClient.setRequestHandler(ElicitRequestSchema, async () => {
            elicitationCount += 1;
            return decision === "accept"
              ? { action: "accept" as const, content: {} }
              : { action: decision };
          });
          const url = new URL(mcp.url);
          url.searchParams.set("elicitation_mode", "native");
          await connectedClient.connect(new StreamableHTTPClientTransport(url));
          return connectedClient;
        }),
        (connectedClient) => Effect.promise(() => connectedClient.close()),
      );

      const accepted = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: GATED_CODE } }, undefined, {
          timeout: 10_000,
        }),
      );
      expect(elicitationCount, "the native elicitation reached the client").toBe(1);
      expect(accepted.isError, "accepting lets the gated tool complete").toBeFalsy();
      expect(
        JSON.stringify(accepted.content),
        "the gated tool returned its policy listing",
      ).toContain(policy.id);

      decision = "decline";
      const declined = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: GATED_CODE } }, undefined, {
          timeout: 10_000,
        }),
      );
      expect(elicitationCount, "the second native elicitation also reached the client").toBe(2);
      expect(declined.isError, "declining blocks the gated tool").toBe(true);
      expect(
        JSON.stringify(declined.content),
        "the engine reports the client's decline decision",
      ).toContain("declined by the user");
      expect(
        JSON.stringify(declined.content),
        "the declined tool did not return its output",
      ).not.toContain(policy.id);

      decision = "cancel";
      const cancelled = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: GATED_CODE } }, undefined, {
          timeout: 10_000,
        }),
      );
      expect(elicitationCount, "the cancel elicitation also reached the client").toBe(3);
      expect(cancelled.isError, "cancelling blocks the gated tool").toBe(true);
      expect(
        JSON.stringify(cancelled.content),
        "the engine reports the client's cancel decision",
      ).toContain("cancelled by the user");
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        apiClient.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
