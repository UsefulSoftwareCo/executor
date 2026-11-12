/**
 * The safe text of a failure: what a failed step, a rejected request or a page error says, with
 * secrets masked, for the job log, the Vitest failure message and the evidence alike.
 *
 * A third-party error can hold anything its caller passed it: URLs with credentials, request
 * headers, cookies, tokens. So its raw value stays `Redacted`, and only this text leaves the
 * process. The text keeps an error's name, its `code`, its message (for Playwright, its first
 * line, any listed elements and its call log) and up to three causes, each masked in full before
 * it is cut to length.
 *
 * Every rule finds what to mask in the original text, and the spans are joined before anything
 * is replaced, so no rule's output can hide a secret from another:
 *
 * 1. Each secret the harness registered, through `reveal`, `secret`, `holdSecret` or a
 *    `heldValue` schema, wherever it appears, raw or URL-, JSON- or base64-encoded: `<secret>`.
 * 2. The userinfo of every URL, and the query and fragment of every URL or path-shaped string
 *    (`/callback?code=…`, `https:\/\/app.test\/cb?code=…`, `cb%3Fcode%3D…`): dropped.
 * 3. Credential forms: the value of a listed `- name: value` line (Playwright's request and
 *    response headers), of an `authorization`, `cookie`, `set-cookie` or API-key header in any
 *    form, the token after `Bearer` or `Basic`, the value of a key such as `password`, `secret`,
 *    `token`, `key`, `session`, `code` or `signature` written `name=value` or `name: "value"`,
 *    and the text Playwright logs as typed (`fill("…")`, `elementHandle.type("…")`,
 *    `elementHandle.press("…")`): `<value>`.
 * 4. Any unbroken run of 40 or more letters, digits, `_`, `-` or `+` that has both a letter
 *    and a digit: `<opaque>`.
 *
 * What it cannot catch, and accepts: a run of hex digits only, digits only or letters only, and a
 * short value outside the forms above, look like ordinary text. The defences for those are
 * registration, at the points where the harness reads or decodes a secret, and process isolation:
 * the runner starts the Vitest worker with only the variables it lists, so the job's own
 * infrastructure tokens never enter the process whose errors are printed. A revealed value
 * shorter than 6 characters is not registered, so that common words stay readable.
 */
import { Cause, Config, Redacted, Schema } from "effect";

const revealed = new Set<string>();
const shortest = 6;

// Raw values already registered, so a secret revealed on every request is encoded once.
const registered = new Set<string>();

const register = (value: string) => {
  if (value.length < shortest || registered.has(value)) return;
  registered.add(value);
  const encoded = encodeURIComponent(value);
  for (const form of [
    value,
    encoded,
    encodeURIComponent(encoded),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString("base64").replace(/=+$/u, ""),
    Buffer.from(value).toString("base64url"),
  ])
    if (form.length >= shortest) revealed.add(form);
};

const absolute = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** A URL's credentials are its userinfo password and its query and fragment values. */
const holdString = (value: string) => {
  if (!absolute.test(value)) return register(value);
  try {
    const parsed = new URL(value);
    register(decodeURIComponent(parsed.password));
    for (const [, field] of parsed.searchParams) if (!absolute.test(field)) register(field);
    register(decodeURIComponent(parsed.hash.slice(1)));
  } catch {
    register(value);
  }
};

/** Object keys whose values are credentials. Everything else, origins and IDs, stays readable. */
const credentialKey =
  /(?:password|passwd|secret|token|apikey|api_key|key|code|cookie|session|credential|signature|proof)s?$/iu;

/** Register the credentials inside a value: every string under a credential key. */
const hold = (value: unknown, depth: number, under: boolean): void => {
  if (typeof value === "string") {
    if (under) holdString(value);
    return;
  }
  if (depth > 4 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) hold(item, depth + 1, under);
    return;
  }
  const record = value as Record<string, unknown>;
  // A cookie's name, domain and path are not secret; masking them would hide where it went.
  if (typeof record.name === "string" && typeof record.value === "string") {
    holdString(record.value);
    return;
  }
  for (const [key, field] of Object.entries(record))
    hold(field, depth + 1, under || credentialKey.test(key));
};

/** A secret itself: a string, a list of them or of cookies, or an object of credential fields. */
const holdValue = (value: unknown): void => {
  if (typeof value === "string") holdString(value);
  else if (Array.isArray(value)) for (const item of value) holdValue(item);
  else hold(value, 0, false);
};

/**
 * Read a secret for a third-party call. A string is masked in every failure text after; of an
 * object, only its credential fields (`token`, `clientSecret`, a cookie's `value`, …) are.
 */
export const reveal = <A>(secret: Redacted.Redacted<A>): A => {
  const value = Redacted.value(secret);
  holdValue(value);
  return value;
};

/** Register a secret the harness holds without passing it anywhere yet, such as its API key. */
export const holdSecret = (secret: Redacted.Redacted<unknown>): void => {
  reveal(secret);
};

/** Hold a value the harness received or created as a secret, such as a session's cookies. */
export const secret = <A>(value: A): Redacted.Redacted<A> => {
  holdValue(value);
  return Redacted.make(value);
};

/** A schema whose decoded value is registered as a secret, for a credential a response issues. */
export const heldValue = <S extends Schema.Top>(schema: S) =>
  schema.check(
    Schema.makeFilter((value: unknown) => {
      holdValue(Redacted.isRedacted(value) ? Redacted.value(value) : value);
      return true;
    }),
  );

type Span = { readonly start: number; readonly end: number; readonly label: string };
const dropped = "";

const headerName = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
const listedHeader = new RegExp(`^([ \\t]*-[ \\t]*${headerName}[ \\t]*:[ \\t]*)(\\S.*)$`, "gmu");
const credentialHeader =
  /\b(?:proxy-)?(?:authorization|set-cookie|cookie|x-api-key|api-key|x-auth-token|x-access-token)\b["']?[ \t]*[:=][ \t]*/giu;
const scheme = /\b(?:bearer|basic)[ \t]+([A-Za-z0-9._~+/=%-]+)/giu;
const keyed =
  /(["']?)([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|apikey|api_key|api-key|key|session|sid|credential|signature|code|cookie|proof))\1([ \t]*=[ \t]*|[ \t]*:[ \t]*(?=["']))/giu;
const typed = /\b(?:fill|type|press|insertText|pressSequentially)\("((?:[^"\\]|\\.)*)"\)/gu;
const token = /[^\s"'`<>]+/gu;
const userinfo = /\b[a-z][a-z0-9+.-]*:(?:\\?\/){2}([^\s"'`<>/\\?#@]*@)/giu;
const opaque = /[A-Za-z0-9_+-]{40,}/gu;

/** The end of a value that runs to its closing quote, or to the next delimiter. */
const valueEnd = (text: string, start: number, delimiters: RegExp) => {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === quote) return { start: start + 1, end: index };
    }
    return { start: start + 1, end: text.length };
  }
  delimiters.lastIndex = start;
  const next = delimiters.exec(text);
  return { start, end: next === null ? text.length : next.index };
};

const spans = (text: string): Span[] => {
  const found: Span[] = [];
  // Percent-encoded forms match whatever the case of their hex digits.
  const folded = text.toLowerCase();
  for (const secret of revealed) {
    const [within, sought] = secret.includes("%") ? [folded, secret.toLowerCase()] : [text, secret];
    for (let at = within.indexOf(sought); at !== -1; at = within.indexOf(sought, at + 1))
      found.push({ start: at, end: at + sought.length, label: "<secret>" });
  }
  for (const match of text.matchAll(token)) {
    // A path-shaped string's query and fragment, whether its delimiter is literal or encoded.
    const slash = match[0].search(/\\?\//u);
    if (slash === -1) continue;
    const tail = match[0].slice(slash).search(/[?#]|%3F|%23/iu);
    if (tail === -1) continue;
    const trailing = /[\\.,;:!)\]}]+$/u.exec(match[0])?.[0].length ?? 0;
    const start = match.index + slash + tail;
    const end = match.index + match[0].length - trailing;
    if (end > start) found.push({ start, end, label: dropped });
  }
  for (const match of text.matchAll(userinfo)) {
    const start = match.index + match[0].length - (match[1]?.length ?? 0);
    found.push({ start, end: match.index + match[0].length, label: dropped });
  }
  for (const match of text.matchAll(listedHeader))
    found.push({
      start: match.index + (match[1]?.length ?? 0),
      end: match.index + match[0].length,
      label: "<value>",
    });
  for (const match of text.matchAll(credentialHeader)) {
    const value = valueEnd(text, match.index + match[0].length, /[\n,}\]]/gu);
    if (value.end > value.start) found.push({ ...value, label: "<value>" });
  }
  for (const match of text.matchAll(scheme)) {
    const start = match.index + match[0].length - (match[1]?.length ?? 0);
    found.push({ start, end: match.index + match[0].length, label: "<value>" });
  }
  for (const match of text.matchAll(keyed)) {
    const value = valueEnd(text, match.index + match[0].length, /[\s&;,"'<>)\]}\\]/gu);
    if (value.end > value.start) found.push({ ...value, label: "<value>" });
  }
  for (const match of text.matchAll(typed)) {
    const start = match.index + match[0].indexOf('"') + 1;
    found.push({ start, end: start + (match[1]?.length ?? 0), label: "<value>" });
  }
  for (const match of text.matchAll(opaque))
    if (/[0-9]/u.test(match[0]) && /[A-Za-z]/u.test(match[0]))
      found.push({ start: match.index, end: match.index + match[0].length, label: "<opaque>" });
  return found;
};

// When spans overlap, the joined span is dropped if any part of it is, else the strongest label.
const strength = [dropped, "<secret>", "<value>", "<opaque>"];
const placeholder = /^<(?:secret|value|opaque)>$/u;

/** Mask one text by the rules above. */
export const mask = (text: string): string => {
  const ordered = spans(text)
    // Text masked before, such as a driver failure's message, keeps its placeholders.
    .filter(({ start, end }) => end > start && !placeholder.test(text.slice(start, end)))
    .toSorted((a, b) => a.start - b.start || b.end - a.end);
  const joined: { start: number; end: number; label: string }[] = [];
  for (const span of ordered) {
    const last = joined.at(-1);
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (strength.indexOf(span.label) < strength.indexOf(last.label)) last.label = span.label;
    } else joined.push({ ...span });
  }
  let masked = "";
  let at = 0;
  for (const span of joined) {
    masked += text.slice(at, span.start) + span.label;
    at = span.end;
  }
  return masked + text.slice(at);
};

const maxLines = 40;
const maxLine = 400;
const maxCauses = 3;

const bounded = (message: string, lineLength = maxLine) => {
  const lines = message.replace(/\s+$/u, "").split("\n");
  const kept = lines
    .slice(0, maxLines)
    .map((line) => (line.length > lineLength ? `${line.slice(0, lineLength)}…` : line));
  if (lines.length > maxLines) kept.push(`… ${lines.length - maxLines} more lines`);
  return kept.join("\n");
};

/** One free text, such as a page error or a console message: masked in full, then bounded. */
export const safeText = (text: string): string => bounded(mask(text));

// Node and undici codes are short constants, such as ERR_INVALID_PROTOCOL or ECONNREFUSED.
const codePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const codeDepth = 8;

/** The next level of a cause chain: an Effect `HttpClientError`'s `reason`, else `cause`. */
export const nextCause = (value: object): unknown => {
  const { reason, cause } = value as { reason?: unknown; cause?: unknown };
  return typeof reason === "object" && reason !== null ? reason : cause;
};

/**
 * The first Node or undici error code on a cause chain, read from each level's `code` property
 * and never from message text. It walks the chain by `nextCause`, deeper than `failureParts`
 * does: fetch's `TypeError` holds the socket error that has the code.
 */
export const errorCode = (cause: unknown): string | undefined => {
  let current = cause;
  for (
    let level = 0;
    level < codeDepth && typeof current === "object" && current !== null;
    level++
  ) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && codePattern.test(code)) return code;
    current = nextCause(current);
  }
  return undefined;
};

const describeOne = (value: unknown): { readonly text: string; readonly next: unknown } => {
  if (typeof value === "string") return { text: safeText(value), next: undefined };
  if (value === null || typeof value !== "object")
    return { text: `A thrown ${value === null ? "null" : typeof value}`, next: undefined };
  const error = value as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const name =
    typeof error.name === "string" && /^[A-Za-z][\w$]*$/u.test(error.name)
      ? error.name
      : (value.constructor?.name ?? "Object");
  const code =
    typeof error.code === "string" && codePattern.test(error.code) ? ` [${error.code}]` : "";
  const message = typeof error.message === "string" ? error.message : "";
  const nested =
    value instanceof AggregateError && error.cause === undefined
      ? value.errors.slice(0, maxCauses)
      : error.cause;
  return {
    text: safeText(`${name}${code}${message === "" ? "" : `: ${message}`}`),
    next: nested,
  };
};

/**
 * The safe text of a thrown value and its causes, one entry each: its name, code and message, then
 * each cause or aggregated error's, each masked. Never empty.
 */
export const failureParts = (thrown: unknown): ReadonlyArray<string> => {
  const parts: string[] = [];
  const queue: unknown[] = [thrown];
  while (queue.length > 0 && parts.length <= maxCauses) {
    const current = queue.shift();
    if (Redacted.isRedacted(current)) {
      parts.push("A redacted value");
      continue;
    }
    const { text, next } = describeOne(current);
    parts.push(text);
    if (Array.isArray(next)) queue.push(...next);
    else if (next !== undefined) queue.push(next);
  }
  return parts;
};

/** The safe text of a thrown value, each cause on its own `Caused by:` line. Never empty. */
export const failureText = (thrown: unknown): string => failureParts(thrown).join("\nCaused by: ");

const causeTexts = new WeakMap<Redacted.Redacted<unknown>, string>();
const heldCauses = new WeakMap<object, Redacted.Redacted<unknown>>();

/**
 * Keep an error's redacted cause beside it. A test runner's error serializer may replace the
 * error's own `cause` property in place before it reads the message.
 */
export const keepCause = (error: object, cause: Redacted.Redacted<unknown> | undefined) => {
  if (cause !== undefined) heldCauses.set(error, cause);
};

/** The safe text of each level of the cause kept for `error`, if one was. */
export const keptCauseParts = (error: object): ReadonlyArray<string> | undefined => {
  const cause = heldCauses.get(error);
  return cause === undefined ? undefined : failureParts(Redacted.value(cause));
};

/** The safe text of the cause kept for `error`, if one was. */
export const keptCauseText = (error: object): string | undefined => {
  const cause = heldCauses.get(error);
  return cause === undefined ? undefined : causeText(cause);
};

/**
 * The safe text of a redacted cause, built when a message is first read and kept. A failure that
 * is retried or ignored is never printed, so it costs nothing to mask. A list of causes, such as
 * a response replacement's failures, gives one line each.
 */
export const causeText = (cause: Redacted.Redacted<unknown>): string => {
  const known = causeTexts.get(cause);
  if (known !== undefined) return known;
  const value = Redacted.value(cause);
  const text = Array.isArray(value) ? value.map(failureText).join("\n") : failureText(value);
  causeTexts.set(cause, text);
  return text;
};

/** Indent every line after the first, so a multi-line text reads as one item of a list. */
export const indented = (text: string, by = "  ") =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${by}${line}`))
    .join("\n");

/**
 * What a failed step says, masked: the first failure's name and message. A driver failure's
 * message already carries its cause's text; any other error's own cause is not followed.
 */
export const stepFailureText = (cause: Cause.Cause<unknown>): string => {
  const reason = cause.reasons.find((reason) => !Cause.isInterruptReason(reason));
  if (reason === undefined) return "Interrupted";
  const value = Cause.isFailReason(reason)
    ? reason.error
    : Cause.isDieReason(reason)
      ? reason.defect
      : undefined;
  if (value === null || typeof value !== "object") return failureText(value);
  const { name, message } = value as { name?: unknown; message?: unknown };
  // A driver failure's message indents its cause's lines, which were cut to length already, so
  // they are not cut again: the step says what the log says.
  return bounded(
    mask(
      `${typeof name === "string" ? name : "Error"}${typeof message === "string" ? `: ${message}` : ""}`,
    ),
    maxLine + 16,
  );
};

/** A secret read from configuration, registered as it is read. */
export const secretConfig = (name: string) =>
  Config.Redacted(name).pipe(
    Config.map((value) => {
      holdSecret(value);
      return value;
    }),
  );
