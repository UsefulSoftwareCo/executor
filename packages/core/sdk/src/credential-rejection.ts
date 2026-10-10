// Telling a credential rejection apart from an ordinary "forbidden". An
// upstream 401 always means the credential was not accepted. A 403 is
// ambiguous: it is also how APIs refuse an operation the caller IS
// authenticated for (billing plan, resource permissions, org policy). Labelling
// those connection_rejected sends the agent and the user to re-authenticate a
// connection that works, so a 403 counts as a credential rejection only when
// the response itself says so:
//
//   - a WWW-Authenticate challenge (RFC 7235: the server is asking for
//     credentials). Scope-insufficient challenges are classified separately
//     by detectInsufficientScope before this runs.
//   - an OAuth/RPC error code naming the credential (`invalid_token`,
//     `UNAUTHENTICATED`, ...) in the body.
//   - an error message naming a bad, expired, or missing credential
//     ("Invalid API key", "token expired", "Bad credentials").
//
// A miss is benign: the failure is reported as an upstream 403 carrying the
// upstream's own message, so a credential problem is still legible.

import { parseChallenges } from "./www-authenticate";

const MAX_DEPTH = 8;
const MESSAGE_CAP = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonSafe = (text: string): unknown => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: classifying an untrusted upstream error body; a parse failure just means "not a JSON body", never an error path
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: same untrusted-body classification; the parsed value is only structurally inspected, never decoded into domain types
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

// Exact error-code values (OAuth 2.0 / RFC 6750, google.rpc, common REST
// envelopes) that name the credential rather than the operation.
const CREDENTIAL_ERROR_CODES = new Set([
  "invalid_token",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unauthenticated",
  "not_authenticated",
  "authentication_failed",
  "authentication_required",
  "invalid_api_key",
  "invalid_credentials",
  "bad_credentials",
  "token_expired",
  "expired_token",
  "access_token_expired",
  "credentials_missing",
  "api_key_invalid",
  "api_key_expired",
]);

const CODE_FIELDS = ["error", "code", "status", "reason", "type", "error_code", "errorCode"];
const MESSAGE_FIELDS = [
  "message",
  "error_description",
  "errorMessage",
  "detail",
  "title",
  "description",
  "error",
];

// Credential vocabulary in prose. Both halves are required for the first
// pattern so "invalid request" or "missing field" never classify.
const CREDENTIAL_MESSAGE_PATTERNS = [
  /\b(?:invalid|expired|revoked|missing|malformed|incorrect|unknown|disabled|bad|wrong)\b[\w\s-]{0,30}?\b(?:tokens?|credentials?|api[ _-]?keys?|access[ _-]?keys?|secret|signature|authorization header|bearer)\b/i,
  /\b(?:tokens?|credentials?|api[ _-]?keys?|access[ _-]?keys?|signature)\b[\w\s-]{0,30}?\b(?:is |are |has |have )?(?:invalid|expired|revoked|missing|malformed|incorrect|not valid|been revoked)\b/i,
  /\b(?:unauthenticated|not authenticated|authentication (?:failed|required|is required|credentials)|login required|requires authentication)\b/i,
];

const normalizedBody = (body: unknown): unknown => {
  if (typeof body !== "string") return body;
  const parsed = parseJsonSafe(body);
  return parsed === undefined ? body : parsed;
};

const collect = (
  body: unknown,
  depth: number,
  out: { codes: string[]; messages: string[] },
): void => {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(body)) {
    for (const item of body) collect(item, depth + 1, out);
    return;
  }
  if (!isRecord(body)) return;
  for (const field of CODE_FIELDS) {
    const value = body[field];
    if (typeof value === "string") out.codes.push(value);
  }
  for (const field of MESSAGE_FIELDS) {
    const value = body[field];
    if (typeof value === "string" && value.trim().length > 0) out.messages.push(value.trim());
  }
  for (const value of Object.values(body)) {
    if (isRecord(value) || Array.isArray(value)) collect(value, depth + 1, out);
  }
};

const bodySignals = (body: unknown): { codes: string[]; messages: string[] } => {
  const out = { codes: [] as string[], messages: [] as string[] };
  const normalized = normalizedBody(body);
  if (typeof normalized === "string") {
    const text = normalized.trim();
    if (text.length > 0) out.messages.push(text.slice(0, MESSAGE_CAP));
    return out;
  }
  collect(normalized, 0, out);
  return out;
};

const hasAuthChallenge = (headers: Record<string, string> | undefined): boolean =>
  Object.entries(headers ?? {}).some(([name, value]) => {
    if (name.toLowerCase() !== "www-authenticate") return false;
    const challenges = parseChallenges(value);
    return challenges !== null && challenges.length > 0;
  });

/** The upstream's own error text, when its body carries one: the first
 *  message-like field of a JSON error envelope, or a plain-text body. Used to
 *  put the upstream's words in front of the caller instead of only in
 *  structured details. */
export const upstreamErrorMessage = (body: unknown): string | undefined => {
  const message = bodySignals(body).messages[0];
  if (message === undefined) return undefined;
  return message.length > MESSAGE_CAP ? `${message.slice(0, MESSAGE_CAP)}…` : message;
};

/** Whether an upstream 401/403 means the credential itself was not accepted
 *  (so re-authenticating or updating the connection is the fix). A 401 always
 *  does; a 403 only when its challenge header, error code, or message says
 *  so. Run detectInsufficientScope first: a scope shortfall is its own case. */
export const isCredentialRejection = (input: {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}): boolean => {
  if (input.status === 401) return true;
  if (input.status !== 403) return false;
  if (hasAuthChallenge(input.headers)) return true;
  const { codes, messages } = bodySignals(input.body);
  if (codes.some((code) => CREDENTIAL_ERROR_CODES.has(code.toLowerCase()))) return true;
  return messages.some((message) =>
    CREDENTIAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)),
  );
};
