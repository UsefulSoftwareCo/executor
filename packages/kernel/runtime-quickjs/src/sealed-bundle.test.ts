import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { executeSealedBundle } from "./index";

// The sealed-bundle entry: a self-contained program in, one string out, with
// nothing of the host reachable from inside. The artifact smoke render is its
// caller, but nothing here knows that — these are the primitive's own promises.

const run = (options: Parameters<typeof executeSealedBundle>[0]) =>
  Effect.runPromise(
    executeSealedBundle(options).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    ),
  );

describe("executeSealedBundle", () => {
  it("returns what the call resolves", async () => {
    const result = await run({
      bundle: "globalThis.greet = (name) => Promise.resolve('hello ' + name);",
      call: "globalThis.greet('world')",
    });
    expect(result).toEqual({ ok: true, value: "hello world" });
  });

  it("reports a throw from the bundle itself", async () => {
    const result = await run({ bundle: "throw new Error('bundle is broken');", call: "'unused'" });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : "").toContain("bundle is broken");
  });

  it("reports a rejected call", async () => {
    const result = await run({
      bundle: "globalThis.fail = () => Promise.reject(new Error('nope'));",
      call: "globalThis.fail()",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : "").toContain("nope");
  });

  it("refuses a non-string result rather than coercing one", async () => {
    // The contract is a string. Coercing `{}` to "[object Object]" would hand
    // the caller a plausible-looking value that means nothing.
    const result = await run({ bundle: "", call: "Promise.resolve({ not: 'a string' })" });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : "").toContain("expected a string");
  });

  describe("containment", () => {
    // What the sandbox does NOT have. Asked by `typeof`, which cannot throw, so
    // each assertion reads back what is actually there rather than whether a
    // reference happened to fail.
    it.each([
      ["process", "the host's environment and secrets"],
      ["fetch", "the network"],
      ["require", "the host module graph"],
      ["WebAssembly", "a second engine"],
    ])("has no %s (%s)", async (name) => {
      const result = await run({
        bundle: "",
        call: `Promise.resolve(typeof globalThis.${name})`,
      });
      expect(result).toEqual({ ok: true, value: "undefined" });
    });

    it("cannot reach the host through the Function constructor", async () => {
      // `new Function` WORKS in here — QuickJS is an interpreter, so it builds
      // a QuickJS function, which is exactly why this runs on workerd. What it
      // cannot do is find a host global, because there is not one to find.
      const result = await run({
        bundle: "",
        call: `Promise.resolve(String(Function("return typeof process")()))`,
      });
      expect(result).toEqual({ ok: true, value: "undefined" });
    });

    it("cannot import a host module", async () => {
      const result = await run({
        bundle: "",
        call: `import('node:fs').then(() => 'RESOLVED', (e) => 'REJECTED:' + e.message)`,
      });
      expect(result.ok).toBe(true);
      expect(result.ok === true ? result.value : "").toContain("REJECTED:");
    });
  });

  it("preempts a synchronous infinite loop at the deadline", async () => {
    // The property the host process cannot give itself: a spinning JS thread
    // cannot be interrupted from outside, but QuickJS's interpreter polls an
    // interrupt handler and stops.
    const started = Date.now();
    const result = await run({
      bundle: "globalThis.spin = () => { while (true) {} };",
      call: "Promise.resolve(globalThis.spin())",
      timeoutMs: 1_000,
    });
    expect(result.ok).toBe(false);
    // Bounded, and bounded near the deadline rather than at some later backstop.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("caps memory", async () => {
    const result = await run({
      bundle:
        "globalThis.eat = () => { const held = []; for (;;) held.push(new Array(10000).fill('x')); };",
      call: "Promise.resolve(globalThis.eat())",
      memoryLimitBytes: 8 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(false);
  }, 60_000);
});
