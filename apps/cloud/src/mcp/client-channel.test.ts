import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createClientChannelState,
  clientChannelBelongsToPrincipal,
  filterClientManifestResponse,
  routeClientRequest,
} from "./client-channel";
import {
  dispatchClientInvocation,
  resolveClientInvocationResponse,
  type PendingClientInvocation,
} from "./client-channel-durable-object";

describe("durable MCP client routing", () => {
  it("clears pending invocation state when WebSocket send throws", async () => {
    const pending = new Map<string, PendingClientInvocation>();
    await expect(
      dispatchClientInvocation(
        pending,
        "binding-a:1",
        {
          send: () => {
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: the WebSocket adapter must exercise its synchronous send-failure path
            throw new Error("socket is closed");
          },
        },
        "tools/call",
        { name: "tool" },
      ),
    ).rejects.toThrow("Client invocation delivery failed");
    expect(pending.size).toBe(0);
  });

  it("correlates client responses only to their server-issued binding and request", async () => {
    let resolveResult: (value: unknown) => void = () => {};
    let rejectResult: (reason: Error) => void = () => {};
    const pending = new Map([
      [
        "binding-a:1",
        {
          resume: (effect: Effect.Effect<unknown, unknown>) => {
            void Effect.runPromise(effect).then(resolveResult, rejectResult);
          },
        },
      ],
    ]);
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    expect(
      resolveClientInvocationResponse(pending, "binding-b", {
        id: "binding-a:1",
        result: { content: [] },
      }),
    ).toBe(false);
    expect(
      resolveClientInvocationResponse(pending, "binding-a", {
        id: "binding-a:1",
        result: { content: [{ type: "text", text: "response" }] },
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({
      content: [{ type: "text", text: "response" }],
    });
    expect(pending.size).toBe(0);
  });

  it("isolates A/B same-name capabilities and standard list keys", () => {
    const state = createClientChannelState();
    const clientA = state.register(
      { accountId: "u", organizationId: "org" },
      {
        tools: [{ name: "shared", description: "A" }],
        resources: [{ uri: "client://a" }],
        prompts: [{ name: "prompt-a" }],
      },
    );
    const clientB = state.register(
      { accountId: "u", organizationId: "org" },
      {
        tools: [{ name: "shared", description: "B" }],
        resources: [{ uri: "client://b" }],
        prompts: [{ name: "prompt-b" }],
      },
    );
    expect(typeof clientA).toBe("string");
    expect(typeof clientB).toBe("string");
    if (typeof clientA !== "string" || typeof clientB !== "string") return;
    expect(clientA).not.toBe(clientB);
    expect(
      routeClientRequest(state, clientA, 0, {
        method: "tools/call",
        params: { name: "shared" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      routeClientRequest(state, clientA, 0, {
        method: "resources/read",
        params: { uri: "client://b" },
      }),
    ).toMatchObject({ ok: false, error: "manifest_denied" });
    expect(
      routeClientRequest(state, clientA, 0, {
        method: "prompts/get",
        params: { name: "prompt-b" },
      }),
    ).toMatchObject({ ok: false, error: "manifest_denied" });
    expect(
      filterClientManifestResponse(state, clientA, "tools/list", {
        result: { tools: [{ name: "shared", description: "A" }, { name: "other" }] },
      }),
    ).toEqual({ result: { tools: [{ name: "shared", description: "A" }] } });
  });

  it("denies cross-tenant routing and stale generations after restore", () => {
    const state = createClientChannelState();
    const binding = state.register(
      { accountId: "u", organizationId: "org" },
      {
        tools: [],
        resources: [{ uri: "file://secret" }],
        prompts: [{ name: "alpha" }],
      },
    );
    expect(typeof binding).toBe("string");
    if (typeof binding !== "string") return;
    const restored = createClientChannelState(state.snapshot());
    expect(
      routeClientRequest(restored, binding, 0, {
        method: "resources/read",
        params: { uri: "file://secret" },
        principal: { accountId: "forged", organizationId: "org" },
      }),
    ).toMatchObject({ ok: false, error: "client_identity_forbidden" });
    expect(
      routeClientRequest(restored, binding, 99, {
        method: "tools/list",
      }),
    ).toMatchObject({ ok: false });
    expect(
      routeClientRequest(restored, binding, 0, {
        method: "prompts/get",
        params: { name: "alpha" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("filters standard resource and prompt list results", () => {
    const state = createClientChannelState();
    const binding = state.register(
      { accountId: "u", organizationId: "org" },
      {
        tools: [],
        resources: [{ uri: "client://one" }],
        prompts: [{ name: "client_prompt" }],
      },
    );
    expect(typeof binding).toBe("string");
    if (typeof binding !== "string") return;
    expect(
      filterClientManifestResponse(state, binding, "resources/list", {
        result: { resources: [{ uri: "client://one" }, { uri: "private://two" }] },
      }),
    ).toEqual({ result: { resources: [{ uri: "client://one" }] } });
    expect(
      filterClientManifestResponse(state, binding, "prompts/list", {
        result: { prompts: [{ name: "client_prompt" }, { name: "private_prompt" }] },
      }),
    ).toEqual({ result: { prompts: [{ name: "client_prompt" }] } });
  });

  it("requires a newly issued binding after reconnect", () => {
    const state = createClientChannelState();
    const manifest = { tools: [{ name: "alpha" }], resources: [], prompts: [] };
    const oldBinding = state.register({ accountId: "u", organizationId: "org" }, manifest);
    expect(typeof oldBinding).toBe("string");
    if (typeof oldBinding !== "string") return;
    state.disconnect(oldBinding);
    const newBinding = state.register({ accountId: "u", organizationId: "org" }, manifest);
    expect(newBinding).not.toBe(oldBinding);
    expect(routeClientRequest(state, oldBinding, 0, { method: "tools/list" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects a binding authenticated for another tenant", () => {
    const state = createClientChannelState();
    const binding = state.register(
      { accountId: "user-a", organizationId: "org-a" },
      {
        tools: [],
        resources: [],
        prompts: [],
      },
    );
    expect(typeof binding).toBe("string");
    if (typeof binding !== "string") return;
    const identity = state.get(binding) ?? null;
    expect(
      clientChannelBelongsToPrincipal(identity, {
        accountId: "user-b",
        organizationId: "org-a",
      }),
    ).toBe(false);
  });
});
