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

export type InsufficientScopeDetection = {
  /** Scopes the upstream named as required, when it named any (RFC 6750's
   *  `scope` attribute). Empty when the provider only signalled the class of
   *  failure (Google's ErrorInfo does not carry the missing scope). */
  readonly requiredScopes: readonly string[];
};

const MAX_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parser for the whole WWW-Authenticate header per RFC 7235 §2.1: a
 *  comma-separated #list of challenges, each
 *  `scheme [ 1*SP ( token68 / #auth-param ) ]`. Implemented as an explicit
 *  per-challenge state machine so params can never attach across challenge
 *  boundaries or to a token68 credential:
 *
 *  - "scheme": just read a scheme; accepts a token68 OR a first auth-param
 *    (space-separated, no comma).
 *  - "params": accepts further auth-params ONLY after a comma.
 *  - "token68": accepts nothing; any trailing param is malformed.
 *
 *  Auth-params allow BWS around `=` (RFC 7230). Quoted-strings consume
 *  quoted-pairs whole and must end at a separator. ANY malformed shape —
 *  scheme-less params, space-separated param runs, params after token68,
 *  stray quotes/bytes — returns null and never classifies: a miss is benign,
 *  a false positive strips a valid recovery path. */
type Challenge = { readonly scheme: string; readonly params: Map<string, string> };

// HTTP `token` alphabet (RFC 7230 §3.2.6) — schemes and auth-param names.
const TOKEN_RE = /[A-Za-z0-9!#$%&'*+.^_`|~-]/;
// token68 alphabet (RFC 7235 §2.1), padding `=` handled separately.
const TOKEN68_RE = /[A-Za-z0-9._~+/-]/;
// Superset used by the word reader; each use site validates against the
// context-specific alphabet after reading.
const WORD_RE = /[A-Za-z0-9!#$%&'*+.^_`|~/-]/;

const isToken = (word: string): boolean => [...word].every((ch) => TOKEN_RE.test(ch));
// Unquoted URL values some providers emit (scheme://host/path?query): URI
// characters per RFC 3986, no whitespace/comma/quotes.
const isUrlish = (word: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s,"]+$/.test(word);
const isToken68 = (word: string): boolean => [...word].every((ch) => TOKEN68_RE.test(ch));

const parseChallenges = (header: string): readonly Challenge[] | null => {
  const len = header.length;
  const challenges: Challenge[] = [];
  let current: Challenge | null = null;
  let state: "boundary" | "scheme" | "token68" | "params" = "boundary";
  let sawComma = true; // header start counts as a list boundary
  let i = 0;

  const readWord = (): string => {
    const start = i;
    while (i < len && WORD_RE.test(header[i]!)) i += 1;
    return header.slice(start, i);
  };
  // Returns null on an unterminated quote or a quote run into the next token.
  const readQuoted = (): string | null => {
    let value = "";
    i += 1; // opening quote
    while (i < len) {
      const ch = header[i]!;
      if (ch === '"') {
        i += 1;
        return i >= len || /[\s,]/.test(header[i]!) ? value : null;
      }
      if (ch === "\\" && i + 1 < len) {
        value += header[i + 1];
        i += 2;
        continue;
      }
      value += ch;
      i += 1;
    }
    return null; // unterminated
  };

  while (i < len) {
    while (i < len && /\s/.test(header[i]!)) i += 1;
    if (i >= len) break;
    if (header[i] === ",") {
      sawComma = true;
      i += 1;
      continue;
    }
    if (!WORD_RE.test(header[i]!)) return null; // stray quote/byte: malformed
    const word = readWord();
    // Look ahead through BWS for `=` to classify the word.
    let j = i;
    while (j < len && /[ \t]/.test(header[j]!)) j += 1;
    const isPaddingRun = (() => {
      // An `=`-run directly on the word (no BWS) that is followed (after
      // optional whitespace) by a comma or the end of input is token68
      // padding. An `=` followed by a value — even across BWS — is an
      // auth-param (RFC 7230 allows BWS around `=`).
      if (header[i] !== "=") return false;
      let k = i;
      while (k < len && header[k] === "=") k += 1;
      while (k < len && /[ \t]/.test(header[k]!)) k += 1;
      return k >= len || header[k] === ",";
    })();

    if (isPaddingRun) {
      // token68 with padding — only legal directly after a scheme.
      if (state !== "scheme" || sawComma) return null;
      if (!isToken68(word)) return null;
      while (i < len && header[i] === "=") i += 1;
      state = "token68";
      sawComma = false;
      continue;
    }

    if (header[j] === "=") {
      // auth-param: `word BWS = BWS value`.
      if (!isToken(word)) return null; // param name must be an HTTP token
      if (current === null) return null; // scheme-less param
      if (state === "token68") return null; // params after token68
      if (state === "scheme" && sawComma) return null; // "Bearer, a=b"
      if (state === "params" && !sawComma) return null; // space-separated run
      i = j + 1;
      while (i < len && /[ \t]/.test(header[i]!)) i += 1;
      let value: string;
      if (header[i] === '"') {
        const quoted = readQuoted();
        if (quoted === null) return null;
        value = quoted;
      } else {
        const start = i;
        while (i < len && !/[\s,]/.test(header[i]!)) i += 1;
        value = header.slice(start, i);
        // An unquoted value must be an HTTP token (`realm =,` / `realm=;`
        // are malformed) — EXCEPT that real providers emit unquoted URLs for
        // resource_metadata (observed live: Stripe), so URL-safe characters
        // are tolerated there. The signal params (`error`, `scope`) stay
        // token-strict.
        if (value.length === 0) return null;
        const lowerName = word.toLowerCase();
        if (!isToken(value) && !(lowerName === "resource_metadata" && isUrlish(value))) {
          return null;
        }
      }
      // Duplicate SIGNAL params (`error`, `scope`) within one challenge mean
      // a header playing games — never classify. Other duplicates are
      // tolerated first-wins: real providers emit them (observed live:
      // Sentry duplicates resource_metadata).
      const key = word.toLowerCase();
      if (current.params.has(key)) {
        if (key === "error" || key === "scope") return null;
      } else {
        current.params.set(key, value);
      }
      state = "params";
      sawComma = false;
      continue;
    }

    // Bare word: a new challenge's scheme at a list boundary, a token68
    // directly after a scheme, malformed anywhere else.
    if (sawComma) {
      if (!isToken(word)) return null; // a scheme must be an HTTP token
      current = { scheme: word.toLowerCase(), params: new Map() };
      challenges.push(current);
      state = "scheme";
      sawComma = false;
      continue;
    }
    if (state === "scheme") {
      if (!isToken68(word)) return null;
      state = "token68";
      continue;
    }
    return null;
  }

  return challenges;
};

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
