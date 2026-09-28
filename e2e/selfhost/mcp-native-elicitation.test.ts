// Self-host native elicitation through the real Streamable HTTP transport
// (#2140). A policy gates a built-in read tool, so the test observes both
// directions on the same tools/call stream: elicitation/create reaches the
// client, and the human's decision returns to the execution engine. The last
// call answers after the MCP SDK's 60s default request timeout, the way a human
// approving on an async surface does.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const coreApi = composePluginApi([] as const);
const GATED_TOOL = "executor.coreTools.policies.list";
const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;
/** Past the MCP SDK's 60s default request timeout. */
const SLOW_HUMAN_MS = 61_000;

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

scenario(
  "MCP · native elicitation carries approval decisions on the tool call stream",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const apiClient = yield* api.client(coreApi, identity);
    const policy = yield* apiClient.policies.create({
      payload: { owner: "org", pattern: GATED_TOOL, action: "require_approval" },
    });
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    yield* Effect.gen(function* () {
      let decision: "accept" | "decline" = "accept";
      let answerAfterMs = 0;
      let elicitationCount = 0;
      const client = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const connectedClient = new Client(
            { name: "executor-selfhost-native-elicitation-e2e", version: "1.0.0" },
            { capabilities: { elicitation: { form: {}, url: {} } } },
          );
          connectedClient.setRequestHandler(ElicitRequestSchema, async () => {
            elicitationCount += 1;
            await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
            return decision === "accept"
              ? { action: "accept" as const, content: {} }
              : { action: decision };
          });
          const url = new URL(mcp.url);
          url.searchParams.set("elicitation_mode", "native");
          url.searchParams.set("artifacts", "false");
          await connectedClient.connect(
            new StreamableHTTPClientTransport(url, {
              requestInit: { headers: { authorization: `Bearer ${bearer}` } },
            }),
          );
          return connectedClient;
        }),
        (connectedClient) => Effect.promise(() => connectedClient.close()),
      );
      const callGated = (timeout: number) =>
        Effect.promise(() =>
          client.callTool({ name: "execute", arguments: { code: GATED_CODE } }, undefined, {
            timeout,
          }),
        );

      const accepted = yield* callGated(30_000);
      expect(elicitationCount, "the native elicitation reached the client").toBe(1);
      expect(accepted.isError, "accepting lets the gated tool complete").toBeFalsy();
      expect(
        JSON.stringify(accepted.content),
        "the gated tool returned its policy listing",
      ).toContain(policy.id);

      decision = "decline";
      const declined = yield* callGated(30_000);
      expect(elicitationCount, "the second native elicitation also reached the client").toBe(2);
      expect(declined.isError, "declining blocks the gated tool").toBe(true);
      expect(
        JSON.stringify(declined.content),
        "the engine reports the client's decline decision",
      ).toContain("declined by the user");

      decision = "accept";
      answerAfterMs = SLOW_HUMAN_MS;
      const slow = yield* callGated(SLOW_HUMAN_MS + 30_000);
      expect(elicitationCount, "the slow approval reached the client").toBe(3);
      expect(slow.isError, "an approval answered after 60s still completes the call").toBeFalsy();
      expect(
        JSON.stringify(slow.content),
        "the slowly approved tool returned its policy listing",
      ).toContain(policy.id);
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
