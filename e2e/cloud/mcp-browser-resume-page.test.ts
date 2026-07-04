// Cloud: browser-mode MCP approval must let the resume page load the paused
// execution from the approval URL the MCP tool returned.
//
// This drives the user-reported path without mcporter:
//   1. A real StreamableHTTP MCP session runs with ?elicitation_mode=browser.
//   2. A gated execute call returns approvalUrl and executionId.
//   3. The cloud resume page's API GET loads that paused execution by
//      mcp_session_id and executionId.
//   4. Posting the browser approval lets the model-side browser resume tool
//      consume the decision and complete the gated call.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { parseBrowserApproval } from "../src/surfaces/mcp";
import type { Identity } from "../src/target";

const coreApi = composePluginApi([] as const);

const GATE_TOOL = "executor.coreTools.policies.list";
const UNAVAILABLE_COPY = "This paused execution is no longer available";

const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

type Connected = {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const textOf = (result: unknown): string =>
  (
    ((result as { readonly content?: unknown }).content ?? []) as ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
    }>
  )
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

const openBrowserApprovalSession = async (mcpUrl: string, bearer: string): Promise<Connected> => {
  const url = new URL(mcpUrl);
  url.searchParams.set("elicitation_mode", "browser");
  const client = new Client(
    { name: "executor-e2e-browser-resume", version: "0.0.1" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return { client, transport };
};

const closeQuietly = (connected: Connected): Effect.Effect<void> =>
  Effect.promise(() => connected.client.close().catch(() => undefined));

const pathWithSearch = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const authenticatedFetch = (
  identity: Identity,
  input: URL,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(input, {
    ...init,
    headers: {
      ...(identity.headers ?? {}),
      ...(init.headers ?? {}),
    },
  });

scenario(
  "MCP approval · browser resume page loads the paused execution from its approval URL",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const api = yield* apiClient(coreApi, identity);

    const policy = yield* api.policies.create({
      payload: { owner: "org", pattern: GATE_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = yield* Effect.promise(() =>
        openBrowserApprovalSession(target.mcpUrl, bearer),
      );
      yield* Effect.gen(function* () {
        const paused = yield* Effect.promise(() =>
          session.client.callTool({ name: "execute", arguments: { code: GATED_CODE } }),
        );
        const approval = parseBrowserApproval({
          raw: paused,
          text: textOf(paused),
          ok: paused.isError !== true,
        });

        const approvalUrl = new URL(approval.approvalUrl);
        const mcpSessionId = approvalUrl.searchParams.get("mcp_session_id");
        expect(
          mcpSessionId,
          "approval URL carries the MCP session id that the resume page will query",
        ).toEqual(expect.any(String));
        expect(mcpSessionId, "approval URL points at the session that paused").toBe(
          session.transport.sessionId,
        );

        const pausedApiUrl = new URL(
          `/api/mcp-sessions/${encodeURIComponent(mcpSessionId ?? "")}/executions/${encodeURIComponent(approval.executionId)}`,
          target.baseUrl,
        );
        const pausedResponse = yield* Effect.promise(() =>
          authenticatedFetch(identity, pausedApiUrl),
        );
        const pausedBody = yield* Effect.promise(() => pausedResponse.text());
        expect(
          pausedResponse.status,
          `resume page paused-execution GET response: ${pausedBody}`,
        ).toBe(200);

        const resumeApiUrl = new URL(`${pausedApiUrl.pathname}/resume`, target.baseUrl);
        const resumeResponse = yield* Effect.promise(() =>
          authenticatedFetch(identity, resumeApiUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: new URL(target.baseUrl).origin,
            },
            body: JSON.stringify({ action: "accept", content: {} }),
          }),
        );
        const resumeBody = yield* Effect.promise(() => resumeResponse.text());
        expect(resumeResponse.status, `resume page approval POST response: ${resumeBody}`).toBe(
          200,
        );
        expect(JSON.parse(resumeBody), "resume page approval POST body").toMatchObject({
          status: "completed",
          structured: { status: "approved", executionId: approval.executionId },
          isError: false,
        });

        const resumed = yield* Effect.promise(() =>
          session.client.callTool({
            name: "resume",
            arguments: { executionId: approval.executionId },
          }),
        );
        expect(resumed.isError, "browser-mode resume consumes the page decision").not.toBe(true);
        expect(textOf(resumed), "the gated tool completed after approval").toContain(policy.id);
      }).pipe(Effect.ensuring(closeQuietly(session)));
    }).pipe(
      Effect.ensuring(
        api.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "MCP approval · browser resume page approves a paused execution through the UI",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const api = yield* apiClient(coreApi, identity);

    const policy = yield* api.policies.create({
      payload: { owner: "org", pattern: GATE_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = yield* Effect.promise(() =>
        openBrowserApprovalSession(target.mcpUrl, bearer),
      );
      yield* Effect.gen(function* () {
        const paused = yield* Effect.promise(() =>
          session.client.callTool({ name: "execute", arguments: { code: GATED_CODE } }),
        );
        const approval = parseBrowserApproval({
          raw: paused,
          text: textOf(paused),
          ok: paused.isError !== true,
        });

        const approvalUrl = new URL(approval.approvalUrl);
        const mcpSessionId = approvalUrl.searchParams.get("mcp_session_id");
        expect(
          mcpSessionId,
          "approval URL carries the MCP session id that the browser page will query",
        ).toEqual(expect.any(String));
        expect(mcpSessionId, "approval URL points at the session that paused").toBe(
          session.transport.sessionId,
        );

        const [resumed] = yield* Effect.all(
          [
            Effect.promise(() =>
              session.client.callTool({
                name: "resume",
                arguments: { executionId: approval.executionId },
              }),
            ),
            browser.session(identity, async ({ page, step }) => {
              await step("Open the paused execution approval page", async () => {
                await page.goto(pathWithSearch(approval.approvalUrl), { waitUntil: "networkidle" });
                await page.getByText("User approval required").waitFor();
              });

              await step("Review the paused tool call details", async () => {
                await page.getByText("Pending request").waitFor();
                await page.getByText(/Approve executor\.coreTools\.policies\.list\?/).waitFor();

                const approve = page.getByRole("button", { name: "Approve" });
                await approve.waitFor();
                expect(
                  await approve.isEnabled(),
                  "the approve control is enabled for the paused execution",
                ).toBe(true);
                expect(
                  await page.getByText(UNAVAILABLE_COPY).count(),
                  "the resume page does not show the expired-session failure copy",
                ).toBe(0);
              });

              await step("Approve the paused tool call", async () => {
                await page.getByRole("button", { name: "Approve" }).click();
                await page.getByText("Approve sent").waitFor();
              });
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(resumed.isError, "browser-mode resume completed after the UI approval").not.toBe(
          true,
        );
        expect(textOf(resumed), "the gated tool completed after approval").toContain(policy.id);
      }).pipe(Effect.ensuring(closeQuietly(session)));
    }).pipe(
      Effect.ensuring(
        api.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
