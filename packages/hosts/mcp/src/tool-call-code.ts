/**
 * The `execute-action` wire contract.
 *
 * `execute-action` is the channel a rendered artifact uses to reach an
 * integration, and it used to accept arbitrary code — the same surface as
 * `execute`. That was wider than anything the shell could produce: artifact code
 * is purely declarative `tools.*`, and the shell's proxy serializes every call
 * into exactly one shape.
 *
 * Wider than necessary is also wider than safe. A hostile or confused iframe
 * could post arbitrary source down the app channel even though no affordance in
 * the shell ever writes any. So the server parses `execute-action` against the
 * one grammar the proxy emits:
 *
 *     return await tools.<ident>(.<ident>)*(<JSON>)
 *
 * One awaited tool call, one JSON-literal argument, nothing else — no
 * statements, no loops, no composition. `execute` (the model-facing codemode
 * tool) is untouched; this constraint is only for the app-originated channel.
 *
 * The producing half is `toolCallCode` in
 * `@executor-js/mcp-apps-shell/shell/proxy`, and `tool-call-grammar.pin.test.ts`
 * in that package pins the two together so neither can drift.
 */

import { Option, Schema } from "effect";

const TOOL_CALL_CODE = /^return await tools\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\((.*)\);?$/s;

/** The proxy's argument is always `JSON.stringify` output, so anything that
 *  does not decode is, by construction, not something the proxy emitted. */
const decodeArgs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export type ParsedToolCall = {
  /** The dotted path segments under `tools`, e.g. `["github", "issues", "create"]`. */
  readonly path: readonly string[];
  /** The single call argument, already JSON-decoded. */
  readonly args: unknown;
};

/** The message handed back to the iframe when its code is not a tool call. */
export const TOOL_CALL_CONTRACT_MESSAGE = [
  "execute-action accepts a single tool call, not arbitrary code.",
  "The only accepted form is `return await tools.<path>(<json>)` —",
  "exactly what the shell's `tools.*` proxy emits.",
  "Interactive UI reaches integrations declaratively:",
  "`tools.<ns>.<tool>.queryOptions(...)` / `.infiniteQueryOptions(...)` for reads,",
  "`.mutationOptions(...)` for writes.",
].join(" ");

/**
 * `null` when `code` is not the proxy's emission, otherwise the call it
 * describes. Callers only need the null check; the parsed value is returned
 * because it is free here and useful to log.
 */
export const parseToolCallCode = (code: string): ParsedToolCall | null => {
  const match = TOOL_CALL_CODE.exec(code.trim());
  if (!match) return null;

  const [, dottedPath, serializedArgs] = match;
  if (dottedPath === undefined || serializedArgs === undefined) return null;

  const args = decodeArgs(serializedArgs);
  if (Option.isNone(args)) return null;

  return { path: dottedPath.split("."), args: args.value };
};
