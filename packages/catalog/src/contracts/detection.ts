/**
 * How a remote MCP server is connected, decided from what the server itself answers to requests
 * made without credentials. Signals carry statuses and shapes, never URLs, bodies or values.
 */
import { Schema } from "effect";
import {
  AuthorizationServerSignal,
  OAuthClientRegistration,
  ResourceMetadataSignal,
} from "@executor-js/sdk";

/** Whether a 2xx answer held the JSON-RPC result or error for the request. */
export const McpAnswer = Schema.Literals(["result", "error", "none"]);
export type McpAnswer = typeof McpAnswer.Type;
/** The response's media type, which tells an MCP or OAuth answer from a web page. */
export const McpMedia = Schema.Literals(["json", "event-stream", "html", "text", "other", "none"]);
export type McpMedia = typeof McpMedia.Type;
/** A WWW-Authenticate challenge's scheme, and which Bearer parameters it names. */
export const McpChallenge = Schema.Struct({
  scheme: Schema.Literals(["bearer", "basic", "other"]),
  resourceMetadata: Schema.Boolean,
  scope: Schema.Boolean,
});
export type McpChallenge = typeof McpChallenge.Type;
/** One MCP request made without credentials and how the server answered it. */
export const McpRequestSignal = Schema.TaggedStruct("McpRequest", {
  method: Schema.Literals(["initialize", "tools/list"]),
  status: Schema.Int,
  media: McpMedia,
  answer: McpAnswer,
  challenge: Schema.optionalKey(McpChallenge),
});
export type McpRequestSignal = typeof McpRequestSignal.Type;
/** Everything a check observed, in order. */
export const McpSignal = Schema.Union([
  McpRequestSignal,
  ResourceMetadataSignal,
  AuthorizationServerSignal,
]).pipe(Schema.toTaggedUnion("_tag"));
export type McpSignal = typeof McpSignal.Type;

/** Why Executor could not tell how to connect. The first three can succeed on a later try. */
export const McpUndeterminedReason = Schema.Literals([
  "unavailable",
  "unreachable",
  "timeout",
  "redirected",
  "refused",
  "not_mcp",
  "initialize_error",
  "tools_error",
  "oauth_unusable",
]);
export type McpUndeterminedReason = typeof McpUndeterminedReason.Type;

/**
 * The connection a check decided, with the signals that decided it:
 *
 * - `Anonymous`: initialize and tools/list succeeded without credentials. When the server also
 *   advertises OAuth, `oauth` names how a client is obtained so an account can be added later.
 * - `OAuth`: the server rejected anonymous use and advertises OAuth an account connection can
 *   complete. `registration` says whether Executor gets a client itself or the user supplies one.
 * - `CredentialsRequired`: the server rejected anonymous use and advertises no OAuth, so it needs
 *   an API key or other credentials. `scheme` is the challenge it sent, if any.
 * - `Undetermined`: anything else, with the specific reason.
 */
export const McpDetection = Schema.TaggedUnion({
  Anonymous: {
    oauth: Schema.optionalKey(OAuthClientRegistration),
    signals: Schema.Array(McpSignal),
  },
  OAuth: { registration: OAuthClientRegistration, signals: Schema.Array(McpSignal) },
  CredentialsRequired: {
    scheme: Schema.Literals(["bearer", "basic", "other", "unspecified"]),
    signals: Schema.Array(McpSignal),
  },
  Undetermined: { reason: McpUndeterminedReason, signals: Schema.Array(McpSignal) },
});
export type McpDetection = typeof McpDetection.Type;
