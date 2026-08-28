// Repro for #1555: "Local HTTP MCP native elicitation times out before reaching
// client". The Cloudflare counterpart (cloudflare/mcp-native-elicitation.test.ts,
// green since #1522) proves the reverse request routes on the originating
// tools/call stream there. This is the same scenario against the LOCAL daemon's
// HTTP MCP endpoint, which the report says never delivers `elicitation/create`
// and fails with McpNativeElicitationTransportError / -32001 request timed out.
//
// Same shape as the local browser-approval scenario (a require_approval policy
// on a built-in read tool), but with `elicitation_mode=native` and a client that
// advertises `capabilities.elicitation.form` and answers the request in-band —
// so no browser is needed, only the raw SDK transport with the bearer.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const coreApi = composePluginApi([] as const);

const GATED_TOOL = "executor.coreTools.policies.list";
const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

scenario(
  "Local · native MCP elicitation carries approval decisions on the tool call stream",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    yield* withLocalServer(cli, runDir, (server) =>
      Effect.gen(function* () {
        // Bearer-authed typed API client (local's credential is the printed
        // token) — used only to plant the gating policy.
        const api = yield* HttpApiClient.make(coreApi, {
          baseUrl: new URL("/api", server.origin).toString(),
          transformClient: HttpClient.mapRequest((request) =>
            HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
          ),
        }).pipe(Effect.provide(FetchHttpClient.layer));

        const policy = yield* api.policies.create({
          payload: { owner: "org", pattern: GATED_TOOL, action: "require_approval" },
        });

        yield* Effect.gen(function* () {
          let decision: "accept" | "decline" | "cancel" = "accept";
          let elicitationCount = 0;
          const client = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const connectedClient = new Client(
                { name: "e2e-local-native-elicitation", version: "1.0.0" },
                { capabilities: { elicitation: { form: {}, url: {} } } },
              );
              connectedClient.setRequestHandler(ElicitRequestSchema, async () => {
                elicitationCount += 1;
                return decision === "accept"
                  ? { action: "accept" as const, content: {} }
                  : { action: decision };
              });
              const url = new URL(`${server.origin}/mcp`);
              url.searchParams.set("elicitation_mode", "native");
              url.searchParams.set("artifacts", "false");
              await connectedClient.connect(
                new StreamableHTTPClientTransport(url, {
                  requestInit: { headers: { authorization: `Bearer ${server.token}` } },
                }),
              );
              return connectedClient;
            }),
            (connectedClient) => Effect.promise(() => connectedClient.close()),
          );

          const accepted = yield* Effect.promise(() =>
            client.callTool({ name: "execute", arguments: { code: GATED_CODE } }, undefined, {
              timeout: 30_000,
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
              timeout: 30_000,
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
              timeout: 30_000,
            }),
          );
          expect(elicitationCount, "the cancel elicitation also reached the client").toBe(3);
          expect(cancelled.isError, "cancelling blocks the gated tool").toBe(true);
          expect(
            JSON.stringify(cancelled.content),
            "the engine reports the client's cancel decision",
          ).toContain("cancelled by the user");
        }).pipe(Effect.scoped);
      }),
    );
  }),
);
