// Detecting a scope-insufficient upstream rejection. A 403 that means "this
// grant does not cover that operation" is unfixable by re-running the same
// OAuth flow, so it must not be labelled connection_rejected (whose recovery
// tells the agent to re-authenticate). Providers signal it three ways:
//
//   - RFC 6750: a `WWW-Authenticate: Bearer error="insufficient_scope"
//     scope="..."` challenge header (the `scope` attribute names what the
//     request needed).
//   - Google (google.rpc.ErrorInfo): a JSON body whose error details carry
//     `reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT"`.
//   - Generic OAuth JSON: `{ "error": "insufficient_scope" }` (RFC 6750 §3.1
//     as a body, which some providers emit instead of the header).
//
// Detection is deliberately strict — a false positive strips the
// re-authenticate recovery from a 403 that re-auth WOULD fix:
//
//   - Challenge headers are PARSED into parameters (quoted values consumed
//     whole), so `error=insufficient_scope` inside another parameter's
//     quoted value never counts; only the `error` parameter's own exact
//     value does.
//   - Structured bodies match only exact `error` / `reason` field values.
//   - Text bodies are JSON-parsed first and then inspected structurally;
//     non-JSON text never classifies (prose mentioning the tokens misses).
//
// A miss is benign: the failure stays on the existing classification.

import { parseChallenges } from "./www-authenticate";

export type InsufficientScopeDetection = {
  /** Scopes the upstream named as required, when it named any (RFC 6750's
   *  `scope` attribute). Empty when the provider only signalled the class of
   *  failure (Google's ErrorInfo does not carry the missing scope). */
  readonly requiredScopes: readonly string[];
};

const MAX_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const detectFromChallenge = (header: string): InsufficientScopeDetection | null => {
  const challenges = parseChallenges(header);
  if (challenges === null) return null;
  for (const challenge of challenges) {
    if (challenge.scheme !== "bearer") continue;
    if (challenge.params.get("error") !== "insufficient_scope") continue;
    const scope = challenge.params.get("scope");
    return { requiredScopes: scope ? scope.split(/\s+/).filter(Boolean) : [] };
  }
  return null;
};

const detectFromStructured = (body: unknown, depth: number): boolean => {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(body)) {
    return body.some((item) => detectFromStructured(item, depth + 1));
  }
  if (!isRecord(body)) return false;
  if (body.error === "insufficient_scope") return true;
  if (body.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") return true;
  // Recurse into records/arrays only — nested strings are data (scope lists,
  // docs prose), never the error envelope itself.
  return Object.values(body).some(
    (value) => (isRecord(value) || Array.isArray(value)) && detectFromStructured(value, depth + 1),
  );
};

const parseJsonSafe = (text: string): unknown => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: classifying an untrusted upstream error body; a parse failure just means "not a JSON body", never an error path
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: same untrusted-body classification; the parsed value is only structurally inspected, never decoded into domain types
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const detectFromBody = (body: unknown): boolean => {
  if (typeof body === "string") {
    const parsed = parseJsonSafe(body);
    return parsed !== undefined && detectFromStructured(parsed, 0);
  }
  return detectFromStructured(body, 0);
};

/** Strict detection over a text fragment whose JSON body survives only as a
 *  suffix of a transport error message (the MCP SDK embeds the failed POST's
 *  body after a fixed prefix). The JSON is isolated from the first `{` or `[`
 *  and parsed; prose without a parseable JSON envelope never classifies. */
export const insufficientScopeFromEmbeddedJson = (text: string): boolean => {
  const start = text.search(/[{[]/);
  if (start < 0) return false;
  const parsed = parseJsonSafe(text.slice(start));
  return parsed !== undefined && detectFromStructured(parsed, 0);
};

/** Inspect an upstream 401/403's body and headers for a scope-insufficiency
 *  signal. Returns `null` when nothing matches, so callers fall through to
 *  their existing classification. */
export const detectInsufficientScope = (input: {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}): InsufficientScopeDetection | null => {
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (name.toLowerCase() !== "www-authenticate") continue;
    const detected = detectFromChallenge(value);
    if (detected) return detected;
  }
  return detectFromBody(input.body) ? { requiredScopes: [] } : null;
};
