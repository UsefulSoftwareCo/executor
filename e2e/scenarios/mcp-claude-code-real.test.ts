// Cross-target client compatibility with the REAL pinned Claude Code binary.
// Executor and MCP stay real. Only Anthropic Messages inference is replaced by
// a deterministic loopback replay transcript.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Billing, ClaudeCode, Mcp, RunDir, Target } from "../src/services";
import { serveAnthropicReplayBrain } from "../src/clients/anthropic-replay-brain";
import { expectedClaudeCodeVersion } from "../src/clients/claude-code";
import { writeClaudeCodeEvidence } from "../src/clients/claude-code-evidence";

const SERVER_NAME = "executor";
const api = composePluginApi([openApiHttpPlugin()] as const);

const executeBrain = (code: string) =>
  serveAnthropicReplayBrain((context) =>
    context.lastToolResult
      ? { text: `executor-result:${context.lastToolResult}` }
      : { tool: { name: "execute", input: { code } } },
  );

const integrationsCode = `
const result = await tools.executor.coreTools.integrations.list({});
if (!result.ok) return result;
return result.data.integrations.map((integration) => integration.slug);
`;

const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Claude account marker", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

scenario(
  "Claude Code · the real client discovers Executor MCP and invokes execute",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const claude = yield* ClaudeCode;
      const runDir = yield* RunDir;
      const identity = yield* target.newIdentity();
      const bearer = yield* mcp.mintBearer(identity);
      const home = claude.makeHome(SERVER_NAME, {
        url: target.mcpUrl,
        authorizationHeader: `Bearer ${bearer}`,
      });

      yield* Effect.gen(function* () {
        const brain = yield* executeBrain("return 6 * 7;");
        const result = yield* claude.run(home, {
          brainBaseUrl: brain.baseUrl,
          prompt: "Use Executor to calculate six times seven.",
        });
        yield* Effect.sync(() =>
          writeClaudeCodeEvidence(runDir, {
            label: "execute-discovery",
            executable: home.binaryPath,
            expectedVersion: expectedClaudeCodeVersion(),
            observedVersion: result.claudeCodeVersion,
            durationMs: result.durationMs,
            status: "success",
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
            structuredResult: result.result,
            mcpServerName: SERVER_NAME,
            mcpOrigin: target.mcpUrl,
            replayOrigin: brain.baseUrl,
            replayRequestPaths: brain.requests().map((request) => request.path),
            replayErrors: brain.errors(),
            secrets: [bearer],
          }),
        );

        expect(result.result, "Claude returns Executor's real tool result").toContain("42");
        expect(
          brain
            .requests()
            .some((request) => request.toolNames.some((name) => name.endsWith("__execute"))),
          "Claude discovered Executor's execute tool through MCP",
        ).toBe(true);
        expect(
          brain
            .requests()
            .flatMap((request) => request.messages)
            .flatMap((message) => message.toolResults)
            .some((toolResult) => toolResult.content.includes("42")),
          "Claude returned the MCP tool result to the model boundary",
        ).toBe(true);
        expect(brain.errors()).toEqual([]);
      }).pipe(Effect.ensuring(Effect.sync(() => claude.removeHome(home))));
    }),
  ),
);

scenario(
  "Claude Code · replacing one MCP server name switches accounts without cache bleed",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      yield* Billing;
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const claude = yield* ClaudeCode;
      const runDir = yield* RunDir;
      const accountA = yield* target.newIdentity();
      const accountB = yield* target.newIdentity();
      const clientA = yield* makeClient(api, accountA);
      const clientB = yield* makeClient(api, accountB);
      const suffix = randomBytes(4).toString("hex");
      const markerA = IntegrationSlug.make(`claude-account-a-${suffix}`);
      const markerB = IntegrationSlug.make(`claude-account-b-${suffix}`);

      yield* clientA.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: pingSpec },
          slug: markerA,
          authenticationTemplate: [],
        },
      });
      yield* clientB.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: pingSpec },
          slug: markerB,
          authenticationTemplate: [],
        },
      });

      const cleanup = Effect.all(
        [
          clientA.openapi.removeSpec({ params: { slug: markerA } }).pipe(Effect.ignore),
          clientB.openapi.removeSpec({ params: { slug: markerB } }).pipe(Effect.ignore),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);

      yield* Effect.gen(function* () {
        const bearerA = yield* mcp.mintBearer(accountA);
        const bearerB = yield* mcp.mintBearer(accountB);
        const home = claude.makeHome(SERVER_NAME, {
          url: target.mcpUrl,
          authorizationHeader: `Bearer ${bearerA}`,
        });

        yield* Effect.gen(function* () {
          const brainA = yield* executeBrain(integrationsCode);
          const first = yield* claude.run(home, {
            brainBaseUrl: brainA.baseUrl,
            prompt: "List the integration slugs visible to the current Executor account.",
          });
          yield* Effect.sync(() =>
            writeClaudeCodeEvidence(runDir, {
              label: "account-a-before-switch",
              executable: home.binaryPath,
              expectedVersion: expectedClaudeCodeVersion(),
              observedVersion: first.claudeCodeVersion,
              durationMs: first.durationMs,
              status: "success",
              exitCode: 0,
              stdout: first.stdout,
              stderr: first.stderr,
              structuredResult: first.result,
              mcpServerName: SERVER_NAME,
              mcpOrigin: target.mcpUrl,
              replayOrigin: brainA.baseUrl,
              replayRequestPaths: brainA.requests().map((request) => request.path),
              replayErrors: brainA.errors(),
              secrets: [bearerA, bearerB],
            }),
          );
          expect(first.result, "account A sees its own marker").toContain(markerA);
          expect(first.result, "account A cannot see account B's marker").not.toContain(markerB);
          expect(brainA.errors()).toEqual([]);

          yield* claude.replaceServer(home, {
            url: target.mcpUrl,
            authorizationHeader: `Bearer ${bearerB}`,
          });

          const brainB = yield* executeBrain(integrationsCode);
          const second = yield* claude.run(home, {
            brainBaseUrl: brainB.baseUrl,
            prompt: "List the integration slugs after switching the Executor account.",
          });
          yield* Effect.sync(() =>
            writeClaudeCodeEvidence(runDir, {
              label: "account-b-after-switch",
              executable: home.binaryPath,
              expectedVersion: expectedClaudeCodeVersion(),
              observedVersion: second.claudeCodeVersion,
              durationMs: second.durationMs,
              status: "success",
              exitCode: 0,
              stdout: second.stdout,
              stderr: second.stderr,
              structuredResult: second.result,
              mcpServerName: SERVER_NAME,
              mcpOrigin: target.mcpUrl,
              replayOrigin: brainB.baseUrl,
              replayRequestPaths: brainB.requests().map((request) => request.path),
              replayErrors: brainB.errors(),
              secrets: [bearerA, bearerB],
            }),
          );
          expect(second.result, "account B sees its own marker").toContain(markerB);
          expect(second.result, "Claude did not reuse account A's cached grant").not.toContain(
            markerA,
          );
          expect(brainB.errors()).toEqual([]);
        }).pipe(Effect.ensuring(Effect.sync(() => claude.removeHome(home))));
      }).pipe(Effect.ensuring(cleanup));
    }),
  ),
);
