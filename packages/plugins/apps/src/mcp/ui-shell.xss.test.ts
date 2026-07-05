import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { buildUiDocument, safeJsonForScript } from "./ui-shell";

// ---------------------------------------------------------------------------
// Finding 2 regression: the ui document's data island inlines rows/title into an
// inline <script>. A row value containing "</script>" must NOT break out of the
// script element and execute. Before the fix, `JSON.stringify(...)` emitted the
// raw "</script>" verbatim, closing the element and running the injected markup.
// ---------------------------------------------------------------------------

const PAYLOAD = `</script><script>window.__pwned=1</script>`;

// A minimal valid compiled component bundle: the runtime splices this in place
// of the marker and calls it. It just needs to be syntactically valid JS.
const COMPILED_BUNDLE = `module.exports = function App(){ return null; };`;

describe("ui data island XSS (Fix 2)", () => {
  it("safeJsonForScript escapes </script and round-trips exactly", () => {
    const value = { rows: [{ title: PAYLOAD }], title: "a b" };
    const out = safeJsonForScript(value);
    // No raw "</script" survives (case-insensitive).
    expect(/<\/script/i.test(out)).toBe(false);
    // No raw line-separators (U+2028/U+2029) that would break a script literal.
    expect(out.includes("\u2028")).toBe(false);
    expect(out.includes("\u2029")).toBe(false);
    // Still valid JSON that parses back to the identical value.
    expect(JSON.parse(out)).toEqual(value);
  });

  it("emits a document whose data island cannot break out of <script>", async () => {
    const html = await Effect.runPromise(
      buildUiDocument({
        compiledBundle: COMPILED_BUNDLE,
        title: "Dash",
        rows: [{ title: PAYLOAD, number: 1 }],
      }),
    );

    // Isolate the data-island script (the one assigning window.__EXECUTOR_UI__).
    const marker = "window.__EXECUTOR_UI__ = ";
    const start = html.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const islandEnd = html.indexOf("</script>", start);
    const island = html.slice(start, islandEnd);

    // The malicious "</script" never appears raw inside the island: it cannot
    // close the element and execute the injected <script>.
    expect(/<\/script/i.test(island)).toBe(false);
    // And the payload IS present, in escaped form (proving it was serialized,
    // not dropped).
    expect(island).toContain("\\u003c/script");
  });
});
