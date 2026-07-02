// ---------------------------------------------------------------------------
// Client fingerprint capture
// ---------------------------------------------------------------------------
// Annotates the Effect span with everything we can learn about a connecting MCP client: the
// parsed JSON-RPC body, whitelisted request headers, CF request metadata,
// and verified-JWT claims. Lets us compare how each client (Claude Code,
// Claude.ai web, ChatGPT, custom scripts, ...) actually reports over the
// wire. Runs before dispatch so unauthorized requests still get fingerprinted.
//
// No envelope seam exists for this; the cloud McpAuthProvider invokes
// `annotateMcpRequest` inside its `authenticate` so telemetry parity holds.
// ---------------------------------------------------------------------------

import { Effect, Match, Option, Schema } from "effect";

import { BEARER_PREFIX } from "../auth/bearer";
import type { VerifiedToken } from "./auth";

type CfRequestMetadata = {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  httpProtocol?: string;
  colo?: string;
};

const requestWithCf = (request: Request): Request & { cf?: CfRequestMetadata } =>
  request as Request & { cf?: CfRequestMetadata };

const getCfMeta = (request: Request): CfRequestMetadata => requestWithCf(request).cf ?? {};

const HEADERS_TO_DUMP = [
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-client-name",
  "x-client-version",
  "x-requested-with",
] as const;

const dumpHeaders = (request: Request): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of HEADERS_TO_DUMP) {
    const value = request.headers.get(name);
    if (value !== null) out[`mcp.http.header.${name}`] = value;
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    out["mcp.http.header.authorization.scheme"] = authHeader.split(" ", 1)[0] ?? "";
    out["mcp.http.header.authorization.length"] = String(authHeader.length);
  }
  // Record the full header name list too — surfaces anything unexpected
  // without us having to enumerate every possibility up front.
  out["mcp.http.header.names"] = Array.from(request.headers.keys()).sort().join(",");
  return out;
};

// JSON-RPC shapes — narrow to just the fields we fingerprint. Using Schema
// collapses the typeof-guard pile and surfaces "what does an MCP client
// actually send us" as declarative types. Unknown/malformed input decodes
// to None and contributes no span attrs.

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const JsonRpcEnvelope = Schema.Struct({
  method: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  params: Schema.optional(UnknownRecord),
  // Responses to server-initiated requests arrive as POST bodies too —
  // notably elicitation replies (`result.action = "accept" | "decline" | "cancel"`).
  result: Schema.optional(UnknownRecord),
});
type JsonRpcEnvelope = typeof JsonRpcEnvelope.Type;

const ElicitationReplyResult = Schema.Struct({
  action: Schema.optional(Schema.Literals(["accept", "decline", "cancel"])),
});

const InitializeParams = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
  clientInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
  capabilities: Schema.optional(UnknownRecord),
});

const NamedParams = Schema.Struct({ name: Schema.optional(Schema.String) });
const UriParams = Schema.Struct({ uri: Schema.optional(Schema.String) });

const decodeJsonRpcEnvelopeString = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonRpcEnvelope),
);
const decodeInitializeParams = Schema.decodeUnknownOption(InitializeParams);
const decodeNamedParams = Schema.decodeUnknownOption(NamedParams);
const decodeUriParams = Schema.decodeUnknownOption(UriParams);
const decodeElicitationReplyResult = Schema.decodeUnknownOption(ElicitationReplyResult);

const readJsonRpcEnvelope = (request: Request): Effect.Effect<Option.Option<JsonRpcEnvelope>> =>
  Effect.tryPromise({
    try: () => request.clone().text(),
    catch: () => undefined,
  }).pipe(
    Effect.map((text) => (text ? decodeJsonRpcEnvelopeString(text) : Option.none())),
    Effect.catchCause(() => Effect.succeed(Option.none())),
    Effect.withSpan("mcp.request.read_json_rpc"),
  );

const methodAttrs = (envelope: JsonRpcEnvelope): Record<string, unknown> => {
  const params = envelope.params ?? {};
  return Match.value(envelope.method).pipe(
    Match.when("initialize", () =>
      Option.match(decodeInitializeParams(params), {
        onNone: () => ({}) as Record<string, unknown>,
        onSome: (init) => ({
          ...(init.protocolVersion && { "mcp.client.protocol_version": init.protocolVersion }),
          ...(init.clientInfo?.name && { "mcp.client.name": init.clientInfo.name }),
          ...(init.clientInfo?.version && { "mcp.client.version": init.clientInfo.version }),
          ...(init.clientInfo?.title && { "mcp.client.title": init.clientInfo.title }),
          "mcp.client.capability.keys": Object.keys(init.capabilities ?? {})
            .sort()
            .join(","),
        }),
      }),
    ),
    Match.when("tools/call", () =>
      Option.match(decodeNamedParams(params), {
        onNone: () => ({}) as Record<string, unknown>,
        onSome: ({ name }) => (name ? { "mcp.tool.name": name } : {}),
      }),
    ),
    Match.whenOr("resources/read", "resources/subscribe", () =>
      Option.match(decodeUriParams(params), {
        onNone: () => ({}) as Record<string, unknown>,
        onSome: ({ uri }) => (uri ? { "mcp.resource.uri": uri } : {}),
      }),
    ),
    Match.when("prompts/get", () =>
      Option.match(decodeNamedParams(params), {
        onNone: () => ({}) as Record<string, unknown>,
        onSome: ({ name }) => (name ? { "mcp.prompt.name": name } : {}),
      }),
    ),
    Match.option,
    Option.getOrElse(() => ({}) as Record<string, unknown>),
  );
};

const replyAttrs = (envelope: JsonRpcEnvelope): Record<string, unknown> => {
  if (!envelope.result || envelope.method) return {};
  return Option.match(decodeElicitationReplyResult(envelope.result), {
    onNone: () => ({}),
    onSome: ({ action }) => (action ? { "mcp.elicitation.action": action } : {}),
  });
};

const rpcAttrs = (envelope: Option.Option<JsonRpcEnvelope>): Record<string, unknown> =>
  Option.match(envelope, {
    onNone: () => ({}),
    onSome: (e) => ({
      ...(e.method && { "mcp.rpc.method": e.method }),
      ...(e.id !== undefined && e.id !== null && { "mcp.rpc.id": String(e.id) }),
      ...methodAttrs(e),
      ...replyAttrs(e),
    }),
  });

export const annotateMcpRequest = (
  request: Request,
  opts: { token: VerifiedToken | null; parseBody: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cf = getCfMeta(request);
    const baseAttrs: Record<string, unknown> = {
      "mcp.request.method": request.method,
      "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
      "mcp.request.session_id": request.headers.get("mcp-session-id") ?? "",
      "mcp.auth.has_bearer": (request.headers.get("authorization") ?? "").startsWith(BEARER_PREFIX),
      "mcp.auth.verified": !!opts.token,
      "mcp.auth.organization_id": opts.token?.organizationId ?? "",
      "mcp.auth.account_id": opts.token?.accountId ?? "",
      "cf.country": cf.country ?? "",
      "cf.city": cf.city ?? "",
      "cf.region": cf.region ?? "",
      "cf.timezone": cf.timezone ?? "",
      "cf.asn": cf.asn ?? 0,
      "cf.as_organization": cf.asOrganization ?? "",
      "cf.tls_version": cf.tlsVersion ?? "",
      "cf.tls_cipher": cf.tlsCipher ?? "",
      "cf.http_protocol": cf.httpProtocol ?? "",
      "cf.colo": cf.colo ?? "",
      ...dumpHeaders(request),
    };

    const envelope = opts.parseBody ? yield* readJsonRpcEnvelope(request) : Option.none();
    const attrs = {
      ...baseAttrs,
      ...rpcAttrs(envelope),
      "mcp.request.parse_body": opts.parseBody,
    };

    yield* Effect.annotateCurrentSpan(attrs);
    yield* Effect.annotateCurrentSpan(attrs).pipe(Effect.withSpan("mcp.request.annotate"));
  });
