import { Match, Option, Predicate, Redacted, Schema } from "effect";
import { CacheError } from "@executor-js/app-cache/contracts";
import { OpenapiError } from "../contracts/openapi.ts";
import { OpenapiCompileError } from "../contracts/openapi-compile.ts";
import { FetchOptionUnsupported, NetworkRefused } from "../contracts/network.ts";
import {
  McpError as HostMcpError,
  SkillLoadFailed as HostSkillLoadFailed,
  type ResolvedAccounts,
} from "../contracts/host.ts";
import { McpCredentialsUnverified, McpError } from "../contracts/mcp.ts";
import { SkillLoadFailed } from "../contracts/skills.ts";
import type { ProviderError } from "../contracts/provider-error.ts";
import { providerError } from "./provider-error.ts";
import { isShortenedUpstream } from "./upstream-error.ts";
import {
  FailureCode,
  FailureFieldName,
  maxFailureFieldLength,
  maxFailureFields,
  maxFailureMessageLength,
  maxUpstreamMessageLength,
  type FailureFields,
  type FailurePhase,
  type UpstreamError,
} from "../contracts/failure.ts";

/** Fields of `FailureDetail` as constructor input. */
export interface FailureDetail {
  readonly source?: "app" | "storage" | "service";
  readonly errorName?: string;
  readonly code?: string;
  readonly message?: string;
  readonly fields?: FailureFields;
}

/** Fixed text per reason; cache keys, values and scopes never enter the message. */
const cacheMessages = {
  capacity: "A cache key, value or batch exceeded the app cache's size limits.",
  invalid: "The app made a cache request the app cache could not accept.",
  unavailable: "The app cache is not available on this host.",
  storage: "The app cache failed to complete the operation.",
  timeout: "The app cache did not respond in time.",
} satisfies Record<CacheError["reason"], string>;

/** What the client was doing when an MCP server failed. */
const mcpStages = {
  connect: "connecting",
  transport: "connecting",
  discover: "listing its tools",
  schema: "reading a tool's schema",
  call: "calling a tool",
} satisfies Record<McpError["phase"], string>;

/** Fixed text from the safe fields; server URLs, headers and responses never enter the message. */
const mcpMessage = ({ phase, reason, status }: McpError) => {
  const stage = mcpStages[phase];
  return Match.value(reason).pipe(
    Match.when("timeout", () => `The MCP server did not respond in time while ${stage}.`),
    Match.when("unauthorized", () => `The MCP server rejected the credentials while ${stage}.`),
    Match.when(
      "invalid_response",
      () =>
        `The MCP server returned a response Executor could not use while ${stage}, such as an unreadable message or an address on another origin.`,
    ),
    Match.when("invalid_input", () => "The MCP server URL or connection settings are invalid."),
    // Only a transport failure has no answer from the server; a JSON-RPC error is an answer.
    Match.when("request", () =>
      status !== undefined
        ? `The MCP server answered HTTP ${status} while ${stage}.`
        : phase === "transport"
          ? `Executor could not reach the MCP server while ${stage}.`
          : `The request to the MCP server failed while ${stage}.`,
    ),
    Match.exhaustive,
  );
};

/** Fixed text for an `mcpHealth` check that could not show the server needs the credentials. */
const unverifiedMessage = ({ anonymous }: McpCredentialsUnverified) =>
  anonymous === "answered"
    ? "This MCP server answers without credentials, so Executor can't check this account. A refused key will show up when a tool is called."
    : `The MCP server accepted the credentials, but the same check without them failed, so Executor can't tell whether it requires them. ${
        Schema.is(McpError)(anonymous)
          ? mcpMessage(anonymous)
          : anonymous.status === undefined
            ? "The MCP server could not answer the request."
            : `The MCP server answered HTTP ${anonymous.status}.`
      }`;

/** Account field values of at least this length are replaced wherever a message contains them. */
const minimumSecretLength = 6;

const secretValues = (value: unknown, found: Set<string>): Set<string> => {
  if (typeof value === "string") {
    if (value.length >= minimumSecretLength) found.add(value);
  } else if (Array.isArray(value)) for (const item of value) secretValues(item, found);
  else if (Predicate.isObject(value))
    for (const item of Object.values(value)) secretValues(item, found);
  return found;
};

/**
 * Every credential field value of a slot-to-account record, longest first. Accepts both resolved
 * host accounts and bound author accounts; each account keeps its credential values in `fields`.
 */
export const accountFieldSecrets = (accounts: unknown) => {
  const found = new Set<string>();
  if (Predicate.isObject(accounts))
    for (const slot of Object.values(accounts))
      for (const account of Array.isArray(slot) ? slot : [slot])
        if (Predicate.hasProperty(account, "fields")) secretValues(account.fields, found);
  return [...found].sort((a, b) => b.length - a.length);
};

/** Every credential field value of an invocation's selected accounts. */
export const accountSecrets = (accounts: Redacted.Redacted<ResolvedAccounts>) =>
  accountFieldSecrets(Redacted.value(accounts));

/** Replace every whole account secret in the text. */
const replaceSecrets = (text: string, secrets: readonly string[]) => {
  let redacted = text;
  for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
  return redacted;
};

const bound = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/** Replace account secrets, then bound the text to `maximum` characters. */
const boundText = (text: string, secrets: readonly string[], maximum: number) =>
  bound(replaceSecrets(text, secrets), maximum);

/**
 * Replace the start of an account secret that the text ends with, as text cut before its secrets
 * were known can. Every secret the cut split ends the text, so replacing the longest such ending
 * replaces them all.
 */
const replaceSecretStart = (text: string, secrets: readonly string[]) => {
  let longest = 0;
  for (const secret of secrets)
    for (let length = Math.min(secret.length - 1, text.length); length > longest; length--)
      if (text.endsWith(secret.slice(0, length))) {
        longest = length;
        break;
      }
  return longest === 0 ? text : `${text.slice(0, -longest)}[redacted]`;
};

/** Replace account secrets and bound the message for the runtime boundary. */
export const boundFailureMessage = (message: string, secrets: readonly string[]) =>
  boundText(message, secrets, maxFailureMessageLength);

/**
 * Replace account secrets in the error a service stated, as it leaves the bundle. A message
 * shortened where it was read can end partway through a secret; that part is replaced too.
 */
export const redactUpstream = (
  upstream: UpstreamError | undefined,
  secrets: readonly string[],
): UpstreamError | undefined => {
  if (upstream?.message === undefined) return upstream;
  const message = isShortenedUpstream(upstream.message)
    ? `${replaceSecretStart(replaceSecrets(upstream.message.slice(0, -1), secrets), secrets)}…`
    : replaceSecrets(upstream.message, secrets);
  return { code: upstream.code, message: bound(message, maxUpstreamMessageLength) };
};

/**
 * A provider failure as it leaves the bundle: in the phase it happened, unless its raiser named a
 * more precise one, with account secrets replaced in the error the service stated.
 */
export const leavingProviderError = (
  error: ProviderError,
  secrets: readonly string[],
  phase?: FailurePhase,
) =>
  providerError({
    ...error,
    phase: error.phase ?? phase,
    upstream: redactUpstream(error.upstream, secrets),
  });

/**
 * Rebuild an MCP failure's allowlisted fields, with account secrets replaced in the server's
 * error. Absent fields have no key, as catalogs cross the boundary as JSON values.
 */
export const parseMcpError = (
  error: unknown,
  secrets: readonly string[],
): Option.Option<HostMcpError> =>
  Schema.decodeUnknownOption(McpError)(error).pipe(
    Option.map(({ phase, reason, status, upstream, session, initialized, fallback }) => {
      const stated = redactUpstream(upstream, secrets);
      return new HostMcpError({
        phase,
        reason,
        ...(status === undefined ? {} : { status }),
        ...(stated === undefined ? {} : { upstream: stated }),
        ...(session === undefined ? {} : { session }),
        ...(initialized === undefined ? {} : { initialized }),
        ...(fallback === undefined ? {} : { fallback }),
      });
    }),
  );

/** Rebuild only the allowlisted skill loader fields from an author-visible rejection. */
export const parseSkillLoadFailed = (error: unknown): Option.Option<HostSkillLoadFailed> =>
  Schema.decodeUnknownOption(SkillLoadFailed)(error).pipe(
    Option.map(
      ({ reason, message, status, missing }) =>
        new HostSkillLoadFailed({
          reason,
          ...(message ? { message } : {}),
          ...(status === undefined ? {} : { status }),
          ...(missing === undefined ? {} : { missing }),
        }),
    ),
  );

const errorName = (error: Error) => (error.name.length > 0 ? error.name : "Error").slice(0, 128);

/** The thrown error's own `code`, when it is short text such as `ECONNRESET`. */
const ownCode = (error: Error, secrets: readonly string[]) =>
  Predicate.hasProperty(error, "code") && Schema.is(FailureCode)(error.code) && error.code !== ""
    ? boundText(error.code, secrets, 128)
    : undefined;

/** Properties that are the error itself, or that it already carries in its own slot. */
const reservedFields = new Set(["name", "message", "stack", "cause", "_tag"]);

/**
 * The thrown error's own scalar fields, such as `reason` or `pointer`, in their declared order.
 * Text is bounded with account secrets replaced; objects, arrays and functions are left out.
 */
const ownFields = (error: Error, code: string | undefined, secrets: readonly string[]) => {
  const fields: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(error)) {
    if (count === maxFailureFields) break;
    if (reservedFields.has(key) || (key === "code" && code !== undefined)) continue;
    if (!Schema.is(FailureFieldName)(key)) continue;
    if (typeof value === "string") fields[key] = boundText(value, secrets, maxFailureFieldLength);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      fields[key] = value;
    else continue;
    count++;
  }
  return count === 0 ? undefined : fields;
};

const ownMessage = (error: Error) => {
  const cause = error.cause;
  const suffix =
    cause instanceof Error && cause.message.length > 0
      ? ` (caused by ${errorName(cause)}: ${cause.message})`
      : "";
  return error.message.length > 0 ? `${error.message}${suffix}` : undefined;
};

/** `Name: message` for any thrown value, before redaction. */
export const describeFailure = (error: unknown) =>
  error instanceof Error
    ? `${errorName(error)}: ${ownMessage(error) ?? "(no message)"}`
    : typeof error === "string"
      ? error
      : `A non-Error ${error === null ? "null" : typeof error} value was thrown`;

/**
 * Name the failed operation by method and templated path, and an unmatched response by its
 * status, media type and declared length. Response text never enters the message, which is also
 * recorded in traces.
 */
const openapiFailureMessage = (error: OpenapiError) => {
  const operation =
    error.operation === undefined
      ? "The API request"
      : `${error.operation.method} ${error.operation.path}`;
  if (error.reason === "invalid_definition")
    return "The API's OpenAPI definition for this operation is invalid.";
  if (error.reason === "invalid_input")
    return error.operation === undefined
      ? "The input could not be encoded as a request for this API operation."
      : `The input could not be encoded as a request for ${operation}.`;
  if (error.status === undefined) return `${operation} failed before a response arrived.`;
  const shape = [error.contentType, error.bytes === undefined ? undefined : `${error.bytes} bytes`]
    .filter((part) => part !== undefined)
    .join(", ");
  const response = `${operation} responded with HTTP ${error.status}${shape === "" ? "" : ` (${shape})`}`;
  return error.status >= 200 && error.status < 300
    ? `${response}, but its body could not be read within the response limits.`
    : `${response}, which matches no error with a message in the API's OpenAPI document.`;
};

/**
 * Describe what an operation raised for the app's own caller. App data failures keep their
 * reason as a code, as do app cache failures and OpenAPI and MCP service failures, such as an
 * `mcpHealth` check that cannot reach its server or cannot verify the credentials; any other thrown
 * value is the app's own error, with its own code and scalar fields. Account secrets are replaced.
 */
export const failureDetail = (error: unknown, secrets: readonly string[]): FailureDetail => {
  if (Schema.is(CacheError)(error))
    return {
      source: "storage",
      errorName: "CacheError",
      code: error.reason,
      message: cacheMessages[error.reason],
    };
  if (Schema.is(OpenapiError)(error))
    return {
      source: "service",
      errorName: "OpenapiError",
      code: error.reason,
      message: boundFailureMessage(openapiFailureMessage(error), secrets),
    };
  if (Schema.is(McpError)(error))
    return {
      source: "service",
      errorName: "McpError",
      code: error.reason,
      message: mcpMessage(error),
    };
  if (Schema.is(McpCredentialsUnverified)(error))
    return {
      source: "service",
      errorName: "McpCredentialsUnverified",
      code: error.anonymous === "answered" ? "anonymous_access" : error.anonymous.reason,
      message: unverifiedMessage(error),
    };
  // The OpenAPI helper runs in the app and reads a definition the app chose, so its compile
  // failures are the app's: their code and message say what to change.
  if (Schema.is(OpenapiCompileError)(error))
    return {
      source: "app",
      errorName: "OpenapiCompileError",
      code: error.code,
      message: boundFailureMessage(error.message, secrets),
    };
  // Executor's own refusal of the app's request, and a fetch option the app runtime rejects.
  // Their messages name hosts, providers and options, never credentials.
  if (Schema.is(NetworkRefused)(error))
    return {
      source: "app",
      errorName: "NetworkRefused",
      code: error.refusal.reason,
      message: boundFailureMessage(error.message, secrets),
    };
  if (Schema.is(FetchOptionUnsupported)(error))
    return {
      source: "app",
      errorName: "FetchOptionUnsupported",
      code: error.option,
      message: boundFailureMessage(error.message, secrets),
    };
  if (error instanceof Error) {
    const code = ownCode(error, secrets);
    const fields = ownFields(error, code, secrets);
    return {
      source: "app",
      errorName: errorName(error),
      ...(code === undefined ? {} : { code }),
      message: boundFailureMessage(
        ownMessage(error) ?? `${errorName(error)} was thrown without a message.`,
        secrets,
      ),
      ...(fields === undefined ? {} : { fields }),
    };
  }
  if (typeof error === "string")
    return { source: "app", errorName: "string", message: boundFailureMessage(error, secrets) };
  return {
    source: "app",
    errorName: typeof error,
    message: `A non-Error ${error === null ? "null" : typeof error} value was thrown.`,
  };
};
