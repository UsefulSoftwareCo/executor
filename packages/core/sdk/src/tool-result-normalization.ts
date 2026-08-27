/**
 * Result-encoding normalization — the seam that keeps `ToolResult.data` a
 * SEMANTIC payload no matter what the upstream transport wrapped it in.
 *
 * OpenAPI set the precedent: `data` is the response body, transport facts
 * (`http`) ride beside it. MCP's CallToolResult envelope is the same
 * situation one protocol over: `content` blocks and `_meta` are transport
 * ceremony, and the payload lives in `structuredContent` — or, for the many
 * servers that predate it, serialized as JSON inside a text block. Serving
 * the raw envelope as `data` made models guess field paths through ceremony
 * and pay for spec-mandated payload duplication (servers SHOULD mirror
 * `structuredContent` as text).
 *
 * A tool row opts in via its persisted `result_encoding`; the executor
 * applies normalization after invocation and error recovery, before
 * telemetry and shape observation, so learned shapes describe payloads.
 * Owned by core — not the MCP plugin — because the encoding outlives the
 * plugin system.
 */

import type { ToolContentBlock, ToolResult } from "./tool-result";

/** Wire vocabulary persisted on tool rows. `direct` = data is already the
 *  payload (every non-MCP tool today). */
export type ToolResultEncoding = "direct" | "mcp-call-tool-result-v2";

export const TOOL_RESULT_ENCODINGS: readonly ToolResultEncoding[] = [
  "direct",
  "mcp-call-tool-result-v2",
];

export const isToolResultEncoding = (value: unknown): value is ToolResultEncoding =>
  value === "direct" || value === "mcp-call-tool-result-v2";

/** Parse guard: a lone text block larger than this stays a string rather
 *  than paying a second unbounded parse. */
const MAX_JSON_TEXT_CHARS = 4_000_000;

type Envelope = {
  readonly content: readonly ToolContentBlock[];
  readonly structuredContent?: unknown;
  readonly meta?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readEnvelope = (value: unknown): Envelope | null => {
  if (!isRecord(value)) return null;
  const content = value["content"];
  if (!Array.isArray(content)) return null;
  if (!content.every(isRecord)) return null;
  return {
    content: content as readonly ToolContentBlock[],
    ...("structuredContent" in value ? { structuredContent: value["structuredContent"] } : {}),
    ...("_meta" in value ? { meta: value["_meta"] } : {}),
  };
};

const textOf = (block: ToolContentBlock): string | null =>
  block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : null;

/** Exact-JSON parse of an object/array payload; anything else (prose, JSON
 *  fenced in Markdown, bare literals, oversized text) stays a string. */
const parseJsonPayload = (text: string): unknown | undefined => {
  if (text.length > MAX_JSON_TEXT_CHARS) return undefined;
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing whether upstream text IS JSON; a parse rejection is the "not JSON" answer, not a failure to model
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: same probe; there is no schema for arbitrary upstream JSON
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Structural equality against the parsed form of a text block, used to
 *  suppress the spec-mandated serialized duplicate of `structuredContent`.
 *  Key-order insensitive; bounded by the same size guard as payload parsing. */
const structurallyEquals = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => structurallyEquals(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => key in right && structurallyEquals(left[key], right[key]));
  }
  return false;
};

const isDuplicateOfStructured = (block: ToolContentBlock, structured: unknown): boolean => {
  const text = textOf(block);
  if (text === null) return false;
  const parsed = parseJsonPayload(text);
  return parsed !== undefined && structurallyEquals(parsed, structured);
};

export type NormalizedToolSuccess = {
  readonly data: unknown;
  /** Supplemental blocks NOT already represented by `data` (media, extra
   *  prose). Never the serialized duplicate of `structuredContent`. */
  readonly content?: readonly ToolContentBlock[];
  /** Envelope `_meta`, excluded from schemas and shape inference. */
  readonly meta?: unknown;
};

/**
 * Normalize one successful MCP CallToolResult into semantic data:
 *
 * 1. `structuredContent` present → it IS the data; non-duplicate blocks ride
 *    in `content`.
 * 2. Lone text block of exact JSON (object/array) → the parsed value.
 * 3. Lone text block of prose → the string itself.
 * 4. No content and no structuredContent → null.
 * 5. Anything else (media, multi-block) → the ordered block array.
 *
 * A value that isn't envelope-shaped is returned as-is — normalization must
 * never invent structure.
 */
export const normalizeMcpCallToolResult = (raw: unknown): NormalizedToolSuccess => {
  const envelope = readEnvelope(raw);
  if (envelope === null) return { data: raw };

  const meta = envelope.meta !== undefined ? { meta: envelope.meta } : {};

  if (envelope.structuredContent !== undefined) {
    const supplemental = envelope.content.filter(
      (block) => !isDuplicateOfStructured(block, envelope.structuredContent),
    );
    return {
      data: envelope.structuredContent,
      ...(supplemental.length > 0 ? { content: supplemental } : {}),
      ...meta,
    };
  }

  if (envelope.content.length === 0) return { data: null, ...meta };

  if (envelope.content.length === 1) {
    const only = envelope.content[0];
    const text = only === undefined ? null : textOf(only);
    if (text !== null) {
      const parsed = parseJsonPayload(text);
      return { data: parsed !== undefined ? parsed : text, ...meta };
    }
  }

  return { data: envelope.content, ...meta };
};

/** Apply a row's result encoding to a successful invocation value. */
export const applyResultEncoding = (
  encoding: ToolResultEncoding,
  result: ToolResult<unknown>,
): ToolResult<unknown> => {
  if (encoding === "direct" || !result.ok) return result;
  const normalized = normalizeMcpCallToolResult(result.data);
  return {
    ...result,
    data: normalized.data,
    ...(normalized.content !== undefined ? { content: normalized.content } : {}),
    ...(normalized.meta !== undefined ? { meta: normalized.meta } : {}),
  };
};
