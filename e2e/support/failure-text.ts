import { Cause, Config, Redacted, Schema } from "effect";

const revealed = new Set<string>();
const shortest = 6;

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

const credentialKey =
  /(?:password|passwd|secret|token|apikey|api_key|key|code|cookie|session|credential|signature|proof)s?$/iu;

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
  if (typeof record.name === "string" && typeof record.value === "string") {
    holdString(record.value);
    return;
  }
  for (const [key, field] of Object.entries(record))
    hold(field, depth + 1, under || credentialKey.test(key));
};

const holdValue = (value: unknown): void => {
  if (typeof value === "string") holdString(value);
  else if (Array.isArray(value)) for (const item of value) holdValue(item);
  else hold(value, 0, false);
};

export const reveal = <A>(secret: Redacted.Redacted<A>): A => {
  const value = Redacted.value(secret);
  holdValue(value);
  return value;
};

export const holdSecret = (secret: Redacted.Redacted<unknown>): void => {
  reveal(secret);
};

export const secret = <A>(value: A): Redacted.Redacted<A> => {
  holdValue(value);
  return Redacted.make(value);
};

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
  const folded = text.toLowerCase();
  for (const secret of revealed) {
    const [within, sought] = secret.includes("%") ? [folded, secret.toLowerCase()] : [text, secret];
    for (let at = within.indexOf(sought); at !== -1; at = within.indexOf(sought, at + 1))
      found.push({ start: at, end: at + sought.length, label: "<secret>" });
  }
  for (const match of text.matchAll(token)) {
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

const strength = [dropped, "<secret>", "<value>", "<opaque>"];
const placeholder = /^<(?:secret|value|opaque)>$/u;

export const mask = (text: string): string => {
  const ordered = spans(text)
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

export const safeText = (text: string): string => bounded(mask(text));

const codePattern = /^[A-Z][A-Z0-9_/]{1,63}$/u;
const codeDepth = 8;

export const nextCause = (value: object): unknown => {
  const { reason, cause } = value as { reason?: unknown; cause?: unknown };
  return typeof reason === "object" && reason !== null ? reason : cause;
};

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

export const failureText = (thrown: unknown): string => failureParts(thrown).join("\nCaused by: ");

const causeTexts = new WeakMap<Redacted.Redacted<unknown>, string>();
const heldCauses = new WeakMap<object, Redacted.Redacted<unknown>>();

export const keepCause = (error: object, cause: Redacted.Redacted<unknown> | undefined) => {
  if (cause !== undefined) heldCauses.set(error, cause);
};

export const keptCauseParts = (error: object): ReadonlyArray<string> | undefined => {
  const cause = heldCauses.get(error);
  return cause === undefined ? undefined : failureParts(Redacted.value(cause));
};

export const keptCauseText = (error: object): string | undefined => {
  const cause = heldCauses.get(error);
  return cause === undefined ? undefined : causeText(cause);
};

export const causeText = (cause: Redacted.Redacted<unknown>): string => {
  const known = causeTexts.get(cause);
  if (known !== undefined) return known;
  const value = Redacted.value(cause);
  const text = Array.isArray(value) ? value.map(failureText).join("\n") : failureText(value);
  causeTexts.set(cause, text);
  return text;
};

export const indented = (text: string, by = "  ") =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${by}${line}`))
    .join("\n");

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
  return bounded(
    mask(
      `${typeof name === "string" ? name : "Error"}${typeof message === "string" ? `: ${message}` : ""}`,
    ),
    maxLine + 16,
  );
};

export const secretConfig = (name: string) =>
  Config.Redacted(name).pipe(
    Config.map((value) => {
      holdSecret(value);
      return value;
    }),
  );
