// The console artifact page's transport. It has no MCP client, so it answers the
// shell's two tool calls over the executions HTTP API — which is exactly the
// path that used to surface a raw `ExecutionNotFoundError` to the user when an
// approval arrived after the pause was gone.
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { EXECUTOR_ORG_HEADER, setActiveOrgSlugOverride } from "./server-connection";
import { APPROVAL_EXPIRED_MESSAGE, createHttpShellHost } from "./shell-host";

/** The adapter's request body, read back off the wire. */
const decodeRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Records what the adapter put on the wire, so the assertions are about the
 *  request the server actually receives rather than the adapter's internals. */
const recordingFetch = (respond: (url: string) => Response) => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? decodeRequestBody(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return respond(url);
  };
  return { calls, fetch };
};

const completed = () =>
  jsonResponse({ status: "completed", text: "ok", structured: {}, isError: false });

describe("createHttpShellHost", () => {
  // Module state on the org scope: leaking a slug would silently head the
  // "no org" cases below.
  afterEach(() => {
    setActiveOrgSlugOverride(null);
  });

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

  // The prod outage this file's fix addresses. An org-scoped host (cloud) fails
  // CLOSED on a session request with no org selector — it 403s rather than
  // falling back to the session's org — so a header-less request from here made
  // every artifact tool call return `no_organization`. Asserted on all three
  // request shapes, since each built its own headers before.
  describe("the org selector header", () => {
    it("scopes execute-action to the console's org", async () => {
      setActiveOrgSlugOverride("acme");
      const { calls, fetch } = recordingFetch(completed);

      await createHttpShellHost({ fetch }).callServerTool({
        name: "execute-action",
        arguments: { code: "return 1", artifactId: "art_1" },
      });

      expect(calls[0]?.headers[EXECUTOR_ORG_HEADER]).toBe("acme");
    });

    // The approval leg: a resume that lost the scope would strand the user's
    // decision on a paused execution.
    it("scopes execute-action-resume to the console's org", async () => {
      setActiveOrgSlugOverride("acme");
      const { calls, fetch } = recordingFetch(completed);

      await createHttpShellHost({ fetch }).callServerTool({
        name: "execute-action-resume",
        arguments: { executionId: "exec_1", action: "accept", content: "{}" },
      });

      expect(calls[0]?.headers[EXECUTOR_ORG_HEADER]).toBe("acme");
    });

    it("scopes the preview upload to the console's org", async () => {
      setActiveOrgSlugOverride("acme");
      const { calls, fetch } = recordingFetch(() => jsonResponse({}));

      createHttpShellHost({ fetch }).savePreview("art_1", "data:image/png;base64,AA==");
      // savePreview is deliberately fire-and-forget, so wait for the microtask
      // that issues the request rather than a returned promise.
      await Promise.resolve();

      expect(calls[0]?.url).toContain("/artifacts/art_1/preview");
      expect(calls[0]?.headers[EXECUTOR_ORG_HEADER]).toBe("acme");
    });

    // Hosts without org scoping (local, desktop, self-host) have no slug to
    // send, and their servers would have nothing to do with one.
    it("sends no selector when the host has no org scope", async () => {
      setActiveOrgSlugOverride(null);
      const { calls, fetch } = recordingFetch(completed);

      await createHttpShellHost({ fetch }).callServerTool({
        name: "execute-action",
        arguments: { code: "return 1" },
      });

      expect(calls[0]?.headers).not.toHaveProperty(EXECUTOR_ORG_HEADER);
    });

    // The host outlives any one org: it is memoized for the page's lifetime,
    // so the scope has to be read per request, not captured at construction.
    it("follows the scope when the console switches org", async () => {
      setActiveOrgSlugOverride("acme");
      const { calls, fetch } = recordingFetch(completed);
      const host = createHttpShellHost({ fetch });

      await host.callServerTool({ name: "execute-action", arguments: { code: "return 1" } });
      setActiveOrgSlugOverride("globex");
      await host.callServerTool({ name: "execute-action", arguments: { code: "return 1" } });

      expect(calls.map((call) => call.headers[EXECUTOR_ORG_HEADER])).toStrictEqual([
        "acme",
        "globex",
      ]);
    });
  });
});
