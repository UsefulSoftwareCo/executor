import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import { makeQuickJsExecutor } from "./index";

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
    return Effect.try({
      try: () => handler(args),
      catch: (error) => error,
    });
  },
});

const executor = makeQuickJsExecutor({ timeoutMs: 5_000 });

describe("quickjs executor", () => {
  it.effect("runs plain code", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute(`return 1 + 2`, makeTestInvoker({}));
      expect(result.result).toBe(3);
      expect(result.error).toBeUndefined();
    }),
  );

  it.effect("recovers prose-wrapped fenced async arrow input", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute(
        ["Use this snippet.", "", "```ts", "async () => 42", "```"].join("\n"),
        makeTestInvoker({}),
      );

      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    }),
  );

  it.effect("invokes a tool and returns its result", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({
        "math.add": (args) => {
          const { a, b } = args as { a: number; b: number };
          return { sum: a + b };
        },
      });

      const result = yield* executor.execute(
        `
        const res = await tools.math.add({ a: 5, b: 3 });
        return res.sum;
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe(8);
    }),
  );

  it.effect("invokes multiple tools in sequence", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({
        "users.get": (args) => {
          const { id } = args as { id: number };
          return { id, name: `User ${id}` };
        },
        "users.greet": (args) => {
          const { name } = args as { name: string };
          return { message: `Hello, ${name}!` };
        },
      });

      const result = yield* executor.execute(
        `
        const user = await tools.users.get({ id: 42 });
        const greeting = await tools.users.greet({ name: user.name });
        return greeting.message;
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe("Hello, User 42!");
    }),
  );

  it.effect("handles tool errors", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({
        "db.query": () => {
          throw new Error("connection refused");
        },
      });

      const result = yield* executor.execute(
        `
        try {
          await tools.db.query({ sql: "SELECT 1" });
          return "should not reach";
        } catch (e) {
          return "caught: " + e.message;
        }
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toContain("caught:");
    }),
  );

  it.effect("handles unknown tool path", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({});

      const result = yield* executor.execute(
        `
        try {
          await tools.nonexistent.thing({ x: 1 });
          return "should not reach";
        } catch (e) {
          return "caught: " + e.message;
        }
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toContain("caught:");
    }),
  );

  it.effect("captures console.log output", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute(
        `
        console.log("hello from sandbox");
        console.warn("a warning");
        return "done";
        `,
        makeTestInvoker({}),
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe("done");
      expect(result.logs).toContainEqual("[log] hello from sandbox");
      expect(result.logs).toContainEqual("[warn] a warning");
    }),
  );

  it.effect("applies a memory limit by default", () =>
    Effect.gen(function* () {
      const defaultExecutor = makeQuickJsExecutor({ timeoutMs: 5_000 });

      const result = yield* defaultExecutor.execute(
        `
        return new ArrayBuffer(128 * 1024 * 1024).byteLength;
        `,
        makeTestInvoker({}),
      );

      expect(result.result).toBeNull();
      expect(result.error).toBeDefined();
    }),
  );

  it.effect("passes tool result into next tool call", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({
        "stripe.customers.list": () => ({
          data: [
            { id: "cus_1", email: "alice@example.com" },
            { id: "cus_2", email: "bob@example.com" },
          ],
        }),
        "stripe.invoices.create": (args) => {
          const { customer, amount } = args as { customer: string; amount: number };
          return { id: "inv_1", customer, amount };
        },
      });

      const result = yield* executor.execute(
        `
        const customers = await tools.stripe.customers.list();
        const invoice = await tools.stripe.invoices.create({
          customer: customers.data[0].id,
          amount: 5000,
        });
        return invoice;
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        id: "inv_1",
        customer: "cus_1",
        amount: 5000,
      });
    }),
  );
});
