// The console artifact page's transport. It has no MCP client, so it answers the
// shell's two tool calls over the executions HTTP API — which is exactly the
// path that used to surface a raw `ExecutionNotFoundError` to the user when an
// approval arrived after the pause was gone.
import { describe, expect, it } from "@effect/vitest";

import { APPROVAL_EXPIRED_MESSAGE, createHttpShellHost } from "./shell-host";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Records what the adapter put on the wire, so the assertions are about the
 *  request the server actually receives rather than the adapter's internals. */
const recordingFetch = (respond: (url: string) => Response) => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return respond(url);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe("createHttpShellHost", () => {
  it("maps execute-action onto POST /executions, carrying the artifact id", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ status: "completed", text: "ok", structured: { result: 1 }, isError: false }),
    );
    const host = createHttpShellHost({ fetch });

    const result = await host.callServerTool({
      name: "execute-action",
      arguments: { code: "return await tools.a.b()", artifactId: "art_1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/executions");
    expect(calls[0]?.body).toStrictEqual({ code: "return await tools.a.b()", artifactId: "art_1" });
    expect(result.isError).toBeUndefined();
  });

  it("maps execute-action-resume onto the execution's resume route", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ status: "completed", text: "ok", structured: {}, isError: false }),
    );
    const host = createHttpShellHost({ fetch });

    await host.callServerTool({
      name: "execute-action-resume",
      arguments: { executionId: "exec_1", action: "accept", content: '{"note":"hi"}' },
    });

    expect(calls[0]?.url).toContain("/executions/exec_1/resume");
    expect(calls[0]?.body).toStrictEqual({ action: "accept", content: { note: "hi" } });
  });

  // The reported bug's user-visible half: the approval failed and the person
  // clicking Approve got a JSON-RPC envelope wrapping an internal error tag.
  it("reports an expired approval as a next action, not a raw server error", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ _tag: "ApprovalExpiredError", executionId: "exec_1" }, 410),
    );
    const host = createHttpShellHost({ fetch });

    await expect(
      host.callServerTool({
        name: "execute-action-resume",
        arguments: { executionId: "exec_1", action: "accept", content: "{}" },
      }),
    ).rejects.toThrow(APPROVAL_EXPIRED_MESSAGE);
  });

  it("does not disguise other failures as an expired approval", async () => {
    const { fetch } = recordingFetch(() => new Response("upstream exploded", { status: 500 }));
    const host = createHttpShellHost({ fetch });

    await expect(
      host.callServerTool({ name: "execute-action", arguments: { code: "return 1" } }),
    ).rejects.toThrow("upstream exploded");
  });

  // A malformed body must not lose the user's decision — the action still has to
  // reach the server so the paused execution gets an answer.
  it("still sends the decision when the resume content will not parse", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ status: "completed", text: "ok", structured: {}, isError: false }),
    );
    const host = createHttpShellHost({ fetch });

    await host.callServerTool({
      name: "execute-action-resume",
      arguments: { executionId: "exec_1", action: "decline", content: "{not json" },
    });

    // `content` is absent rather than null: an unparseable body is dropped, but
    // the decision still travels.
    expect(calls[0]?.body).toStrictEqual({ action: "decline" });
  });
});
