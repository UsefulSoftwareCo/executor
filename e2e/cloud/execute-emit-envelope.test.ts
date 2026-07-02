// Cloud: the `execute` sandbox reports emitted output in its result envelope.
//
// `emit()` sends content to the USER, not back to the model, so a script that
// only emits returns a null value. Without a signal, an emit-without-return
// looks to the caller like nothing happened at all (the exact confusion this
// pins against). The envelope now carries an `emitted` count, and the text
// preview says output went to the user instead of a bare "(no result)".
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

scenario(
  "Execute · an emit-only script reports its emitted output in the result envelope",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    // A script that emits twice and returns nothing. Pre-change this came back
    // as `{ result: null }` with no hint the emits landed.
    const result = yield* session.call("execute", {
      code: `emit("first line for the user"); emit("second line"); return undefined;`,
    });
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 300)})`).toBe(true);

    // The envelope (what the model-facing MCP client reads) now reports the
    // emit count, so an emit-only script is no longer an indistinguishable
    // `{ result: null }`.
    const structured = (result.raw as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured?.status, "the run completed").toBe("completed");
    expect(structured?.result, "an emit-only script has no return value").toBeNull();
    expect(structured?.emitted, "the envelope counts the emitted items").toBe(2);

    // The emitted text itself flows to the user-facing content blocks.
    expect(result.text, "the emitted lines reach the user-facing content").toContain(
      "first line for the user",
    );

    // A script that returns a value keeps the plain envelope (no emit noise).
    const returned = yield* session.call("execute", { code: `return 6 * 7;` });
    const returnedStructured = (returned.raw as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(returnedStructured?.result, "the return value comes back to the caller").toBe(42);
    expect("emitted" in (returnedStructured ?? {}), "no emitted key when nothing was emitted").toBe(
      false,
    );
  }),
);
