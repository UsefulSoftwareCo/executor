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
 *     return await tools<segment>("<role>")?<segment>*(<JSON>)
 *
 * A segment is either `.identifier` or a JSON-escaped bracket lookup. The
 * latter keeps hyphenated integration and tool slugs inert while preserving
 * the one-call grammar.
 *
 * One awaited tool call, one JSON-literal argument, nothing else — no
 * statements, no loops, no composition. `execute` (the model-facing codemode
 * tool) is untouched; this constraint is only for the app-originated channel.
 *
 * The leading segment is an INTEGRATION, not a connection: artifact paths
 * carry no tier and no connection name (see `artifact-bindings.ts`). The
 * optional string call right after it is the integration ROLE, which is how an
 * artifact using two accounts of one integration says which it means. Both are
 * resolved to a full address server-side, against the bindings stored on the
 * artifact row — so what arrives here is never an address the iframe chose.
 *
 * The producing half is `toolCallCode` in
 * `@executor-js/mcp-apps-shell/shell/proxy`, and `tool-call-grammar.pin.test.ts`
 * in that package pins the two together so neither can drift.
 */

import { Option, Schema } from "effect";

const JSON_STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;
const PATH_SEGMENT = String.raw`(?:\.[A-Za-z_$][\w$]*|\[${JSON_STRING_LITERAL}\])`;
const TOOL_CALL_CODE = new RegExp(
  String.raw`^return await tools(${PATH_SEGMENT})(?:\((${JSON_STRING_LITERAL})\))?((?:${PATH_SEGMENT})*)\((.*)\);?$`,
  "s",
);
const PATH_SEGMENT_MATCHER = new RegExp(
  String.raw`(?:\.([A-Za-z_$][\w$]*)|\[(${JSON_STRING_LITERAL})\])`,
  "gy",
);

/** The proxy's argument is always `JSON.stringify` output, so anything that
 *  does not decode is, by construction, not something the proxy emitted. */
const decodeArgs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const decodePath = (serialized: string): readonly string[] | null => {
  const path: string[] = [];
  let offset = 0;
  while (offset < serialized.length) {
    PATH_SEGMENT_MATCHER.lastIndex = offset;
    const match = PATH_SEGMENT_MATCHER.exec(serialized);
    if (!match) return null;

    const identifier = match[1];
    if (identifier !== undefined) {
      path.push(identifier);
    } else {
      const bracketed = match[2];
      if (bracketed === undefined) return null;
      const decoded = decodeJsonString(bracketed);
      if (Option.isNone(decoded) || decoded.value.length === 0) return null;
      path.push(decoded.value);
    }
    offset = PATH_SEGMENT_MATCHER.lastIndex;
  }
  return path;
};

export type ParsedToolCall = {
  /** The path segments under `tools`, e.g. `["github", "issues", "create"]`.
   *  The head is an integration slug (or a system-tool root); it is never a
   *  tier or a connection name. */
  readonly path: readonly string[];
  /** The integration role, when the call was tagged with one. Absent means the
   *  artifact uses a single account of that integration, whose role is the
   *  integration slug itself. */
  readonly role?: string;
  /** The single call argument, already JSON-decoded. */
  readonly args: unknown;
};

/** The message handed back to the iframe when its code is not a tool call. */
export const TOOL_CALL_CONTRACT_MESSAGE = [
  "execute-action accepts a single tool call, not arbitrary code.",
  'The only accepted form is `return await tools<integration>("<role>")?<path>(<json>)` —',
  "segments use dot notation for identifiers or JSON-string bracket notation otherwise —",
  "exactly what the shell's `tools.*` proxy emits.",
  "Interactive UI reaches integrations declaratively:",
  "`tools.<integration>.<tool>.queryOptions(...)` / `.infiniteQueryOptions(...)` for reads,",
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

  const [, root, serializedRole, serializedRest, serializedArgs] = match;
  if (root === undefined || serializedRest === undefined || serializedArgs === undefined)
    return null;

  const args = decodeArgs(serializedArgs);
  if (Option.isNone(args)) return null;

  const path = decodePath(`${root}${serializedRest}`);
  if (!path || path.length === 0) return null;

  if (serializedRole === undefined) return { path, args: args.value };

  // The role is a JSON string literal for the same reason the args are a JSON
  // literal: it decodes or it was not the proxy's emission.
  const role = decodeJsonString(serializedRole);
  if (Option.isNone(role) || role.value.length === 0) return null;

  return { path, role: role.value, args: args.value };
};

const TOOL_PATH_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const formatToolPathSegment = (segment: string): string =>
  TOOL_PATH_IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;

/**
 * Build the codemode call for a RESOLVED address — the full
 * `tools.<integration>.<tier>.<connection>.<tool>` path, after bindings have
 * been applied.
 *
 * The app channel never executes the string the iframe sent. It parses that
 * string into a path, rewrites the path through the artifact's bindings, and
 * re-emits it here. So this is the only code `execute-action` ever runs, and it
 * is built from segments the server itself chose.
 *
 * Deliberately not shared with the shell's `toolCallCode`: that one produces the
 * unresolved short form for the wire, this one produces the resolved address for
 * the engine, and they sit on opposite sides of the trust boundary. The shell
 * package depends on this one, never the reverse.
 */
export const formatToolCallCode = (path: readonly string[], args: unknown): string => {
  for (const segment of path) {
    if (typeof segment !== "string" || segment.length === 0) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: unreachable by construction (every segment came from a parsed path or a stored binding); a defect here must not become a malformed emission
      throw new Error("Invalid resolved tool path.");
    }
  }
  return `return await tools${path.map(formatToolPathSegment).join("")}(${JSON.stringify(args ?? {})})`;
};
