import { describe, expect, it } from "@effect/vitest";

import { jsLiteral, jsString, writeJsonResult } from "./codex-repl";

// ---------------------------------------------------------------------------
// Caller arguments are embedded into a JavaScript source text that runs in
// Codex's REPL. The encoding is the whole security boundary, so it is tested
// on the values that break naive embeddings rather than on happy text.
// ---------------------------------------------------------------------------

/** The value the emitted expression produces, without evaluating JS: the
 *  expression is `JSON.parse(<js string literal>)`, so unwrap the literal and
 *  parse it the same way the REPL would. */
const evaluate = (expression: string): unknown => {
  expect(expression.startsWith("JSON.parse(")).toBe(true);
  const literal = expression.slice("JSON.parse(".length, -1);
  // oxlint-disable-next-line executor/no-json-parse -- the subject under test IS the JSON embedding; decoding it exactly as the REPL would is the assertion, and a schema decode would hide the prototype behaviour being checked
  return JSON.parse(JSON.parse(literal) as string);
};

describe("jsLiteral", () => {
  it("keeps a prototype-named key as an own key", () => {
    // Built by parsing, not as an object literal: writing `{ __proto__: … }`
    // in source sets the prototype, so a literal-based fixture would test
    // nothing. This is the shape that actually arrives over the wire.
    // oxlint-disable-next-line executor/no-json-parse -- an object literal would assign the PROTOTYPE, so parsing is the only way to build the own key this test is about
    const args: unknown = JSON.parse('{"__proto__":{"polluted":"yes"},"url":"https://x/"}');

    const value = evaluate(jsLiteral(args)) as Record<string, unknown>;

    expect(Object.hasOwn(value, "__proto__"), "carried as data").toBe(true);
    expect(Object.getPrototypeOf(value), "and not onto the prototype chain").toBe(Object.prototype);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("survives quotes, newlines, and JS line terminators", () => {
    // U+2028/U+2029 are legal raw inside a JSON string but END A STATEMENT in
    // a JS source text — the case that silently truncates a program.
    const args = { text: 'he said "hi"\n\u2028\u2029 and left', path: "C:\\tmp" };

    expect(evaluate(jsLiteral(args))).toEqual(args);
  });

  it("renders an absent value as null rather than a hole", () => {
    expect(evaluate(jsLiteral(undefined))).toBeNull();
  });
});

describe("jsString", () => {
  it("escapes line terminators that would end the statement", () => {
    expect(jsString("a\u2028b")).toBe('"a\\u2028b"');
    // oxlint-disable-next-line executor/no-json-parse -- decoding the emitted JS string literal is the assertion
    expect(JSON.parse(jsString('quote " here')) as string).toBe('quote " here');
  });
});

describe("writeJsonResult", () => {
  it("scopes the per-call body so a reused REPL session does not redeclare", () => {
    const program = writeJsonResult(["const a = 1;"], "await f(a)");

    expect(program.startsWith("await (async () => {")).toBe(true);
    expect(program).toContain("nodeRepl.write(JSON.stringify(result ?? null));");
  });
});
