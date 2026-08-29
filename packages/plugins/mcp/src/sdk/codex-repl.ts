// ---------------------------------------------------------------------------
// Shared helpers for the Codex plugin surfaces that run through `node_repl`.
//
// Two Codex plugins ship no MCP server of their own and are driven by
// executing JavaScript in Codex's Node REPL: Computer Use (`@oai/sky`) and
// Chrome (`browser-client.mjs`). Both surfaces project that REPL as typed MCP
// tools, and both therefore have to embed caller arguments into a JS source
// text and read one JSON value back out. That encoding is the genuinely
// shared part, and it is the part that must be exactly right.
// ---------------------------------------------------------------------------

/**
 * A JS literal for an arbitrary value.
 *
 * JSON is almost a subset of JS — but U+2028 and U+2029 are legal raw inside a
 * JSON string while being literal line terminators in a JS source text, so a
 * value containing one would end the statement early. Escaping them makes the
 * embedding exact for every input, including text typed by a user.
 */
export const jsLiteral = (value: unknown): string =>
  JSON.stringify(value ?? null)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

/**
 * Wrap a program body so it runs in its own scope and reports one JSON value.
 *
 * The scope is not cosmetic. A REPL session is persistent and pooled
 * connections now reuse it across calls, so a program that declared its
 * working variables at top level would redeclare the same `const` on every
 * call — which the REPL answers with a warning per variable, prepended to the
 * result a caller then has to read around. Everything per-call lives in here;
 * only deliberate caches (the imported runtime) are left on `globalThis`.
 *
 * The REPL returns values only through `nodeRepl.write`, and only as text;
 * `undefined` (every action method) becomes `null` so a caller always gets a
 * well-formed JSON body rather than an empty string.
 */
export const writeJsonResult = (body: readonly string[], expression: string): string =>
  [
    "await (async () => {",
    ...body.map((line) => `  ${line}`),
    `  const result = ${expression};`,
    "  nodeRepl.write(JSON.stringify(result ?? null));",
    "})();",
  ].join("\n");
