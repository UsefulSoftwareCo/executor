// Local-only — the MCP BROWSER-APPROVAL flow, the gap a code review found:
// `resume.$executionId.tsx` POSTed to the bearer-gated `/api/mcp-sessions/*`
// with no Authorization header, so standalone-web approvals 401'd. The existing
// approval scenario (selfhost/mcp-approve.test.ts) approves PROGRAMMATICALLY via
// the MCP `resume` tool (auth on the API path), so it never drives the browser
// page and could not catch this. This drives the real page in a real browser.
//
// Flow: boot `executor web --foreground` → create a require_approval policy on a
// built-in tool → an MCP client (bearer) executes that tool with
// elicitation_mode=browser → the server returns a paused `approvalUrl` → open it
// in the browser (with the `?_token` bootstrap) → click Approve → the MCP
// `resume` call completes. Plus a negative: the approval endpoint 401s without
// the bearer.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { withLocalServer } from "./local-server";

const coreApi = composePluginApi([] as const);

// A built-in, read-only tool to gate (same target the selfhost approval test
// uses) — calling it under a require_approval policy forces the elicitation.
const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";
const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

scenario(
  "Local · MCP browser approval: a gated execution resumes after the human approves in the browser",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();

    yield* withLocalServer(cli, runDir, (server) =>
      Effect.gen(function* () {
        // Bearer-authed typed API client (local has no session cookie — the
        // credential is the printed token). Used only to plant the policy.
        const api = yield* HttpApiClient.make(coreApi, {
          baseUrl: new URL("/api", server.origin).toString(),
          transformClient: HttpClient.mapRequest((request) =>
            HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
          ),
        }).pipe(Effect.provide(FetchHttpClient.layer));

        yield* api.policies.create({
          payload: { owner: "org", pattern: APPROVAL_TARGET_TOOL, action: "require_approval" },
        });

        yield* browser.session(identity, async ({ page, step }) => {
          // MCP client over the wire with the bearer (local /mcp is bearer-gated,
          // not OAuth — so the raw SDK transport with an Authorization header,
          // not mcporter's PKCE flow). elicitation_mode=browser makes the server
          // mint an approval URL instead of a model-side pause.
          const mcp = new Client(
            { name: "e2e-local-approve", version: "1.0.0" },
            { capabilities: {} },
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(`${server.origin}/mcp?elicitation_mode=browser`),
            { requestInit: { headers: { authorization: `Bearer ${server.token}` } } },
          );
          await mcp.connect(transport);

          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the test owns the MCP transport lifecycle
          try {
            const executed = await mcp.callTool({
              name: "execute",
              arguments: { code: EXECUTE_CODE },
            });
            const paused = executed.structuredContent as {
              status: string;
              executionId: string;
              approvalUrl: string;
            };
            expect(paused.status, "execute paused for browser approval").toBe(
              "user_approval_required",
            );
            expect(typeof paused.approvalUrl).toBe("string");

            // The real human flow: approve in the browser FIRST. The page POSTs
            // the decision to the bearer-gated /api/mcp-sessions/* endpoint (the
            // path bug #2 left unauthenticated) — that just records the decision.
            // Calling the MCP `resume` tool first would un-pause the engine and
            // the page's getPaused would find nothing, so order matters.
            await step("Open the approval URL and approve in the browser", async () => {
              const approval = new URL(paused.approvalUrl);
              approval.searchParams.set("_token", server.token); // bootstrap the bearer
              await page.goto(approval.toString(), { waitUntil: "domcontentloaded" });
              await page.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30_000 });
              // The page loaded the paused execution (bearer-authed) — not the
              // "unavailable" error branch a getPaused 401/404 would render.
              // (Playwright's toBeVisible matcher isn't in vitest's expect.)
              expect(
                await page.getByText("This paused execution is no longer available").count(),
                "approval page loaded the paused execution, not the unavailable branch",
              ).toBe(0);
              await page.getByRole("button", { name: "Approve" }).click();
              // "Approve sent" only renders if the POST returned 200 — i.e. the
              // bearer reached the gated endpoint. Pre-fix it 401'd and stuck.
              await page.getByText("Approve sent").waitFor({ timeout: 15_000 });
            });

            // The agent's `resume` now picks up the recorded approval and the
            // engine finishes.
            const resumed = await mcp.callTool({
              name: "resume",
              arguments: { executionId: paused.executionId },
            });
            const resumedStructured = resumed.structuredContent as { status: string };
            expect(
              resumedStructured.status,
              "the MCP resume completed once the browser approved (bearer reached the gated endpoint)",
            ).toBe("completed");

            await step("The approval endpoint rejects a request with no bearer", async () => {
              const unauthed = await fetch(
                `${server.origin}/api/mcp-sessions/${encodeURIComponent(
                  paused.executionId,
                )}/executions/${encodeURIComponent(paused.executionId)}/resume?approval_token=x`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "accept" }),
                },
              );
              expect(unauthed.status, "no bearer → 401 at the shell gate").toBe(401);
            });
          } finally {
            await mcp.close();
          }
        });
      }),
    );
  }),
);
