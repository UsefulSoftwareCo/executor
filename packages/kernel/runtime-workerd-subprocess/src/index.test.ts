import { describe, expect, it } from "@effect/vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import {
  createWorkerdModuleRunner,
  isWorkerdAvailable,
  makeWorkerdSubprocessExecutor,
  WORKERD_VERSION,
} from "./index";

class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly path: string;
  readonly cause?: unknown;
}> {}

const makeInvoker = (handlers: Record<string, (args: unknown) => unknown>): SandboxToolInvoker => ({
  invoke: ({ path, args }) => {
    const handler = handlers[path];
    if (!handler) return Effect.fail(new UnknownToolError({ path }));
    return Effect.try({
      try: () => handler(args),
      catch: (cause) => new UnknownToolError({ path, cause }),
    });
  },
});

const testDriver = (token: string): string => `
const json = (body, status = 200) => Response.json(body, { status });

const callTool = async (env, toolPath, args) => {
  const response = await env.HOST.fetch("http://host/tool", {
    method: "POST",
    headers: { "content-type": "application/json", "x-executor-token": ${JSON.stringify(token)} },
    body: JSON.stringify({ toolPath, args }),
  });
  return await response.json();
};

export default {
  async fetch(request, env) {
    if (request.url.endsWith("/__health")) return json({ ok: true, runnerToken: ${JSON.stringify(token)} });
    const input = await request.json();
    if (input.op === "echo") return json({ value: input.value });
    if (input.op === "tool") return json(await callTool(env, input.toolPath, input.args));
    if (input.op === "fetch") {
      const response = await fetch("https://example.com");
      return json({ status: response.status, text: await response.text() });
    }
    if (input.op === "timeout") {
      const timeoutMs = input.timeoutMs;
      try {
        await Promise.race([
          new Promise(() => {}),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out after " + timeoutMs + "ms")), timeoutMs)),
        ]);
      } catch (error) {
        return json({ error: error.message });
      }
    }
    return json({ error: "unknown op" }, 400);
  },
};
`;

const makeRunner = (handlers: Record<string, (args: unknown) => unknown> = {}) => {
  const token = crypto.randomUUID();
  return createWorkerdModuleRunner({
    mainModule: "driver.js",
    modules: { "driver.js": testDriver(token) },
    hostToken: token,
    toolBridge: {
      call: async (toolPath, args) => {
        const handler = handlers[toolPath];
        if (!handler) throw new Error(`unknown tool: ${toolPath}`);
        return handler(args);
      },
    },
    restartBackoffMs: 1,
  });
};

const pidIsGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const waitUntilGone = async (pid: number): Promise<boolean> => {
  // kill(pid, 0) still succeeds for an exited-but-unreaped child, so poll on a
  // real timer long enough for Node to reap it after the exit event.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pidIsGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pidIsGone(pid);
};

it("exports the pinned workerd version", () => {
  expect(WORKERD_VERSION).toBe("1.20260708.1");
});

describe.skipIf(!isWorkerdAvailable())("runtime-workerd-subprocess", () => {
  it("boots and executes a trivial module", async () => {
    const runner = makeRunner();
    try {
      const output = await runner.run<{ value: number }>({ op: "echo", value: 42 });
      expect(output.status).toBe(200);
      expect(output.body.value).toBe(42);
    } finally {
      await runner.dispose();
    }
  });

  it("round-trips tool calls through the host bridge", async () => {
    const runner = makeRunner({
      "math.add": (args) => {
        const input = args as { readonly a: number; readonly b: number };
        return { sum: input.a + input.b };
      },
    });
    try {
      const output = await runner.run<{ ok: boolean; result: unknown }>({
        op: "tool",
        toolPath: "math.add",
        args: { a: 20, b: 22 },
      });
      expect(output.body).toEqual({ ok: true, result: { sum: 42 } });
    } finally {
      await runner.dispose();
    }
  });

  it("blocks ambient fetch", async () => {
    const runner = makeRunner();
    try {
      const output = await runner.run<{ status: number; text: string }>({ op: "fetch" });
      expect(output.body.status).toBe(403);
      expect(output.body.text).toContain("Outbound fetch is blocked");
    } finally {
      await runner.dispose();
    }
  });

  it("writes generated workerd files with private permissions", async () => {
    const runner = makeRunner();
    try {
      await runner.ensureStarted();
      const tmp = runner.tempDirForTest();
      if (tmp === undefined) throw new Error("workerd temp dir was unavailable");
      expect((await stat(tmp)).mode & 0o777).toBe(0o700);
      expect((await stat(join(tmp, "driver.js"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(tmp, "config.capnp"))).mode & 0o777).toBe(0o600);
    } finally {
      await runner.dispose();
    }
  });

  it("fires the guest timeout", async () => {
    const runner = makeRunner();
    try {
      const output = await runner.run<{ error: string }>({ op: "timeout", timeoutMs: 25 }, 100);
      expect(output.body.error).toContain("Execution timed out after 25ms");
    } finally {
      await runner.dispose();
    }
  });

  it("dispose kills the process", async () => {
    const runner = makeRunner();
    await runner.ensureStarted();
    const pid = runner.pid();
    expect(pid).toEqual(expect.any(Number));
    if (pid === undefined) throw new Error("workerd pid was unavailable");
    await runner.dispose();
    expect(await waitUntilGone(pid)).toBe(true);
  });

  it("restarts after a crash", async () => {
    const runner = makeRunner();
    try {
      await runner.ensureStarted();
      const firstPid = runner.pid();
      expect(firstPid).toEqual(expect.any(Number));
      if (firstPid === undefined) throw new Error("workerd pid was unavailable");
      runner.crashForTest();
      expect(await waitUntilGone(firstPid)).toBe(true);
      const output = await runner.run<{ value: string }>({ op: "echo", value: "after" });
      expect(output.body.value).toBe("after");
      expect(runner.pid()).not.toBe(firstPid);
    } finally {
      await runner.dispose();
    }
  });

  it.effect("exports a CodeExecutor implementation", () =>
    Effect.gen(function* () {
      const executor = makeWorkerdSubprocessExecutor({ timeoutMs: 1000 });
      const output = yield* executor.execute("return 1 + 2;", makeInvoker({}));
      expect(output.result).toBe(3);
      expect(output.error).toBeUndefined();
    }),
  );
});
