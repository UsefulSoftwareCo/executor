/**
 * Decide how to connect a remote MCP server from what it answers without credentials, following
 * the MCP authorization specification (2025-11-25 and 2026-07-28) and RFCs 9728, 8414 and 7591:
 *
 * 1. `initialize` without credentials. A 2xx with an initialize result is followed by
 *    `notifications/initialized` and `tools/list`, as any client would; both succeeding means the
 *    server works anonymously.
 * 2. Protected-resource metadata: the document a Bearer challenge names, else the path-suffixed
 *    and root well-known URLs. For an anonymous server this only records OAuth it also offers.
 * 3. Authorization-server metadata (RFC 8414, then OpenID Connect Discovery). A server that
 *    rejects anonymous use but publishes no resource metadata uses its own origin, as MCP's
 *    earlier rules did. The metadata decides how a client is obtained: a Client ID Metadata
 *    Document, dynamic registration, or a client the user registers.
 *
 * A 401, or a 403 with a sign-in challenge, rejects anonymous use. Without usable OAuth that
 * means an API key or other credentials. A 403 web page with no challenge and no OAuth is a
 * refusal, such as a firewall, not a statement about sign-in. Requests never follow redirects,
 * carry credentials, or call tools, and any session opened for the check is released.
 */
import { Effect, Option, Schema, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import { FetchHttpClient, HttpBody, HttpClient, type HttpClientResponse } from "effect/http";
import { bearerChallenge, discoverResourceOAuth } from "@executor-js/sdk/core";
import { ResourceOAuth } from "@executor-js/sdk";
import type { HostEgress } from "@executor-js/utils/url-policy";
import type { CatalogHost } from "../contracts/catalog.ts";
import {
  McpDetection,
  McpRequestSignal,
  type McpAnswer,
  type McpChallenge,
  type McpMedia,
  type McpSignal,
  type McpUndeterminedReason,
} from "../contracts/detection.ts";

const protocolVersion = "2025-11-25";
/** Bound each answer read, matching the largest single result other app reads accept. */
const maxAnswer = 16 * 1024 * 1024;

/** The transport could not complete one request. */
class McpRequestFailed extends Schema.TaggedError<McpRequestFailed>()("McpRequestFailed", {
  reason: Schema.Literals(["unreachable", "timeout"]),
}) {}

const JsonRpcResponse = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));
const InitializeResult = Schema.Struct({ protocolVersion: Schema.NonEmptyString });

const mediaOf = (contentType: string | undefined): McpMedia => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type === undefined || type === "") return "none";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "text/event-stream") return "event-stream";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  return type.startsWith("text/") ? "text" : "other";
};

/** The challenge's scheme and which Bearer parameters it names; their values stay unread. */
const challengeOf = (header: string | undefined): McpChallenge | undefined => {
  if (header === undefined || header.trim() === "") return undefined;
  const bearer = bearerChallenge(header);
  if (bearer !== undefined)
    return {
      scheme: "bearer",
      resourceMetadata: bearer.resourceMetadata !== undefined,
      scope: bearer.scopes !== undefined,
    };
  const scheme = /^\s*([!#$%&'*+.^_`|~A-Za-z0-9-]+)/.exec(header)?.[1]?.toLowerCase();
  return {
    scheme: scheme === "bearer" ? "bearer" : scheme === "basic" ? "basic" : "other",
    resourceMetadata: false,
    scope: false,
  };
};

/** The JSON-RPC response to `id` in a JSON body or the first matching Server-Sent Event. */
const readResponse = (response: HttpClientResponse.HttpClientResponse, id: number) => {
  const matching = (text: string) =>
    decodeResponse(text).pipe(Option.filter((message) => message.id === id));
  const read =
    mediaOf(response.headers["content-type"]) === "event-stream"
      ? // The server may keep the stream open after answering, so stop at the answer.
        response.stream.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode({ maxEventSize: maxAnswer })),
          Stream.map((event) => matching(event.data)),
          Stream.filter(Option.isSome),
          Stream.runHead,
          Effect.map(Option.flatten),
        )
      : response.stream.pipe(
          Stream.decodeText,
          Stream.mapAccum(
            () => 0,
            (size, chunk) => [size + chunk.length, [{ size: size + chunk.length, chunk }]] as const,
          ),
          Stream.takeWhile(({ size }) => size <= maxAnswer),
          Stream.runFold(
            () => "",
            (body, { chunk }) => body + chunk,
          ),
          Effect.map(matching),
        );
  return read.pipe(Effect.orElseSucceed(() => Option.none()));
};

type Exchange = {
  readonly status: number;
  readonly media: McpMedia;
  readonly answer: McpAnswer;
  readonly result?: unknown;
  readonly authenticate?: string;
  readonly session?: string;
};

/** POST one JSON-RPC message without credentials; read only a 2xx answer to a request. */
const post = (
  egress: HostEgress,
  url: string,
  message: { readonly method: string; readonly id?: number; readonly params?: object },
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* HttpClient.withScope(egress.client).post(url, {
        headers: { accept: "application/json, text/event-stream", ...headers },
        body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", ...message }),
      });
      const ok = response.status >= 200 && response.status < 300;
      const answer =
        ok && message.id !== undefined ? yield* readResponse(response, message.id) : Option.none();
      const authenticate = response.headers["www-authenticate"];
      const session = response.headers["mcp-session-id"];
      const exchange: Exchange = {
        status: response.status,
        media: mediaOf(response.headers["content-type"]),
        answer: Option.match(answer, {
          onNone: (): McpAnswer => "none",
          onSome: (value): McpAnswer => (value.result !== undefined ? "result" : "error"),
        }),
        ...Option.match(answer, {
          onNone: () => ({}),
          onSome: (value) => (value.result === undefined ? {} : { result: value.result }),
        }),
        ...(authenticate === undefined ? {} : { authenticate }),
        ...(ok && session !== undefined ? { session } : {}),
      };
      return exchange;
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.fail(new McpRequestFailed({ reason: "timeout" }))),
    Effect.catchTag("HttpClientError", () =>
      Effect.fail(new McpRequestFailed({ reason: "unreachable" })),
    ),
  );

const signalOf = (method: McpRequestSignal["method"], exchange: Exchange) => {
  const challenge = challengeOf(exchange.authenticate);
  return McpRequestSignal.make({
    method,
    status: exchange.status,
    media: exchange.media,
    answer: exchange.answer,
    ...(challenge === undefined ? {} : { challenge }),
  });
};

const successful = (exchange: Exchange) => exchange.status >= 200 && exchange.status < 300;

/**
 * Detect how to connect the MCP server at `url`. `discovery` is the resource whose OAuth is
 * inspected; it differs from `url` only when a product default added transport options. OAuth is
 * inspected with the host's own client settings, so the outcome matches its account setup.
 */
export const detectMcpAccess = (
  input: { readonly url: string; readonly discovery: string },
  host: CatalogHost,
) =>
  Effect.suspend(() => {
    const egress = host.egress;
    const signals: Array<McpSignal> = [];
    const undetermined = (reason: McpUndeterminedReason) =>
      McpDetection.cases.Undetermined.make({ reason, signals });
    const inspectOAuth = (authenticate: string | undefined, originFallback: boolean) =>
      discoverResourceOAuth(
        input.discovery,
        {
          httpClient: egress.client,
          urlPolicy: egress.policy,
          ...(host.clientMetadataUrl === undefined
            ? {}
            : { clientMetadataUrl: host.clientMetadataUrl }),
        },
        { resourceMetadata: bearerChallenge(authenticate)?.resourceMetadata, originFallback },
      ).pipe(Effect.tap((found) => Effect.sync(() => signals.push(...found.signals))));

    /** Anonymous use was rejected: OAuth the server advertises, or other credentials. */
    const rejected = (exchange: Exchange) =>
      Effect.gen(function* () {
        const challenge = challengeOf(exchange.authenticate);
        // A 403 without a challenge may come from a firewall rather than the server's sign-in.
        const signIn = exchange.status === 401 || challenge !== undefined;
        const oauth = yield* inspectOAuth(exchange.authenticate, signIn);
        return ResourceOAuth.match(oauth, {
          OAuthAdvertised: ({ registration }): McpDetection =>
            McpDetection.cases.OAuth.make({ registration, signals }),
          OAuthUnusable: ({ reason }): McpDetection =>
            undetermined(reason === "unavailable" ? "unavailable" : "oauth_unusable"),
          OAuthNotAdvertised: (): McpDetection =>
            !signIn && exchange.media === "html"
              ? undetermined("refused")
              : McpDetection.cases.CredentialsRequired.make({
                  scheme: challenge?.scheme ?? "unspecified",
                  signals,
                }),
        });
      });

    /** A request that did not succeed: a sign-in rejection, or why nothing could be decided. */
    const unsuccessful = (exchange: Exchange, otherwise: McpUndeterminedReason) =>
      exchange.status === 401 || exchange.status === 403
        ? rejected(exchange)
        : Effect.succeed(
            undetermined(
              exchange.status === 429 || exchange.status >= 500
                ? "unavailable"
                : exchange.status >= 300 && exchange.status < 400
                  ? "redirected"
                  : otherwise,
            ),
          );

    return Effect.gen(function* () {
      const initialized = yield* post(egress, input.url, {
        method: "initialize",
        id: 1,
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "executor-import-check", version: "1.0.0" },
        },
      });
      signals.push(signalOf("initialize", initialized));
      if (!successful(initialized)) return yield* unsuccessful(initialized, "not_mcp");
      const session = initialized.session;
      if (session !== undefined)
        // A public server can allocate a session for this check; release it.
        yield* Effect.addFinalizer(() =>
          Effect.scoped(
            HttpClient.withScope(egress.client).del(input.url, {
              headers: { "mcp-session-id": session, "mcp-protocol-version": protocolVersion },
            }),
          ).pipe(Effect.timeout("1 second"), Effect.ignore),
        );
      if (initialized.answer === "error") return undetermined("initialize_error");
      const negotiated = Schema.decodeUnknownOption(InitializeResult)(initialized.result);
      if (Option.isNone(negotiated)) return undetermined("not_mcp");
      const headers = {
        "mcp-protocol-version": negotiated.value.protocolVersion,
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      };
      yield* post(egress, input.url, { method: "notifications/initialized" }, headers);
      const tools = yield* post(egress, input.url, { method: "tools/list", id: 2 }, headers);
      signals.push(signalOf("tools/list", tools));
      if (!successful(tools)) return yield* unsuccessful(tools, "tools_error");
      if (tools.answer !== "result") return undetermined("tools_error");
      // A public server may still advertise OAuth, on a challenge or in its metadata.
      const oauth = yield* inspectOAuth(tools.authenticate ?? initialized.authenticate, false);
      return McpDetection.cases.Anonymous.make({
        ...ResourceOAuth.match(oauth, {
          OAuthAdvertised: ({ registration }) => ({ oauth: registration }),
          OAuthNotAdvertised: () => ({}),
          OAuthUnusable: () => ({}),
        }),
        signals,
      });
    }).pipe(
      Effect.scoped,
      // Each MCP request is bounded on its own; this bounds the metadata lookups too.
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", () => Effect.succeed(undetermined("timeout"))),
      Effect.catchTag("McpRequestFailed", ({ reason }) => Effect.succeed(undetermined(reason))),
    );
  }).pipe(
    // Only the outcome and its fixed detail are recorded; the server's address never is.
    Effect.tap((detection) =>
      Effect.annotateCurrentSpan(
        McpDetection.match(detection, {
          Anonymous: ({ oauth }) => ({
            "catalog.mcp.detection": "anonymous",
            ...(oauth === undefined ? {} : { "catalog.mcp.oauth": oauth }),
          }),
          OAuth: ({ registration }) => ({
            "catalog.mcp.detection": "oauth",
            "catalog.mcp.oauth": registration,
          }),
          CredentialsRequired: ({ scheme }) => ({
            "catalog.mcp.detection": "credentials",
            "catalog.mcp.scheme": scheme,
          }),
          Undetermined: ({ reason }) => ({
            "catalog.mcp.detection": "undetermined",
            "catalog.mcp.undetermined": reason,
          }),
        }),
      ),
    ),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.withSpan("catalog.mcp.access"),
  );
