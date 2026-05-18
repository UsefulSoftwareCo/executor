import { describe, expect, it } from "@effect/vitest";

import { JsonRpcRequestIdQueue, PREVIOUS_REQUEST_TIMEOUT_MS } from "./mcp-worker-transport";

const jsonRpcRequest = (body: unknown): Request =>
  new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("JsonRpcRequestIdQueue", () => {
  it("serialises requests with the same id", async () => {
    const queue = new JsonRpcRequestIdQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      const firstRunning = new Promise<void>((release) => {
        releaseFirst = release;
      });
      queue.run(jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }), async () => {
        order.push("first:start");
        resolve();
        await firstRunning;
        order.push("first:end");
      });
    });

    await firstStarted;

    const secondDone = queue.run(
      jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      async () => {
        order.push("second");
      },
    );

    // Second must wait for first.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await secondDone;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not block requests with different ids", async () => {
    const queue = new JsonRpcRequestIdQueue();
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });

    queue.run(jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }), () => hung);

    const otherDone = await Promise.race([
      queue
        .run(jsonRpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/call" }), async () => "done")
        .then((v) => ({ kind: "settled" as const, v })),
      new Promise<{ kind: "blocked" }>((r) => setTimeout(() => r({ kind: "blocked" }), 200)),
    ]);

    expect(otherDone.kind).toBe("settled");
    release();
  });

  it("does not let a waiting resume block an unrelated same-id tool call", async () => {
    const queue = new JsonRpcRequestIdQueue();
    let releaseResume!: () => void;
    const hungResume = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });

    const resumeStarted = new Promise<void>((resolve) => {
      queue.run(
        jsonRpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "resume", arguments: { executionId: "exec_1" } },
        }),
        async () => {
          resolve();
          await hungResume;
        },
      );
    });
    await resumeStarted;

    const executeDone = await Promise.race([
      queue
        .run(
          jsonRpcRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "execute", arguments: { code: "return 1" } },
          }),
          async () => "done",
        )
        .then((v) => ({ kind: "settled" as const, v })),
      new Promise<{ kind: "blocked" }>((r) => setTimeout(() => r({ kind: "blocked" }), 200)),
    ]);

    expect(executeDone.kind).toBe("settled");
    releaseResume();
  });

  it("serialises same-id resume calls for the same execution", async () => {
    const queue = new JsonRpcRequestIdQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      const firstRunning = new Promise<void>((release) => {
        releaseFirst = release;
      });
      queue.run(
        jsonRpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "resume", arguments: { executionId: "exec_1" } },
        }),
        async () => {
          order.push("first:start");
          resolve();
          await firstRunning;
          order.push("first:end");
        },
      );
    });
    await firstStarted;

    const secondDone = queue.run(
      jsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "resume", arguments: { executionId: "exec_1" } },
      }),
      async () => {
        order.push("second");
      },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await secondDone;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("regression: caps wait on a hung previous request and dispatches anyway", async () => {
    // Override the timeout for fast CI — the production default is
    // PREVIOUS_REQUEST_TIMEOUT_MS (60s) which we cap test-side to 100ms.
    // Same behaviour, same code path; only the wall-clock budget changes.
    const queue = new JsonRpcRequestIdQueue({ previousTimeoutMs: 100 });
    const order: string[] = [];

    // Kick off a request and never release it — the poisoned-queue
    // shape that used to cascade for the full upstream 180s timeout.
    const firstStarted = new Promise<void>((resolve) => {
      queue.run(jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }), async () => {
        order.push("first:start");
        resolve();
        await new Promise(() => undefined); // hang forever
      });
    });
    await firstStarted;

    const result = await queue.run(
      jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      async () => {
        order.push("second");
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(order).toEqual(["first:start", "second"]);
  });

  it("exposes a sane production timeout", () => {
    // Sanity guard: must stay below the 180s upstream timeout that
    // Claude / Cowork enforce, but be long enough to outlast a normal
    // dynamic-worker execution under load.
    expect(PREVIOUS_REQUEST_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(PREVIOUS_REQUEST_TIMEOUT_MS).toBeLessThan(180_000);
  });
});
