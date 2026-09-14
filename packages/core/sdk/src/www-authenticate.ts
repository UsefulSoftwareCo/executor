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

/** Parse authentication challenges without joining parameters across schemes. */
export const parseChallenges = (header: string): readonly Challenge[] | null => {
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
