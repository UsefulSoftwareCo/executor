/** OAuth wire protocol. Effect owns transport and cancellation; oauth4webapi validates responses. */
import { parseDestination } from "@executor-js/utils/url-policy";
import { Effect, Encoding, Schema } from "effect";
import { captureTelemetry } from "@executor-js/telemetry";
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http";
import * as oauth from "oauth4webapi";
import {
  OAuthProviderErrorCode,
  OAuthResponseField,
  OAuthResource,
  OAuthServer,
  OAuthTokenServer,
  type OAuthConfidentialRegistration,
  OAuthRegistration,
  type OAuthOptions,
  type OAuthClientAuth,
} from "../contracts/oauth.ts";
import type { OAuthTokenRequestFormat, OAuthTokenResponse } from "apps/contracts";
import type { ProviderAuthMethod } from "../contracts/provider.ts";
import {
  challengeDiagnostics,
  descriptionLength,
  diagnosticAttributes,
  libraryDiagnostics,
  mediaType,
  OAuthDiagnostics,
  type OAuthMediaType,
  providerCodeDiagnostics,
} from "./oauth-diagnostics.ts";
import { probeOAuthChallenge } from "./oauth-probe.ts";

const ProtocolCode = Schema.Literals([
  oauth.WWW_AUTHENTICATE_CHALLENGE,
  oauth.RESPONSE_BODY_ERROR,
  oauth.UNSUPPORTED_OPERATION,
  oauth.AUTHORIZATION_RESPONSE_ERROR,
  oauth.PARSE_ERROR,
  oauth.INVALID_RESPONSE,
  oauth.INVALID_REQUEST,
  oauth.RESPONSE_IS_NOT_JSON,
  oauth.RESPONSE_IS_NOT_CONFORM,
  oauth.HTTP_REQUEST_FORBIDDEN,
  oauth.REQUEST_PROTOCOL_FORBIDDEN,
  oauth.JWT_TIMESTAMP_CHECK,
  oauth.JWT_CLAIM_COMPARISON,
  oauth.JSON_ATTRIBUTE_COMPARISON,
  oauth.KEY_SELECTION,
  oauth.MISSING_SERVER_METADATA,
  oauth.INVALID_SERVER_METADATA,
  "schema_decode",
  "timeout",
]);
/** Private, sanitized protocol failure. Never retain a response, request, or thrown library error. */
export class OAuthProtocolFailed extends Schema.TaggedError<OAuthProtocolFailed>()(
  "OAuthProtocolFailed",
  {
    code: Schema.optional(ProtocolCode),
    status: Schema.optional(Schema.Int),
    providerError: Schema.optional(OAuthProviderErrorCode),
    field: Schema.optional(OAuthResponseField),
    reason: Schema.Literals([
      "request",
      "invalid_grant",
      "invalid_client",
      "invalid_response",
      "metadata_missing",
      "destination_blocked",
      "resource_mismatch",
      "unsupported",
      "subject_changed",
    ]),
    diagnostics: Schema.optional(OAuthDiagnostics),
  },
) {
  /** Only the sanitized evidence above; telemetry records this as the exception message. */
  override get message(): string {
    const diagnostics = this.diagnostics;
    return [
      this.reason,
      this.code,
      this.status === undefined ? undefined : `HTTP ${this.status}`,
      this.providerError,
      this.field === undefined ? undefined : `field ${this.field}`,
      diagnostics?.detail,
      diagnostics?.claim === undefined ? undefined : `claim ${diagnostics.claim}`,
      diagnostics?.attribute === undefined ? undefined : `attribute ${diagnostics.attribute}`,
      diagnostics?.callbackField === undefined
        ? undefined
        : `callback ${diagnostics.callbackField}`,
      diagnostics?.challengeScheme === undefined
        ? undefined
        : `challenge ${diagnostics.challengeScheme}${diagnostics.challengeError === undefined ? "" : ` ${diagnostics.challengeError}`}`,
      diagnostics?.providerCode === undefined ? undefined : `error ${diagnostics.providerCode}`,
      diagnostics?.contentType,
    ]
      .filter((part) => part !== undefined)
      .join(", ");
  }
}

/** Keep diagnostics only when there is evidence to record. */
const withDiagnostics = (diagnostics: OAuthDiagnostics) =>
  Object.values(diagnostics).some((value) => value !== undefined) ? { diagnostics } : {};

/** Add response evidence to a failure. Evidence the failure already carries wins. */
const withEvidence = (
  failed: OAuthProtocolFailed,
  evidence: { readonly status?: number | undefined; readonly diagnostics: OAuthDiagnostics },
) => {
  const status = failed.status ?? evidence.status;
  return new OAuthProtocolFailed({
    reason: failed.reason,
    ...(failed.code === undefined ? {} : { code: failed.code }),
    ...(status === undefined ? {} : { status }),
    ...(failed.providerError === undefined ? {} : { providerError: failed.providerError }),
    ...(failed.field === undefined ? {} : { field: failed.field }),
    ...withDiagnostics({ ...evidence.diagnostics, ...failed.diagnostics }),
  });
};

/**
 * Services that reject the client's credentials with their own code instead of RFC 6749's
 * `invalid_client`: GitHub (`incorrect_client_credentials`, with HTTP 200), Salesforce
 * (`invalid_client_id`), and Dropbox (`invalid_client: <description>`).
 */
const isClientRejection = (error: string) =>
  error === "invalid_client" ||
  error === "incorrect_client_credentials" ||
  error === "invalid_client_id" ||
  error.startsWith("invalid_client:");

/** The reason an RFC 6749 §5.2 error code gives for a failed token request. */
const errorReason = (error: string) =>
  error === "invalid_grant"
    ? ("invalid_grant" as const)
    : isClientRejection(error)
      ? ("invalid_client" as const)
      : ("request" as const);

/** RFC 6749 §5.2 error codes map to reasons; unknown codes are dropped from the recorded evidence. */
const errorResponse = (status: number, error: string) =>
  new OAuthProtocolFailed({
    code: oauth.RESPONSE_BODY_ERROR,
    status,
    ...(Schema.is(OAuthProviderErrorCode)(error) ? { providerError: error } : {}),
    reason: errorReason(error),
  });

const failure = (error: unknown): OAuthProtocolFailed => {
  if (Schema.is(OAuthProtocolFailed)(error)) return error;
  const libraryError =
    error instanceof oauth.OperationProcessingError ||
    error instanceof oauth.ResponseBodyError ||
    error instanceof oauth.WWWAuthenticateChallengeError ||
    error instanceof oauth.UnsupportedOperationError ||
    error instanceof oauth.AuthorizationResponseError;
  const code = libraryError && Schema.is(ProtocolCode)(error.code) ? error.code : undefined;
  const status =
    error instanceof oauth.ResponseBodyError || error instanceof oauth.WWWAuthenticateChallengeError
      ? error.status
      : error instanceof oauth.OperationProcessingError && error.cause instanceof Response
        ? error.cause.status
        : undefined;
  const providerError =
    (error instanceof oauth.ResponseBodyError ||
      error instanceof oauth.AuthorizationResponseError) &&
    Schema.is(OAuthProviderErrorCode)(error.error)
      ? error.error
      : undefined;
  // Match library-owned validation labels; never record its message, cause, expected value or body.
  const fieldValue =
    error instanceof oauth.OperationProcessingError
      ? error.message === 'unexpected JWT "alg" header parameter'
        ? "jwt_alg"
        : error.message === 'unexpected "iss" (issuer) response parameter value' ||
            error.message === 'response parameter "iss" (issuer) missing'
          ? "issuer"
          : /^"response" body "([a-z_]+)" property/.exec(error.message)?.[1]
      : undefined;
  return new OAuthProtocolFailed({
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(providerError === undefined ? {} : { providerError }),
    ...(Schema.is(OAuthResponseField)(fieldValue) ? { field: fieldValue } : {}),
    ...withDiagnostics(
      error instanceof SyntaxError ? { detail: "body_not_json" } : libraryDiagnostics(error),
    ),
    reason:
      error instanceof oauth.ResponseBodyError
        ? errorReason(error.error)
        : error instanceof oauth.OperationProcessingError || error instanceof SyntaxError
          ? "invalid_response"
          : "request",
  });
};

/**
 * The endpoint answered with an OAuth error: an error body (RFC 6749 §5.2) or a client
 * authentication challenge. Other failures carry no statement about the grant.
 */
export const isOAuthErrorResponse = (error: OAuthProtocolFailed) =>
  error.code === oauth.RESPONSE_BODY_ERROR || error.code === oauth.WWW_AUTHENTICATE_CHALLENGE;

const observeFailure = (error: OAuthProtocolFailed) =>
  Effect.annotateCurrentSpan({
    "oauth.error.reason": error.reason,
    ...(error.code === undefined ? {} : { "oauth.error.code": error.code }),
    ...(error.status === undefined ? {} : { "http.response.status_code": error.status }),
    ...(error.providerError === undefined
      ? {}
      : { "oauth.error.provider_code": error.providerError }),
    ...(error.field === undefined ? {} : { "oauth.error.field": error.field }),
    ...diagnosticAttributes(error.diagnostics),
  });
const protocolStage =
  (
    stage:
      | "discover"
      | "register"
      | "authorize"
      | "exchange"
      | "clientCredentials"
      | "refresh"
      | "revoke",
  ) =>
  <A, R>(program: Effect.Effect<A, OAuthProtocolFailed, R>) =>
    program.pipe(
      Effect.tapError(observeFailure),
      Effect.withSpan(`oauth.${stage}`, { attributes: { "oauth.stage": stage } }),
    );

/**
 * Microsoft identity platform's multi-tenant endpoints (`common`, `organizations`) publish
 * `https://login.microsoftonline.com/{tenantid}/v2.0` as their issuer. Each ID token names the
 * signed-in user's tenant: its `iss` is the template with its own `tid` claim substituted.
 * Only an issuer containing this literal placeholder is treated as a template.
 */
const tenantPlaceholder = "{tenantid}";
const tenantSegment = /^[A-Za-z0-9._-]+$/;
/** The concrete issuer for one tenant, or undefined when `template` is not a tenant template. */
const tenantIssuer = (template: string, tenant: unknown) => {
  const parts = template.split(tenantPlaceholder);
  return parts.length === 2 && typeof tenant === "string" && tenantSegment.test(tenant)
    ? `${parts[0]}${tenant}${parts[1]}`
    : undefined;
};
/** Whether `requested` is `template` with one tenant segment in place of its placeholder. */
const instantiatesTenantTemplate = (template: string, requested: URL) => {
  const [prefix, suffix, ...rest] = template.split(tenantPlaceholder);
  if (prefix === undefined || suffix === undefined || rest.length > 0) return false;
  const href = requested.href;
  const tenant = href.slice(prefix.length, href.length - suffix.length);
  return (
    href.length > prefix.length + suffix.length &&
    href.startsWith(prefix) &&
    href.endsWith(suffix) &&
    tenantIssuer(template, tenant) === href
  );
};
/**
 * oauth4webapi's hook for an ID token issuer that depends on the token, exported for this
 * Microsoft case but not typed. Without it a template never equals `iss`, so tokens fail closed.
 */
const expectedIssuer: unknown = Reflect.get(oauth, "_expectedIssuer");

/** Rehydrate mutable protocol arrays from the immutable storage contract. */
const metadata = (server: OAuthTokenServer): oauth.AuthorizationServer => ({
  ...(typeof expectedIssuer === "symbol" && server.issuer.includes(tenantPlaceholder)
    ? {
        [expectedIssuer]: (result: { readonly claims: { readonly tid?: unknown } }) =>
          tenantIssuer(server.issuer, result.claims.tid) ?? server.issuer,
      }
    : {}),
  issuer: server.issuer,
  ...(server.authorization_endpoint === undefined
    ? {}
    : { authorization_endpoint: server.authorization_endpoint }),
  token_endpoint: server.token_endpoint,
  ...(server.jwks_uri === undefined ? {} : { jwks_uri: server.jwks_uri }),
  // Unsigned ID tokens are never accepted, even when advertised. Without metadata, oauth4webapi
  // requires OIDC Registration's RS256 default.
  ...(server.id_token_signing_alg_values_supported === undefined
    ? {}
    : {
        id_token_signing_alg_values_supported: server.id_token_signing_alg_values_supported.filter(
          (alg) => alg.toLowerCase() !== "none",
        ),
      }),
  ...(server.registration_endpoint === undefined
    ? {}
    : { registration_endpoint: server.registration_endpoint }),
  ...(server.revocation_endpoint === undefined
    ? {}
    : { revocation_endpoint: server.revocation_endpoint }),
  ...(server.authorization_response_iss_parameter_supported === undefined
    ? {}
    : {
        authorization_response_iss_parameter_supported:
          server.authorization_response_iss_parameter_supported,
      }),
  ...(server.code_challenge_methods_supported === undefined
    ? {}
    : { code_challenge_methods_supported: [...server.code_challenge_methods_supported] }),
  ...(server.token_endpoint_auth_methods_supported === undefined
    ? {}
    : { token_endpoint_auth_methods_supported: [...server.token_endpoint_auth_methods_supported] }),
});

const basicAuth =
  (secret: string, encode: (value: string) => string): oauth.ClientAuth =>
  (_server, registered, _body, headers) => {
    headers.set(
      "authorization",
      `Basic ${Encoding.encodeBase64(new TextEncoder().encode(`${encode(registered.client_id)}:${encode(secret)}`))}`,
    );
  };

/**
 * RFC 6749 section 2.3.1 form-encodes Basic credentials. The URL Standard's serializer leaves
 * letters, digits and `*-._` as they are. Servers that decode read the same values, and
 * Doorkeeper, which compares the header literally, accepts the IDs and secrets it issues.
 */
const formEncode = (value: string) => new URLSearchParams([["", value]]).toString().slice(1);

const clientAuth = (client: OAuthRegistration) => {
  switch (client.token_endpoint_auth_method) {
    case "none":
      return oauth.None();
    case "client_secret_basic":
      return basicAuth(client.client_secret, formEncode);
    case "client_secret_basic_raw":
      return basicAuth(client.client_secret, (value) => value);
    case "client_secret_post":
      return oauth.ClientSecretPost(client.client_secret);
  }
};

/** Fill a missing client_secret_expires_at with RFC 7591's "does not expire" value. */
const registrationBody = (text: string) => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  return typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof Reflect.get(parsed, "client_secret") === "string" &&
    Reflect.get(parsed, "client_secret") !== "" &&
    (Reflect.get(parsed, "client_secret_expires_at") ?? undefined) === undefined
    ? JSON.stringify({ ...parsed, client_secret_expires_at: 0 })
    : text;
};

/** Read a copy of a token response to learn whether the service returned an ID token. */
const hasIdToken = async (response: Response) => {
  if (!response.ok) return false;
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && Reflect.get(body, "id_token") !== undefined;
  } catch {
    return false;
  }
};

/**
 * An ID token's `iss` cannot be checked against a derived issuer. Executor never reads ID tokens,
 * so drop one it cannot validate instead of rejecting the tokens beside it.
 */
const withoutIdToken = async (response: Response) => {
  if (!(await hasIdToken(response))) return response;
  const body: unknown = await response.json();
  return new Response(
    JSON.stringify(
      Object.fromEntries(Object.entries(body as object).filter(([key]) => key !== "id_token")),
    ),
    { status: response.status, headers: response.headers },
  );
};

/** Read a copy of a JSON object response body, or undefined when it is not one. */
const jsonObject = async (response: Response) => {
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
};

/** Token response members some services send as null when they issued none. */
const optionalTokenMembers = new Set([
  "token_type",
  "expires_in",
  "refresh_token",
  "scope",
  "id_token",
]);

/**
 * Normalize a successful token response once, before validation. Null optional members are
 * absent (Mailchimp sends `scope: null`), and so are empty ones except `scope`: an empty scope
 * is a granted scope and replaces the previous one on renewal. A scope array becomes RFC 6749's
 * space-delimited string. A missing `token_type` is Bearer: Shopify, ClickUp and Mailchimp omit
 * it, and Executor sends every access token as a Bearer token.
 */
const normalizedTokens = (body: object) => {
  const tokens: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (optionalTokenMembers.has(key) && (value === null || (value === "" && key !== "scope")))
      continue;
    tokens[key] =
      key === "scope" && Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value.join(" ")
        : value;
  }
  if (tokens.token_type === undefined) tokens.token_type = "bearer";
  return tokens;
};

/** Members that describe one grant; a nested grant replaces all of them. */
const grantMembers = ["access_token", ...optionalTokenMembers];

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The grant a provider declared at a nested member, used when the top-level response has no
 * access token or no scope. Slack answers a user-only install with `authed_user` holding the
 * user token and its comma-separated scopes. Other top-level members, such as Slack's `team`,
 * stay beside it; the top-level grant members do not.
 */
const nestedGrant = (body: object, nested: OAuthTokenResponse | undefined) => {
  if (nested === undefined) return body;
  const scope = Reflect.get(body, "scope");
  if (
    typeof Reflect.get(body, "access_token") === "string" &&
    typeof scope === "string" &&
    scope !== ""
  )
    return body;
  let grant: unknown = body;
  for (const member of nested.path.split("."))
    grant = isObject(grant) ? Reflect.get(grant, member) : undefined;
  if (!isObject(grant) || typeof Reflect.get(grant, "access_token") !== "string") return body;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body))
    if (!grantMembers.includes(key)) merged[key] = value;
  for (const [key, value] of Object.entries(grant))
    if (grantMembers.includes(key)) merged[key] = value;
  const nestedScope = Reflect.get(grant, "scope");
  if (typeof nestedScope === "string")
    merged.scope = nestedScope
      .split(/[\s,]+/)
      .filter(Boolean)
      .join(" ");
  return merged;
};

/**
 * RFC 6749 §5.2: a JSON object with an `error` code and no access token is an error response,
 * whatever its HTTP status. Some services send it with HTTP 200; with a 401 WWW-Authenticate
 * challenge, oauth4webapi reports the challenge before reading the body. Other HTTP 200 JSON
 * objects are normalized for validation, reading a declared nested grant first.
 */
const tokenResponse = async (response: Response, nested?: OAuthTokenResponse) => {
  const body = await jsonObject(response);
  if (body === undefined) return response;
  const error = Reflect.get(body, "error");
  if (typeof error === "string" && error !== "" && Reflect.get(body, "access_token") === undefined)
    throw withEvidence(errorResponse(response.status, error), {
      diagnostics: {
        detail: "response_body_error",
        ...providerCodeDiagnostics(error),
        descriptionLength: descriptionLength(Reflect.get(body, "error_description")),
        contentType: mediaType(response.headers.get("content-type")),
        ...challengeDiagnostics(response.headers.get("www-authenticate")),
      },
    });
  if (response.status !== 200) return response;
  return new Response(JSON.stringify(normalizedTokens(nestedGrant(body, nested))), {
    status: response.status,
    headers: response.headers,
  });
};

/**
 * Record the HTTP status a failure came from, unless it already names one. Every other field of
 * the failure is kept as it was.
 */
const withStatus = (failed: OAuthProtocolFailed, status: number | undefined) =>
  failed.status !== undefined || status === undefined
    ? failed
    : new OAuthProtocolFailed({ ...failed, status });

/**
 * Microsoft identity platform v2.0 selects a token's audience from the resource named in each
 * scope (`api://.../access`). It rejects an RFC 8707 `resource` that differs from that audience
 * with `invalid_target` (AADSTS9010010), which an MCP server URL usually does. Its metadata
 * identifies it with the `cloud_instance_name` extension, in every Microsoft cloud; the v1.0
 * endpoint, which uses `resource` itself, has no `/v2.0` issuer.
 */
const scopedAudience = (server: oauth.AuthorizationServer) =>
  typeof server.cloud_instance_name === "string" && server.issuer.endsWith("/v2.0");

const isLowercase = (value: string): value is Lowercase<string> => value === value.toLowerCase();

/**
 * Executor sends every access token as a Bearer token (RFC 6750) and never creates DPoP proofs
 * (RFC 9449). Services label Bearer tokens with their own types, such as Slack's `bot`, so any
 * type but DPoP is accepted.
 */
const tokenTypes = async (response: Response): Promise<oauth.RecognizedTokenTypes> => {
  const body = await jsonObject(response);
  const received = body === undefined ? undefined : Reflect.get(body, "token_type");
  const type = typeof received === "string" ? received.toLowerCase() : undefined;
  return {
    dpop: () => {
      throw new OAuthProtocolFailed({ reason: "unsupported", field: "token_type" });
    },
    ...(type === undefined || type === "bearer" || type === "dpop" || !isLowercase(type)
      ? {}
      : { [type]: () => undefined }),
  };
};

/**
 * The validated ID token's subject and the issuer it is unique at, when the token response
 * carried one. A grant saves them together.
 */
export const idTokenIdentity = (tokens: oauth.TokenEndpointResponse) => {
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  return claims === undefined || claims.sub === ""
    ? {}
    : { idTokenSubject: claims.sub, idTokenIssuer: claims.iss };
};

/**
 * OIDC Core §12.2: a refreshed ID token must name the same `iss` and `sub` as the original one.
 * oauth4webapi already checks `iss` against the server's issuer, which is fixed unless it is a
 * `{tenantid}` template. A template grant must therefore have saved its concrete issuer; one that
 * saved a subject without it cannot be checked and is refused. Before `{tenantid}` templates were
 * supported, no template grant could save a subject, so this refuses no existing grant.
 */
const sameIdentity = (
  server: OAuthTokenServer,
  saved: {
    readonly idTokenSubject?: string | undefined;
    readonly idTokenIssuer?: string | undefined;
  },
  refreshed: oauth.IDToken,
) => {
  if (saved.idTokenSubject === undefined) return true;
  const issuer =
    saved.idTokenIssuer ?? (server.issuer.includes(tenantPlaceholder) ? undefined : server.issuer);
  return refreshed.sub === saved.idTokenSubject && refreshed.iss === issuer;
};

/** Issuer metadata, or the answer that said it is missing there. */
type IssuerMissing = { readonly missing: OAuthProtocolFailed };
type IssuerFound = { readonly server: OAuthTokenServer; readonly audienceFromScopes: boolean };
type IssuerDiscovery = IssuerFound | IssuerMissing;

/**
 * A token request as the JSON object some services require instead of RFC 6749's form. The
 * library's parameters and client authentication are kept; only their encoding changes.
 */
const jsonBody = (headers: HeadersInit | undefined, body: URLSearchParams) => {
  const json = new Headers(headers);
  json.set("content-type", "application/json");
  return { headers: json, body: JSON.stringify(Object.fromEntries(body)) };
};

/** Resolve protocol operations against one host-supplied Effect HTTP client. */
export const makeOAuthProtocol = (options: OAuthOptions) => {
  // This callback is the external library boundary, not an internal Promise implementation.
  const transport =
    (
      telemetry: Effect.Success<typeof captureTelemetry>,
      received: (status: number, contentType: OAuthMediaType | undefined) => void,
      format: OAuthTokenRequestFormat,
    ) =>
    (url: string, init: oauth.CustomFetchOptions<string, BodyInit | undefined>) =>
      Effect.runPromiseWith(telemetry.context)(
        Effect.gen(function* () {
          // Enforce host policy on every request, including discovered endpoints and saved grants.
          const destination = parseDestination(url, options.urlPolicy);
          if (destination === undefined)
            return yield* new OAuthProtocolFailed({ reason: "destination_blocked" });
          const request = yield* Effect.try({
            try: () =>
              HttpClientRequest.fromWeb(
                new Request(destination, {
                  method: init.method,
                  ...(format === "json" && init.body instanceof URLSearchParams
                    ? jsonBody(init.headers, init.body)
                    : {
                        headers: init.headers,
                        ...(init.body === undefined ? {} : { body: init.body }),
                      }),
                }),
              ),
            catch: failure,
          });
          const response = yield* options.httpClient.execute(request);
          yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
          received(response.status, mediaType(response.headers["content-type"]));
          const body = yield* response.arrayBuffer.pipe(Effect.withSpan("oauth.response.read"));
          return new Response(body, { status: response.status, headers: response.headers });
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(failure),
        ),
        init.signal === undefined ? {} : { signal: init.signal },
      );
  const requestOptions = (
    signal: AbortSignal,
    telemetry: Effect.Success<typeof captureTelemetry>,
    received: (status: number, contentType: OAuthMediaType | undefined) => void,
    format: OAuthTokenRequestFormat,
  ) => ({
    [oauth.customFetch]: transport(telemetry, received, format),
    [oauth.allowInsecureRequests]: true,
    signal,
  });
  /** Run one library call. `format` re-encodes its form bodies; only token requests set it. */
  const request = <A>(
    run: (settings: ReturnType<typeof requestOptions>) => Promise<A>,
    format: OAuthTokenRequestFormat = "form",
  ) =>
    Effect.gen(function* () {
      const telemetry = yield* captureTelemetry;
      // The last response status tells a rejection (4xx) from a response we could not use (2xx).
      let last: { status: number; contentType: OAuthMediaType | undefined } | undefined;
      return yield* Effect.tryPromise({
        try: (signal) =>
          run(
            requestOptions(
              signal,
              telemetry,
              (status, contentType) => {
                last = { status, contentType };
              },
              format,
            ),
          ),
        catch: (error) => {
          const failed = failure(error);
          return last === undefined
            ? failed
            : withEvidence(failed, {
                status: last.status,
                diagnostics: { contentType: last.contentType },
              });
        },
      });
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? new OAuthProtocolFailed({ reason: "request", code: "timeout" })
          : error,
      ),
      Effect.tapError(observeFailure),
      Effect.withSpan("oauth.request"),
    );
  const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        () => new OAuthProtocolFailed({ reason: "invalid_response", code: "schema_decode" }),
      ),
    );

  /**
   * An undeclared method prefers a public client. A secret otherwise uses Basic, which RFC 6749
   * section 2.3.1 requires servers to support and RFC 8414 makes the default when metadata lists
   * no methods, unless the server does not advertise it. The server's list does not say how an
   * individual client entered by hand was registered (RFC 7591 section 2), so that client keeps
   * Basic. A client Executor registers requests the body form when advertised, which services
   * accept more consistently than Basic.
   */
  const clientMethod = (
    server: OAuthTokenServer,
    client: "entered" | "registered",
    configured?: OAuthClientAuth,
  ) => {
    const supported = server.token_endpoint_auth_methods_supported;
    const method =
      configured ??
      (supported?.includes("none")
        ? "none"
        : supported?.includes("client_secret_post") &&
            (client === "registered" || !supported.includes("client_secret_basic"))
          ? "client_secret_post"
          : "client_secret_basic");
    const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
    return supported !== undefined && !supported.includes(advertised)
      ? Effect.fail(new OAuthProtocolFailed({ reason: "invalid_response" }))
      : Effect.succeed(method);
  };

  const discoveryResponse = (response: Response) => {
    if (response.status === 404 || response.status === 410)
      throw new OAuthProtocolFailed({ reason: "metadata_missing" });
    if (response.status === 429 || response.status >= 500)
      throw new OAuthProtocolFailed({ reason: "request" });
    if (response.status !== 200) throw new OAuthProtocolFailed({ reason: "invalid_response" });
    return response;
  };

  /** Validate one metadata document. A `{tenantid}` template matches its instantiated issuer. */
  const issuerMetadata = async (issuer: URL, response: Response) => {
    const body = await jsonObject(response);
    const published = body === undefined ? undefined : Reflect.get(body, "issuer");
    return oauth.processDiscoveryResponse(
      typeof published === "string" && instantiatesTenantTemplate(published, issuer)
        ? new URL(published)
        : issuer,
      response,
    );
  };

  /**
   * RFC 8414 metadata, then OpenID Connect Discovery for the same issuer. A location that does
   * not answer 200 serves no metadata, so the next one is tried: Apple redirects the RFC 8414
   * path and Atlassian refuses it with 401. Redirects are never followed. A served document
   * that fails validation is reported if no other location succeeds; it never selects another
   * issuer, because every document must name the requested one.
   *
   * Missing metadata is an answer, not a failed request: a caller may fall back to another
   * issuer location, so the request span records only the status that said so.
   */
  const discoverIssuer = (
    issuer: URL,
    metadataUrl?: URL,
  ): Effect.Effect<IssuerDiscovery, OAuthProtocolFailed> =>
    request(async (settings): Promise<{ server: oauth.AuthorizationServer } | IssuerMissing> => {
      const withOpenIdAlgorithms = async (server: oauth.AuthorizationServer) => {
        if (server.id_token_signing_alg_values_supported !== undefined) return server;
        try {
          const oidcResponse = await oauth.discoveryRequest(issuer, {
            ...settings,
            algorithm: "oidc",
          });
          if (oidcResponse.status === 200) {
            const oidc = await issuerMetadata(issuer, oidcResponse);
            if (oidc.id_token_signing_alg_values_supported !== undefined) {
              server.id_token_signing_alg_values_supported =
                oidc.id_token_signing_alg_values_supported;
            }
            if (server.jwks_uri === undefined && oidc.jwks_uri !== undefined) {
              server.jwks_uri = oidc.jwks_uri;
            }
          }
        } catch {
          // OpenID Connect Discovery is optional when OAuth 2.0 metadata was already found.
        }
        return server;
      };
      if (metadataUrl !== undefined) {
        const response = await settings[oauth.customFetch](metadataUrl.href, {
          method: "GET",
          body: undefined,
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: settings.signal,
        });
        return {
          server: await withOpenIdAlgorithms(
            await issuerMetadata(issuer, discoveryResponse(response)),
          ),
        };
      }
      let unusable: unknown;
      let unavailable: number | undefined;
      let last: { status: number; contentType: OAuthMediaType | undefined } | undefined;
      for (const algorithm of ["oauth2", "oidc"] as const) {
        const response = await oauth.discoveryRequest(issuer, { ...settings, algorithm });
        last = {
          status: response.status,
          contentType: mediaType(response.headers.get("content-type")),
        };
        if (response.status === 429 || response.status >= 500) unavailable ??= response.status;
        if (response.status !== 200) continue;
        try {
          const server = await issuerMetadata(issuer, response);
          return { server: algorithm === "oauth2" ? await withOpenIdAlgorithms(server) : server };
        } catch (error) {
          unusable ??= withStatus(failure(error), 200);
        }
      }
      if (unusable !== undefined) throw unusable;
      if (unavailable !== undefined)
        throw new OAuthProtocolFailed({ reason: "request", status: unavailable });
      return {
        missing: new OAuthProtocolFailed({
          reason: "metadata_missing",
          ...(last === undefined ? {} : { status: last.status }),
          ...withDiagnostics({ detail: "unexpected_status", contentType: last?.contentType }),
        }),
      };
    }).pipe(
      Effect.flatMap((found): Effect.Effect<IssuerDiscovery, OAuthProtocolFailed> =>
        "missing" in found
          ? Effect.succeed(found)
          : decode(OAuthTokenServer, found.server).pipe(
              Effect.map((server) => ({
                server,
                audienceFromScopes: scopedAudience(found.server),
              })),
            ),
      ),
    );
  const requireIssuer = (
    found: IssuerDiscovery,
  ): Effect.Effect<IssuerFound, OAuthProtocolFailed> =>
    "missing" in found ? Effect.fail(found.missing) : Effect.succeed(found);

  const secureUrl = (value: string) => {
    const url = parseDestination(value, options.urlPolicy);
    return url === undefined
      ? Effect.fail(new OAuthProtocolFailed({ reason: "destination_blocked" }))
      : Effect.succeed(url);
  };

  const discoverResource = (endpoint: URL) =>
    Effect.gen(function* () {
      // Inspect only headers: a successful MCP GET may open an endless SSE stream.
      const challenge = yield* probeOAuthChallenge(endpoint, options.httpClient).pipe(
        Effect.flatMap((response) =>
          response.status === 429 || response.status >= 500
            ? Effect.fail(new OAuthProtocolFailed({ reason: "request" }))
            : Effect.succeed(response),
        ),
        Effect.mapError(failure),
      );
      const advertised = challenge.resourceMetadata;
      const metadataUrl = advertised === undefined ? undefined : yield* secureUrl(advertised);
      const document = yield* request(async (settings) => {
        let response =
          metadataUrl === undefined
            ? await oauth.resourceDiscoveryRequest(endpoint, settings)
            : await settings[oauth.customFetch](metadataUrl.href, {
                method: "GET",
                body: undefined,
                headers: { accept: "application/json" },
                redirect: "manual",
                signal: settings.signal,
              });
        if (metadataUrl === undefined && response.status === 404 && endpoint.pathname !== "/") {
          response = await settings[oauth.customFetch](
            new URL("/.well-known/oauth-protected-resource", endpoint).href,
            {
              method: "GET",
              body: undefined,
              headers: { accept: "application/json" },
              redirect: "manual",
              signal: settings.signal,
            },
          );
        }
        if (metadataUrl === undefined && response.status === 404) return undefined;
        const document: unknown = await discoveryResponse(response).json();
        return document;
      });
      if (document === undefined) return { metadata: undefined, scopes: challenge.scopes };
      const found = yield* decode(OAuthResource, document);
      const resource = yield* secureUrl(found.resource);
      // A resource can cover /mcp from the origin root, but cannot name a sibling
      // service or a different host. Preserve its exact advertised identifier.
      const prefix = resource.pathname.endsWith("/") ? resource.pathname : resource.pathname + "/";
      if (
        resource.origin !== endpoint.origin ||
        (resource.pathname !== endpoint.pathname && !endpoint.pathname.startsWith(prefix))
      ) {
        return yield* new OAuthProtocolFailed({ reason: "resource_mismatch" });
      }
      return { metadata: found, scopes: challenge.scopes };
    });

  return {
    discover: (method: Extract<ProviderAuthMethod, { type: "oauth2" }>) =>
      Effect.gen(function* () {
        const resolved = yield* Effect.gen(function* () {
          if (method.discover === undefined)
            return {
              server: yield* decode(OAuthTokenServer, {
                ...("issuer" in method && method.issuer !== undefined
                  ? { issuer: method.issuer }
                  : { issuer: new URL(method.tokenUrl).origin, issuer_derived: true }),
                ...(method.authorizationUrl === undefined
                  ? {}
                  : { authorization_endpoint: method.authorizationUrl }),
                token_endpoint: method.tokenUrl,
                ...(method.revocationUrl === undefined
                  ? {}
                  : { revocation_endpoint: method.revocationUrl }),
              }),
              scopes: [...method.scopes],
              // Undeclared means the client decides: with nothing advertised, a secret uses Basic.
              tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
              ...(method.resource == null ? {} : { resource: method.resource }),
            };
          const resource = yield* secureUrl(method.discover);
          const discoveredResource = yield* discoverResource(resource);
          const found = discoveredResource?.metadata;
          const metadataUrl =
            method.authorizationServerMetadataUrl === undefined
              ? undefined
              : yield* secureUrl(method.authorizationServerMetadataUrl);
          const issuer = found === undefined ? resource.href : found.authorization_servers[0];
          if (issuer === undefined)
            return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
          const issuerUrl = yield* secureUrl(issuer);
          // Without protected-resource metadata, MCP's earlier authorization rules use the
          // server's origin as the authorization base. Atlassian publishes metadata only there.
          const { server, audienceFromScopes } = yield* metadataUrl === undefined &&
          found === undefined &&
          issuerUrl.pathname !== "/"
            ? discoverIssuer(issuerUrl).pipe(
                // Only missing metadata falls back. Served metadata that is invalid or names another
                // issuer is a failure, never a reason to try a different issuer.
                Effect.flatMap((path) =>
                  "missing" in path
                    ? Effect.annotateCurrentSpan("oauth.discovery.fallback", "origin").pipe(
                        Effect.andThen(discoverIssuer(new URL(issuerUrl.origin))),
                      )
                    : Effect.succeed(path),
                ),
                Effect.flatMap(requireIssuer),
              )
            : discoverIssuer(issuerUrl, metadataUrl).pipe(Effect.flatMap(requireIssuer));
          // Authored scopes win. MCP challenges name the operations' required scopes; the
          // resource metadata's scope list is the default only when the challenge omits it.
          const scopes = new Set(
            method.scopes ?? discoveredResource?.scopes ?? found?.scopes_supported ?? [],
          );
          if (
            method.grant !== "client_credentials" &&
            method.scopes === undefined &&
            server.scopes_supported?.includes("offline_access")
          )
            scopes.add("offline_access");
          // A declared resource, or an explicit null, always applies. A discovered one is not
          // sent to a server that takes the audience from the scopes instead.
          const resourceIndicator =
            method.resource !== undefined
              ? method.resource
              : audienceFromScopes
                ? undefined
                : found?.resource;
          return {
            server,
            scopes: [...scopes],
            // RFC 8414 lists what the server accepts; which one applies is the client's property.
            // A server open to public and secret clients leaves an undeclared choice to the client.
            ...(method.tokenEndpointAuthMethod === undefined &&
            server.token_endpoint_auth_methods_supported?.includes("none") &&
            server.token_endpoint_auth_methods_supported.some(
              (m) => m === "client_secret_basic" || m === "client_secret_post",
            )
              ? {}
              : {
                  tokenEndpointAuthMethod: yield* clientMethod(
                    server,
                    "entered",
                    method.tokenEndpointAuthMethod,
                  ),
                }),
            ...(resourceIndicator == null ? {} : { resource: resourceIndicator }),
          };
        });
        // Frozen on the attempt and grant, so renewal sends what sign-in did.
        const requestEncoding = {
          ...(method.scopeSeparator === undefined ? {} : { scopeSeparator: method.scopeSeparator }),
          ...(method.tokenRequestFormat === undefined
            ? {}
            : { tokenRequestFormat: method.tokenRequestFormat }),
        };
        if (method.grant === "client_credentials")
          return { ...resolved, ...requestEncoding, grant: "client_credentials" as const };
        return {
          ...resolved,
          ...requestEncoding,
          grant: "authorization_code" as const,
          server: yield* decode(OAuthServer, resolved.server),
          ...(method.authorizationParams === undefined
            ? {}
            : { authorizationParams: method.authorizationParams }),
          ...(method.tokenResponse === undefined ? {} : { tokenResponse: method.tokenResponse }),
        };
      }).pipe(protocolStage("discover")),
    register: (
      server: OAuthServer,
      redirectUri: string,
      scopes: readonly string[],
      configured?: OAuthClientAuth,
    ) =>
      Effect.gen(function* () {
        const method = yield* clientMethod(server, "registered", configured);
        const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
        const registered = yield* request(async (settings) => {
          const response = await oauth.dynamicClientRegistrationRequest(
            metadata(server),
            {
              client_name: options.clientName,
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: advertised,
              // Request refresh tokens unless the server's metadata lists grant types without
              // them. Singular advertises only authorization_code and rejects the request.
              grant_types:
                server.grant_types_supported === undefined ||
                server.grant_types_supported.includes("refresh_token")
                  ? ["authorization_code", "refresh_token"]
                  : ["authorization_code"],
              response_types: ["code"],
              ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
            },
            settings,
          );
          if (response.status !== 200 && response.status !== 201)
            return oauth.processDynamicClientRegistrationResponse(response);
          // Some providers use 200 instead of RFC 7591's 201, and some issue a secret without
          // client_secret_expires_at. Normalize only the status and that missing expiry, which
          // RFC 7591 defines as 0 for a secret that does not expire. oauth4webapi still
          // validates the content type, JSON and every other registration field.
          // The transport span retains the provider's original status.
          const text = await response.text();
          return oauth.processDynamicClientRegistrationResponse(
            new Response(registrationBody(text), { status: 201, headers: response.headers }),
          );
        });
        const issued = registered.token_endpoint_auth_method;
        if (issued === undefined || issued === advertised)
          return yield* decode(OAuthRegistration, {
            ...registered,
            token_endpoint_auth_method: method,
          });
        // RFC 7591 section 3.2.1: the server may replace requested metadata, and the client
        // uses what was issued. Vercel registers a public client when asked for a secret one.
        // A method the app configured is a requirement, so a replacement there is a mismatch.
        if (configured !== undefined)
          return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
        return yield* decode(OAuthRegistration, registered);
      }).pipe(protocolStage("register")),
    authorize: (input: {
      server: OAuthServer;
      client: OAuthRegistration;
      redirectUri: string;
      scopes: readonly string[];
      resource?: string;
      authorizationParams?: Readonly<Record<string, string>>;
      scopeSeparator?: string;
    }) =>
      Effect.gen(function* () {
        const state = yield* Effect.sync(oauth.generateRandomState);
        const verifier = yield* Effect.sync(oauth.generateRandomCodeVerifier);
        const nonce = input.scopes.includes("openid")
          ? yield* Effect.sync(oauth.generateRandomNonce)
          : undefined;
        const challenge = yield* request(() => oauth.calculatePKCECodeChallenge(verifier));
        const url = new URL(input.server.authorization_endpoint);
        // Declared extras go first so the protocol parameters below always win.
        for (const [key, value] of Object.entries(input.authorizationParams ?? {}))
          url.searchParams.set(key, value);
        for (const [key, value] of Object.entries({
          response_type: "code",
          client_id: input.client.client_id,
          redirect_uri: input.redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }))
          url.searchParams.set(key, value);
        if (input.scopes.length > 0)
          url.searchParams.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
        if (input.resource !== undefined) url.searchParams.set("resource", input.resource);
        if (nonce !== undefined) url.searchParams.set("nonce", nonce);
        return {
          state,
          verifier,
          authorizationUrl: url.href,
          ...(nonce === undefined ? {} : { nonce }),
        };
      }).pipe(protocolStage("authorize")),
    /**
     * Validate the authorization response before any token request: its state, its RFC 9207
     * issuer, and then any RFC 6749 §4.1.2.1 `error`. Failures here never reached the token endpoint.
     */
    callback: (
      input: { server: OAuthServer; client: OAuthRegistration; state: string },
      callback: URL,
    ) =>
      Effect.try({
        try: () => {
          // RFC 9207 needs the service's real issuer. A derived one cannot be compared, so an
          // `iss` the service sends (Google does) is ignored rather than rejected.
          const received = new URL(callback);
          if (input.server.issuer_derived === true) received.searchParams.delete("iss");
          const parameters = oauth.validateAuthResponse(
            metadata(input.server),
            input.client,
            received,
            input.state,
          );
          if (!parameters.get("code"))
            throw new OAuthProtocolFailed({
              reason: "invalid_response",
              diagnostics: { detail: "callback_code_missing", callbackField: "code" },
            });
          return parameters;
        },
        catch: failure,
      }).pipe(protocolStage("authorize")),
    exchange: (
      input: {
        server: OAuthServer;
        client: OAuthRegistration;
        redirectUri: string;
        verifier: string;
        resource?: string | undefined;
        nonce?: string | undefined;
        tokenRequestFormat?: OAuthTokenRequestFormat | undefined;
        tokenResponse?: OAuthTokenResponse | undefined;
      },
      parameters: URLSearchParams,
    ) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const sent = await tokenResponse(
          await oauth.authorizationCodeGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            parameters,
            input.redirectUri,
            input.verifier,
            {
              ...settings,
              ...(input.resource === undefined
                ? {}
                : { additionalParameters: { resource: input.resource } }),
            },
          ),
          input.tokenResponse,
        );
        const response = input.server.issuer_derived === true ? await withoutIdToken(sent) : sent;
        // Executor never uses the ID token, so it is optional even after requesting `openid`.
        // When one is returned, its nonce and claims are still validated.
        const nonce =
          input.nonce !== undefined && (await hasIdToken(response)) ? input.nonce : undefined;
        return oauth.processAuthorizationCodeResponse(server, input.client, response, {
          recognizedTokenTypes: await tokenTypes(response),
          ...(nonce === undefined ? {} : { expectedNonce: nonce, requireIdToken: true }),
        });
      }, input.tokenRequestFormat).pipe(protocolStage("exchange")),
    clientCredentials: (input: {
      server: OAuthTokenServer;
      client: OAuthConfidentialRegistration;
      scopes: readonly string[];
      resource?: string | undefined;
      scopeSeparator?: string | undefined;
      tokenRequestFormat?: OAuthTokenRequestFormat | undefined;
    }) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const parameters = new URLSearchParams();
        if (input.scopes.length > 0)
          parameters.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
        if (input.resource !== undefined) parameters.set("resource", input.resource);
        const response = await tokenResponse(
          await oauth.clientCredentialsGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            parameters,
            settings,
          ),
        );
        return oauth.processClientCredentialsResponse(server, input.client, response, {
          recognizedTokenTypes: await tokenTypes(response),
        });
      }, input.tokenRequestFormat).pipe(protocolStage("clientCredentials")),
    refresh: (input: {
      server: OAuthServer;
      client: OAuthRegistration;
      refreshToken: string;
      resource?: string | undefined;
      idTokenSubject?: string | undefined;
      idTokenIssuer?: string | undefined;
      tokenRequestFormat?: OAuthTokenRequestFormat | undefined;
      tokenResponse?: OAuthTokenResponse | undefined;
    }) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const response = await tokenResponse(
          await oauth.refreshTokenGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            input.refreshToken,
            {
              ...settings,
              ...(input.resource === undefined
                ? {}
                : { additionalParameters: { resource: input.resource } }),
            },
          ),
          input.tokenResponse,
        );
        const usable =
          input.server.issuer_derived === true ? await withoutIdToken(response) : response;
        const tokens = await oauth.processRefreshTokenResponse(server, input.client, usable, {
          recognizedTokenTypes: await tokenTypes(usable),
        });
        // OIDC Core §12.2: a refreshed ID token must identify the same end user at the same
        // issuer. For a `{tenantid}` template, `iss` follows each token's own `tid`, so only the
        // saved issuer stops a refresh from moving the grant to another tenant.
        const claims = oauth.getValidatedIdTokenClaims(tokens);
        if (claims !== undefined && !sameIdentity(input.server, input, claims))
          throw new OAuthProtocolFailed({
            reason: "subject_changed",
            code: oauth.JWT_CLAIM_COMPARISON,
            field: "id_token",
          });
        return tokens;
      }, input.tokenRequestFormat).pipe(protocolStage("refresh")),
    /** RFC 7009 revocation with the grant's own client authentication. */
    revoke: (input: {
      server: OAuthTokenServer;
      client: OAuthRegistration;
      token: string;
      tokenTypeHint: "refresh_token" | "access_token";
    }) =>
      request(async (settings) =>
        oauth.processRevocationResponse(
          await oauth.revocationRequest(
            metadata(input.server),
            input.client,
            clientAuth(input.client),
            input.token,
            { ...settings, additionalParameters: { token_type_hint: input.tokenTypeHint } },
          ),
        ),
      ).pipe(protocolStage("revoke")),
  };
};

/**
 * Confirm that a protected resource advertises authorization-code OAuth an account connection can
 * complete. Any discovery failure means OAuth is not confirmed; it never selects another method.
 */
export const discoversResourceOAuth = (
  resource: string,
  options: Pick<OAuthOptions, "httpClient" | "urlPolicy">,
) =>
  makeOAuthProtocol({ ...options, clientName: "Executor" })
    .discover({ type: "oauth2", discover: resource, response: {} })
    .pipe(
      Effect.map(
        (found) =>
          found.grant === "authorization_code" &&
          (found.server.code_challenge_methods_supported?.includes("S256") ?? true),
      ),
      Effect.orElseSucceed(() => false),
    );
