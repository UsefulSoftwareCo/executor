/**
 * The error a service stated in its own documented error format: a nested error object (JSON-RPC
 * and many REST APIs), an OAuth error body, or a Bearer challenge. Undocumented bodies, such as a bare `message`, are never read.
 */
import { Option, Schema } from "effect";
import { maxUpstreamMessageLength, UpstreamError } from "../contracts/failure.ts";

/** An OAuth or Bearer error code: a short token such as `invalid_token`, never prose. */
const ErrorToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u));

/**
 * A nested `error` object with a code and a message: a JSON-RPC 2.0 error response, as an MCP
 * server answers a request it refuses, or the same shape many REST APIs answer with, whose code
 * may be a token.
 */
const NestedError = Schema.Struct({
  error: Schema.Struct({ code: Schema.Union([Schema.Int, ErrorToken]), message: Schema.String }),
});
/** An OAuth 2.0 error response body (RFC 6749, section 5.2). */
const OAuthError = Schema.Struct({
  error: ErrorToken,
  error_description: Schema.optional(Schema.String),
});

/**
 * A stated message is bounded where it is read, before the invocation's account secrets are known,
 * so a cut can split a secret. Leaving the bundle replaces the part of one a shortened message
 * ends with; see `isShortenedUpstream`.
 */
const bounded = (message: string) =>
  message.length <= maxUpstreamMessageLength
    ? message
    : `${message.slice(0, maxUpstreamMessageLength - 1)}…`;

/** Whether `bounded` shortened this message, so it may end partway through a secret. */
export const isShortenedUpstream = (message: string) =>
  message.length === maxUpstreamMessageLength && message.endsWith("…");

const stated = (code: number | string, message: string | undefined): UpstreamError => ({
  code,
  ...(message === undefined || message === "" ? {} : { message: bounded(message) }),
});

/** The error a JSON error body states, if it uses a nested error object or OAuth's format. */
export const bodyUpstreamError = (json: unknown): UpstreamError | undefined => {
  const nested = Schema.decodeUnknownOption(NestedError)(json);
  if (Option.isSome(nested)) return stated(nested.value.error.code, nested.value.error.message);
  const oauth = Schema.decodeUnknownOption(OAuthError)(json);
  if (Option.isSome(oauth)) return stated(oauth.value.error, oauth.value.error_description);
  return undefined;
};

/** One auth-param: a token, `=`, then a token or a quoted string with backslash escapes. */
const authParam = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;

/** The `error` and `error_description` of a Bearer challenge (RFC 6750, section 3). */
export const challengeUpstreamError = (header: string | undefined): UpstreamError | undefined => {
  const bearer = header === undefined ? -1 : header.search(/\bBearer\b/i);
  if (header === undefined || bearer === -1) return undefined;
  const params = new Map<string, string>();
  for (const [, name, quoted, token] of header.slice(bearer + "Bearer".length).matchAll(authParam))
    if (name !== undefined && !params.has(name.toLowerCase()))
      params.set(name.toLowerCase(), quoted?.replace(/\\(.)/g, "$1") ?? token ?? "");
  const code = Schema.decodeUnknownOption(ErrorToken)(params.get("error"));
  return Option.isNone(code) ? undefined : stated(code.value, params.get("error_description"));
};
