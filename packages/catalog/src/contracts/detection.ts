import { Schema } from "effect";
import {
  AuthorizationServerSignal,
  OAuthClientRegistration,
  ResourceMetadataSignal,
} from "@executor-js/sdk";

export const McpAnswer = Schema.Literals(["result", "error", "none"]);
export type McpAnswer = typeof McpAnswer.Type;
export const McpMedia = Schema.Literals(["json", "event-stream", "html", "text", "other", "none"]);
export type McpMedia = typeof McpMedia.Type;
export const McpChallenge = Schema.Struct({
  scheme: Schema.Literals(["bearer", "basic", "other"]),
  resourceMetadata: Schema.Boolean,
  scope: Schema.Boolean,
});
export type McpChallenge = typeof McpChallenge.Type;
export const McpRequestSignal = Schema.TaggedStruct("McpRequest", {
  method: Schema.Literals(["initialize", "tools/list"]),
  status: Schema.Int,
  media: McpMedia,
  answer: McpAnswer,
  challenge: Schema.optionalKey(McpChallenge),
});
export type McpRequestSignal = typeof McpRequestSignal.Type;
export const McpSignal = Schema.Union([
  McpRequestSignal,
  ResourceMetadataSignal,
  AuthorizationServerSignal,
]).pipe(Schema.toTaggedUnion("_tag"));
export type McpSignal = typeof McpSignal.Type;

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
