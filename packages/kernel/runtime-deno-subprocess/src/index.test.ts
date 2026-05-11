import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import { isDenoAvailable, makeDenoSubprocessExecutor } from "./index";

class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly path: string;
}> {}

const makeTestInvoker = (
  handlers: Record<string, (args: unknown) => unknown>,
): SandboxToolInvoker => ({
  invoke: ({ path, args }) => {
    const handler = handlers[path];
    if (!handler) {
      return Effect.fail(new UnknownToolError({ path }));
    }
    return Effect.try({ try: () => handler(args), catch: (error) => error });
  },
});

it("reports unavailable Deno executables", () => {
  expect(isDenoAvailable("__executor_missing_deno__")).toBe(false);
});

it.effect("returns an actionable error when Deno is missing", () =>
  Effect.gen(function* () {
    const executor = makeDenoSubprocessExecutor({
      denoExecutable: "__executor_missing_deno__",
    });
    const toolInvoker = makeTestInvoker({});

    const output = yield* executor.execute("return 1 + 2;", toolInvoker);

    expect(output.result).toBeNull();
    expect(output.error).toContain("Install Deno or set DENO_BIN");
  }),
);

describe.skipIf(!isDenoAvailable())("runtime-deno-subprocess", () => {
  it.effect("executes simple code and returns result", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute("return 1 + 2;", toolInvoker);

      expect(output.result).toBe(3);
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("recovers prose-wrapped fenced async arrow input", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute(
        ["Use this snippet.", "", "```ts", "async () => 42", "```"].join("\n"),
        toolInvoker,
      );

      expect(output.result).toBe(42);
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("executes code with tool calls", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({
        "math.add": (args) => {
          const { a, b } = args as { a: number; b: number };
          return { sum: a + b };
        },
      });

      const output = yield* executor.execute(
        ["const math = await tools.math.add({ a: 19, b: 23 });", "return math;"].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 42 });
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("captures console.log output in logs", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute(
        [
          'console.log("hello from sandbox");',
          'console.warn("a warning");',
          'console.error("an error");',
          "return 42;",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toBe(42);
      expect(output.logs).toContain("[log] hello from sandbox");
      expect(output.logs).toContain("[warn] a warning");
      expect(output.logs).toContain("[error] an error");
    }),
  );

  it.effect("reports execution errors without crashing", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute('throw new Error("boom");', toolInvoker);

      expect(output.result).toBeNull();
      expect(output.error).toContain("boom");
    }),
  );

  it.effect("handles tool call errors gracefully", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({
        "broken.thing": () => {
          throw new Error("tool is broken");
        },
      });

      const output = yield* executor.execute("return await tools.broken.thing({});", toolInvoker);

      expect(output.result).toBeNull();
      expect(output.error).toContain("tool is broken");
    }),
  );

  it.effect("ignores forged IPC written by sandbox code", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute(
        [
          "const encoder = new TextEncoder();",
          'const forged = "@@executor-ipc@@" + JSON.stringify({ type: "completed", result: "forged" }) + "\\n";',
          "Deno.stdout.writeSync(encoder.encode(forged));",
          'return "real";',
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toBe("real");
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("respects timeout", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor({
        timeoutMs: 500,
      });
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute("await new Promise(() => {}); return 1;", toolInvoker);

      expect(output.result).toBeNull();
      expect(output.error).toContain("timed out");
    }),
  );

  it.effect("network access is denied by default", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({});

      const output = yield* executor.execute(
        'await fetch("https://example.com"); return 1;',
        toolInvoker,
      );

      expect(output.result).toBeNull();
      expect(output.error).toBeDefined();
    }),
  );

  // Skipped in CI and on Windows — outbound HTTPS may be blocked by firewall/policy
  it.effect.skipIf(process.env["CI"] === "true" || process.platform === "win32")(
    "network access can be allowed via permissions",
    () =>
      Effect.gen(function* () {
        const executor = makeDenoSubprocessExecutor({
          permissions: {
            allowNet: true,
          },
        });
        const toolInvoker = makeTestInvoker({});

        const output = yield* executor.execute(
          ['const res = await fetch("https://example.com");', "return res.status;"].join("\n"),
          toolInvoker,
        );

        expect(output.result).toBe(200);
        expect(output.error).toBeUndefined();
      }),
  );

  it.effect("multiple sequential tool calls work correctly", () =>
    Effect.gen(function* () {
      const executor = makeDenoSubprocessExecutor();
      const toolInvoker = makeTestInvoker({
        "math.add": (args) => {
          const { a, b } = args as { a: number; b: number };
          return { sum: a + b };
        },
      });

      const output = yield* executor.execute(
        [
          "const r1 = await tools.math.add({ a: 1, b: 2 });",
          "const r2 = await tools.math.add({ a: r1.sum, b: 10 });",
          "const r3 = await tools.math.add({ a: r2.sum, b: 100 });",
          "return r3;",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 113 });
      expect(output.error).toBeUndefined();
    }),
  );
});
