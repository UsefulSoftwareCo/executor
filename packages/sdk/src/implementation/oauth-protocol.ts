/** OAuth wire protocol. Effect owns transport and cancellation; oauth4webapi validates responses. */
import { RecordedMessage } from "@executor-js/utils/recorded-message";
import { parseDestination } from "@executor-js/utils/url-policy";
import { Clock, Effect, Match, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { captureTelemetry } from "@executor-js/telemetry";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import * as oauth from "oauth4webapi";
import {
  AuthorizationServerSignal,
  maxOAuthServiceErrorLength,
  maxOAuthServiceTextLength,
  type OAuthClientRegistration,
  OAuthProviderErrorCode,
  OAuthResponseField,
  OAuthResource,
  OAuthServiceError,
  OAuthServer,
  OAuthTokenServer,
  type OAuthConfidentialRegistration,
  OAuthRegistration,
  type OAuthOptions,
  type OAuthClientAuth,
  ResourceMetadataSignal,
  type ResourceMetadataLocation,
  ResourceOAuth,
  type ResourceOAuthSignal,
} from "../contracts/oauth.ts";
import type { OAuthTokenRequestFormat, OAuthTokenResponse } from "apps/contracts";
import type { ProviderAuthMethod } from "../contracts/provider.ts";
import type { CredentialsError } from "../contracts/shared.ts";
import { CredentialsRenewalRefused } from "../contracts/storage.ts";
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
    /** The service's own words, for the person connecting. Never part of the message below. */
    serviceError: Schema.optional(OAuthServiceError),
    /** With HTTP 429, the time the answer's Retry-After header named. */
    retryAfter: Schema.optional(Schema.Date),
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
  get [RecordedMessage]() {
    return this.message;
  }
}

/** Keep diagnostics only when there is evidence to record. */
const withDiagnostics = (diagnostics: OAuthDiagnostics) =>
  Object.values(diagnostics).some((value) => value !== undefined) ? { diagnostics } : {};

/** Credentials a request sent, which the service's answer must not repeat back to anyone. */
type SentSecrets = ReadonlyArray<string | null | undefined>;

/**
 * Each form a request or an echo of it can carry a sent secret in: as is, form- or URI-encoded,
 * or inside a JSON string, with or without escaped slashes. Longest first, so a secret containing
 * another is replaced whole.
 */
const secretForms = (secrets: SentSecrets) => {
  const forms = new Set<string>();
  for (const secret of secrets)
    if (typeof secret === "string" && secret !== "") {
      const json = JSON.stringify(secret).slice(1, -1);
      for (const form of [
        secret,
        formEncode(secret),
        encodeURIComponent(secret),
        json,
        json.replaceAll("/", "\\/"),
      ])
        forms.add(form);
    }
  return [...forms].sort((a, b) => b.length - a.length);
};

/**
 * Credentials a service's text names, whatever their source, such as a token it issued: the
 * values of credential parameters, HTTP authorization credentials, and JWTs.
 */
const namedCredentials: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(access_token|refresh_token|id_token|client_secret|code_verifier|client_assertion|password)(["']?\s*[:=]\s*["']?)[\w.~+/%=-]+/gi,
    "$1$2[redacted]",
  ],
  [/\b(Basic|Bearer|DPoP)(\s+)[\w.~+/-]{16,}=*/g, "$1$2[redacted]"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]"],
];

/** Cut text to `max` characters, ending with an ellipsis and never inside a surrogate pair. */
const bounded = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

/**
 * Service text without anything secret: each sent secret, in every form above, and each named
 * credential become `[redacted]`. Control and formatting characters become spaces, and the
 * result is bounded after redaction.
 */
const serviceText = (value: unknown, secrets: SentSecrets, max: number) => {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const form of secretForms(secrets)) text = text.split(form).join("[redacted]");
  for (const [credential, replacement] of namedCredentials)
    text = text.replace(credential, replacement);
  text = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? undefined : bounded(text, max);
};

/** The service's own `error` and `error_description`, when it named an error. */
const serviceErrorResponse = (error: unknown, description: unknown, secrets: SentSecrets) => {
  const code = serviceText(error, secrets, maxOAuthServiceErrorLength);
  if (code === undefined) return undefined;
  const text = serviceText(description, secrets, maxOAuthServiceTextLength);
  return text === undefined ? { error: code } : { error: code, description: text };
};

/**
 * RFC 6749 §5.2: a JSON object with an `error` code and no access token is an error response,
 * whatever its HTTP status.
 */
const oauthErrorBody = (body: unknown) => {
  if (!isObject(body)) return undefined;
  const error = Reflect.get(body, "error");
  return typeof error === "string" &&
    error !== "" &&
    Reflect.get(body, "access_token") === undefined
    ? { error, description: Reflect.get(body, "error_description") }
    : undefined;
};

/**
 * What a request's last response said: its status and media type, a 429's Retry-After time, then
 * its body once read.
 */
type Answer = {
  readonly status: number;
  readonly contentType: OAuthMediaType | undefined;
  readonly retryAfter?: Date | undefined;
  readonly body?: ArrayBuffer;
};

const httpDate =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The time a Retry-After header names (RFC 9110 §10.2.3): a delay in seconds from `now`, or an
 * HTTP date in its preferred IMF-fixdate form. Undefined without the header, for another form,
 * and for a time that is not in the future.
 */
const retryAfterTime = (header: string | undefined, now: number) => {
  const value = header?.trim();
  if (value === undefined) return undefined;
  const at = new Date(
    /^\d+$/.test(value)
      ? now + Number(value) * 1000
      : httpDate.test(value)
        ? Date.parse(value)
        : NaN,
  );
  return Number.isNaN(at.getTime()) || at.getTime() <= now ? undefined : at;
};

/** A 429's Retry-After time, read when the answer arrives. */
const limitedUntil = (status: number, header: string | undefined) =>
  status === 429
    ? Clock.currentTimeMillis.pipe(Effect.map((now) => retryAfterTime(header, now)))
    : Effect.succeed(undefined);

/** The most of an error body Executor reads for its text, in bytes. */
const serviceBodyReadLimit = 64 * 1024;

/** A body as text, read up to the limit. A cut never leaves part of a word, which may be a secret. */
const answerText = (body: ArrayBuffer) => {
  const text = new TextDecoder().decode(body.slice(0, serviceBodyReadLimit));
  if (body.byteLength <= serviceBodyReadLimit) return text;
  let end = text.length;
  while (end > 0 && !/\s/.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
};

const jsonValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Elements whose content a reader of the page never sees as text. */
const hiddenElements = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
]);
const characterReferences: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode numeric and common named character references; anything else stays as written. */
const decodeReferences = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (reference, name: string) => {
    if (!name.startsWith("#")) return characterReferences[name.toLowerCase()] ?? reference;
    const point = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
      ? String.fromCodePoint(point)
      : reference;
  });

/**
 * The text of an HTML or XML page. Tags and comments are removed, the content of scripts,
 * styles and similar elements is dropped, and character references are decoded before any
 * secret is redacted. An unfinished tag ends the text. Each search moves forward, so this is
 * linear in the page.
 */
const markupText = (markup: string) => {
  const lower = markup.toLowerCase();
  let text = "";
  let at = 0;
  while (at < markup.length) {
    const open = markup.indexOf("<", at);
    if (open === -1) return decodeReferences(text + markup.slice(at));
    text += markup.slice(at, open);
    if (!/[a-z!/?]/i.test(markup.charAt(open + 1))) {
      text += "<";
      at = open + 1;
      continue;
    }
    const comment = lower.startsWith("<!--", open);
    const close = comment ? lower.indexOf("-->", open + 4) : lower.indexOf(">", open);
    if (close === -1) break;
    text += " ";
    at = close + (comment ? 3 : 1);
    const element = /^<([a-z][a-z0-9-]*)/.exec(lower.slice(open, open + 32))?.[1];
    if (element !== undefined && hiddenElements.has(element)) {
      const end = lower.indexOf(`</${element}`, at);
      const endClose = end === -1 ? -1 : lower.indexOf(">", end);
      if (endClose === -1) break;
      at = endClose + 1;
    }
  }
  return decodeReferences(text);
};

const isMarkup = (text: string, contentType: OAuthMediaType | undefined) =>
  contentType === "text/html" ||
  contentType === "text/xml" ||
  contentType === "application/xml" ||
  text.trimStart().startsWith("<");

/**
 * What the service said in the answer to a failed request. An RFC 6749 error body gives its
 * `error` and `error_description`, whatever the status. Any other body is kept as text only with
 * an error status, because a 2xx body can hold tokens, and only when it has a letter or digit.
 */
const serviceAnswer = (answer: Answer, sent: SentSecrets): OAuthServiceError | undefined => {
  if (answer.body === undefined) return undefined;
  const text = answerText(answer.body);
  const refused = oauthErrorBody(jsonValue(text));
  if (refused !== undefined) return serviceErrorResponse(refused.error, refused.description, sent);
  if (answer.status < 400) return undefined;
  const plain = isMarkup(text, answer.contentType) ? markupText(text) : text;
  if (!/[\p{L}\p{N}]/u.test(plain)) return undefined;
  const body = serviceText(plain, sent, maxOAuthServiceTextLength);
  return body === undefined ? undefined : { body };
};

/** Add response evidence to a failure. Evidence the failure already carries wins. */
const withEvidence = (
  failed: OAuthProtocolFailed,
  evidence: {
    readonly status?: number | undefined;
    readonly diagnostics: OAuthDiagnostics;
    readonly serviceError?: OAuthServiceError | undefined;
    /** The Retry-After time of the latest 429 answer, kept only when the failure is a 429. */
    readonly retryAfter?: Date | undefined;
  },
) => {
  const status = failed.status ?? evidence.status;
  const serviceError = failed.serviceError ?? evidence.serviceError;
  const retryAfter = failed.retryAfter ?? (status === 429 ? evidence.retryAfter : undefined);
  return new OAuthProtocolFailed({
    reason: failed.reason,
    ...(failed.code === undefined ? {} : { code: failed.code }),
    ...(status === undefined ? {} : { status }),
    ...(failed.providerError === undefined ? {} : { providerError: failed.providerError }),
    ...(failed.field === undefined ? {} : { field: failed.field }),
    ...withDiagnostics({ ...evidence.diagnostics, ...failed.diagnostics }),
    ...(serviceError === undefined ? {} : { serviceError }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
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
 * `failure`, keeping the service's own error from an authorization response. It comes through the
 * browser, not in answer to a request Executor sent, so it repeats nothing secret of Executor's.
 */
const callbackFailure = (error: unknown): OAuthProtocolFailed => {
  const failed = failure(error);
  const serviceError =
    error instanceof oauth.AuthorizationResponseError
      ? serviceErrorResponse(error.error, error.error_description, [])
      : undefined;
  return serviceError === undefined ? failed : new OAuthProtocolFailed({ ...failed, serviceError });
};

/**
 * The endpoint answered with an OAuth error: an error body (RFC 6749 §5.2) or a client
 * authentication challenge. Other failures carry no statement about the grant.
 */
export const isOAuthErrorResponse = (error: OAuthProtocolFailed) =>
  error.code === oauth.RESPONSE_BODY_ERROR || error.code === oauth.WWW_AUTHENTICATE_CHALLENGE;

/**
 * A renewal a credentials store refused, as the same answer to the host's own request would have
 * failed. A store that cannot be reached or answers outside its contract is an outage: the grant
 * is kept and renewed again on its next use.
 */
export const fromRefusal = (
  refusal: CredentialsRenewalRefused | CredentialsError,
): OAuthProtocolFailed => {
  if (!Schema.is(CredentialsRenewalRefused)(refusal))
    return new OAuthProtocolFailed({ reason: "request" });
  const code =
    refusal.answer === "error_body"
      ? oauth.RESPONSE_BODY_ERROR
      : refusal.answer === "challenge"
        ? oauth.WWW_AUTHENTICATE_CHALLENGE
        : undefined;
  return new OAuthProtocolFailed({
    reason: refusal.reason,
    ...(code === undefined ? {} : { code }),
    ...(refusal.status === undefined ? {} : { status: refusal.status }),
    ...(refusal.providerError === undefined ? {} : { providerError: refusal.providerError }),
    ...(refusal.retryAfter === undefined ? {} : { retryAfter: refusal.retryAfter }),
  });
};

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

/** An RFC 7617 Basic credential, with the ID and secret encoded as the client's method requires. */
const basicCredential = (clientId: string, secret: string, encode: (value: string) => string) =>
  Base64.encode(new TextEncoder().encode(`${encode(clientId)}:${encode(secret)}`));

const basicAuth =
  (secret: string, encode: (value: string) => string): oauth.ClientAuth =>
  (_server, registered, _body, headers) => {
    headers.set("authorization", `Basic ${basicCredential(registered.client_id, secret, encode)}`);
  };

/**
 * RFC 6749 section 2.3.1 form-encodes Basic credentials. The URL Standard's serializer leaves
 * letters, digits and `*-._` as they are. Servers that decode read the same values, and
 * Doorkeeper, which compares the header literally, accepts the IDs and secrets it issues.
 */
const formEncode = (value: string) => new URLSearchParams([["", value]]).toString().slice(1);

/** What a client's authentication sends that is secret: its secret and any Basic credential. */
const clientSecrets = (client: OAuthRegistration): SentSecrets => {
  switch (client.token_endpoint_auth_method) {
    case "none":
      return [];
    case "client_secret_basic":
      return [
        client.client_secret,
        basicCredential(client.client_id, client.client_secret, formEncode),
      ];
    case "client_secret_basic_raw":
      return [
        client.client_secret,
        basicCredential(client.client_id, client.client_secret, (value) => value),
      ];
    case "client_secret_post":
      return [client.client_secret];
  }
};

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
export const normalizedTokens = (body: object) => {
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
 * An RFC 6749 §5.2 error body is an error response, whatever its HTTP status. Some services send
 * it with HTTP 200; with a 401 WWW-Authenticate challenge, oauth4webapi reports the challenge
 * before reading the body. Other HTTP 200 JSON objects are normalized for validation, reading a
 * declared nested grant first.
 */
const tokenResponse = async (response: Response, nested?: OAuthTokenResponse) => {
  const body = await jsonObject(response);
  if (body === undefined) return response;
  const refused = oauthErrorBody(body);
  if (refused !== undefined)
    throw withEvidence(errorResponse(response.status, refused.error), {
      diagnostics: {
        detail: "response_body_error",
        ...providerCodeDiagnostics(refused.error),
        descriptionLength: descriptionLength(refused.description),
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
type IssuerFound = {
  readonly server: OAuthTokenServer;
  readonly audienceFromScopes: boolean;
  /** The document that answered; absent for an explicitly declared metadata URL. */
  readonly document?: "oauth" | "openid";
};
type IssuerDiscovery = IssuerFound | IssuerMissing;
/** A metadata document before validation, and the document that answered. */
type IssuerAnswer =
  | { readonly server: oauth.AuthorizationServer; readonly document?: "oauth" | "openid" }
  | IssuerMissing;

/** Resource metadata lookups, with the validated document or the failure that ended them. */
type ResourceRead = {
  readonly lookups: ReadonlyArray<ResourceMetadataSignal>;
  readonly found?: {
    readonly metadata: OAuthResource;
    readonly location: ResourceMetadataLocation;
  };
  readonly failed?: OAuthProtocolFailed;
};

/**
 * Where an issuer publishes its metadata, in the order MCP clients try: RFC 8414's well-known
 * URL with the issuer's path inserted after it, OpenID Connect Discovery inserted the same way
 * (RFC 8414 §5), then OpenID Connect Discovery appended to the issuer's path. An issuer without
 * a path has one location for each document. URLs are built as oauth4webapi builds the first
 * and last.
 */
const metadataLocations = (
  issuer: URL,
): ReadonlyArray<{ readonly url: URL; readonly document: "oauth" | "openid" }> => {
  const at = (pathname: string) => {
    const url = new URL(issuer.href);
    url.pathname = pathname.replace("//", "/");
    return url;
  };
  const path = issuer.pathname.replace(/\/$/, "");
  const inserted = [
    { url: at(`/.well-known/oauth-authorization-server${path}`), document: "oauth" },
    { url: at(`/.well-known/openid-configuration${path}`), document: "openid" },
  ] as const;
  return path === ""
    ? inserted
    : [
        ...inserted,
        { url: at(`${issuer.pathname}/.well-known/openid-configuration`), document: "openid" },
      ];
};

/** RFC 9728 names the resource's scopes `scopes_supported`; Ahrefs uses `scopes_provided`. */
const resourceScopes = (metadata: OAuthResource | undefined) =>
  metadata?.scopes_supported ?? metadata?.scopes_provided;

/** Why advertised OAuth cannot be used, from the discovery failure that said so. */
const unusableReason = (failed: OAuthProtocolFailed) =>
  Match.value(failed.reason).pipe(
    Match.when("request", () => "unavailable" as const),
    Match.when("metadata_missing", () => "metadata_missing" as const),
    Match.when("destination_blocked", () => "blocked" as const),
    Match.when("resource_mismatch", () => "resource_mismatch" as const),
    Match.when("unsupported", () => "unsupported" as const),
    Match.whenOr(
      "invalid_response",
      "invalid_client",
      "invalid_grant",
      "subject_changed",
      () => "invalid" as const,
    ),
    Match.exhaustive,
  );

/**
 * How account setup obtains a client for a browser sign-in without a saved one, in MCP's order:
 * this host's Client ID Metadata Document when the server accepts one and the method allows a
 * public client, dynamic client registration (RFC 7591), otherwise a client the user registers.
 */
export const clientRegistration = (
  server: OAuthServer,
  tokenEndpointAuthMethod: OAuthClientAuth | undefined,
  clientMetadataUrl: string | undefined,
): OAuthClientRegistration =>
  (tokenEndpointAuthMethod === undefined || tokenEndpointAuthMethod === "none") &&
  server.client_id_metadata_document_supported === true &&
  clientMetadataUrl !== undefined
    ? "client_id_metadata_document"
    : server.registration_endpoint !== undefined
      ? "dynamic"
      : "manual";

/**
 * OpenID Connect Registration's client type, which MCP requires in every dynamic registration.
 * An HTTP callback on `localhost` or a loopback IP literal is a native app's loopback redirect
 * (RFC 8252 §7.3). An omitted type means `web`, for which OpenID providers may refuse that
 * redirect, and they refuse a native client's HTTP redirect to any other host. Any other
 * callback, including a named `*.localhost` host, therefore belongs to a web client. Servers
 * without OpenID Connect ignore the member (RFC 7591 §2).
 */
const applicationType = (redirect: URL) =>
  redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
    ? "native"
    : "web";

/**
 * A token request as the JSON object some services require instead of RFC 6749's form. The
 * library's parameters and client authentication are kept; only their encoding changes.
 */
const jsonBody = (headers: HeadersInit | undefined, body: URLSearchParams) => {
  const json = new Headers(headers);
  json.set("content-type", "application/json");
  return { headers: json, body: JSON.stringify(Object.fromEntries(body)) };
};

/**
 * A token or revocation request as RFC 6749's form, labeled with the bare media type its examples
 * use. The `application/x-www-form-urlencoded` registration defines no parameters, but
 * oauth4webapi adds `;charset=UTF-8`. Ahrefs compares the whole header and refuses that label
 * with a non-OAuth error body, so no sign-in could complete.
 */
const formBody = (headers: HeadersInit | undefined, body: URLSearchParams) => {
  const form = new Headers(headers);
  form.set("content-type", "application/x-www-form-urlencoded");
  return { headers: form, body };
};

/** Resolve protocol operations against one host-supplied Effect HTTP client. */
export const makeOAuthProtocol = (options: OAuthOptions) => {
  // This callback is the external library boundary, not an internal Promise implementation.
  const transport =
    (
      telemetry: Effect.Success<typeof captureTelemetry>,
      answered: (answer: Answer) => void,
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
                  ...(init.body instanceof URLSearchParams
                    ? (format === "json" ? jsonBody : formBody)(init.headers, init.body)
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
          const answer = {
            status: response.status,
            contentType: mediaType(response.headers["content-type"]),
            retryAfter: yield* limitedUntil(response.status, response.headers["retry-after"]),
          };
          answered(answer);
          const body = yield* response.arrayBuffer.pipe(Effect.withSpan("oauth.response.read"));
          answered({ ...answer, body });
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
    answered: (answer: Answer) => void,
    format: OAuthTokenRequestFormat,
  ) => ({
    [oauth.customFetch]: transport(telemetry, answered, format),
    [oauth.allowInsecureRequests]: true,
    signal,
  });
  /**
   * Run one library call. `format` re-encodes its form bodies; only token requests set it. A call
   * that gives `sent`, the secrets its request carries, keeps what the service said in a failed
   * answer as `serviceError`, without them.
   */
  const request = <A>(
    run: (settings: ReturnType<typeof requestOptions>) => Promise<A>,
    options: {
      readonly format?: OAuthTokenRequestFormat | undefined;
      readonly sent?: SentSecrets;
    } = {},
  ) =>
    Effect.gen(function* () {
      const telemetry = yield* captureTelemetry;
      // The last response status tells a rejection (4xx) from a response we could not use (2xx).
      let last: Answer | undefined;
      // The latest 429: discovery tries another location after one and still reports the 429.
      let limited: Answer | undefined;
      return yield* Effect.tryPromise({
        try: (signal) =>
          run(
            requestOptions(
              signal,
              telemetry,
              (answer) => {
                last = answer;
                if (answer.status === 429) limited = answer;
              },
              options.format ?? "form",
            ),
          ),
        catch: (error) => {
          const failed = failure(error);
          return last === undefined
            ? failed
            : withEvidence(failed, {
                status: last.status,
                diagnostics: { contentType: last.contentType },
                serviceError:
                  options.sent === undefined ? undefined : serviceAnswer(last, options.sent),
                retryAfter: limited?.retryAfter,
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
   * Every metadata location MCP lists for the issuer, in its order. A location that does not
   * answer 200 serves no metadata, so the next one is tried: Apple redirects the RFC 8414 path
   * and Atlassian refuses it with 401. Redirects are never followed. A served document that
   * fails validation is reported if no other location succeeds; it never selects another
   * issuer, because every document must name the requested one.
   *
   * Missing metadata is an answer, not a failed request: a caller may fall back to another
   * issuer location, so the request span records only the status that said so.
   *
   * RFC 8414 metadata need not list ID token algorithms; OpenID Connect Discovery requires them.
   * Miro lists HS256 only in its OpenID metadata. When an `openid` flow finds OAuth metadata
   * without them, they are read from the same issuer's OpenID locations under the same rules.
   * Only the algorithm list is adopted: the documents can differ elsewhere, such as in client
   * authentication methods. Its `issuer` must equal the accepted OAuth metadata's exactly, without
   * the URL normalization that issuer validation allows. A location that answers with anything but
   * a valid 200 document for this issuer contributes nothing; OIDC Registration's RS256 default
   * then applies. A request that fails in transport (a connection failure, timeout or unreadable
   * body) fails discovery, as at every discovery location, even though OAuth metadata was already
   * found. An explicit `metadataUrl` is the exact document and is never completed from another.
   */
  const discoverIssuer = (
    issuer: URL,
    openid: boolean,
    metadataUrl?: URL,
  ): Effect.Effect<IssuerDiscovery, OAuthProtocolFailed> =>
    request(async (settings): Promise<IssuerAnswer> => {
      const get = (url: URL) =>
        settings[oauth.customFetch](url.href, {
          method: "GET",
          body: undefined,
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: settings.signal,
        });
      if (metadataUrl !== undefined)
        return { server: await issuerMetadata(issuer, discoveryResponse(await get(metadataUrl))) };
      // The first valid OpenID document decides, as in discovery.
      const openidAlgorithms = async (accepted: string) => {
        for (const location of metadataLocations(issuer)) {
          if (location.document !== "openid") continue;
          const response = await get(location.url);
          if (response.status !== 200) continue;
          let server: oauth.AuthorizationServer;
          try {
            server = await issuerMetadata(issuer, response);
          } catch {
            continue;
          }
          if (server.issuer !== accepted) continue;
          const algorithms: unknown = server.id_token_signing_alg_values_supported;
          return Schema.is(Schema.Array(Schema.String))(algorithms) ? [...algorithms] : undefined;
        }
        return undefined;
      };
      let unusable: unknown;
      let unavailable: number | undefined;
      let last: { status: number; contentType: OAuthMediaType | undefined } | undefined;
      for (const location of metadataLocations(issuer)) {
        const response = await get(location.url);
        last = {
          status: response.status,
          contentType: mediaType(response.headers.get("content-type")),
        };
        if (response.status === 429 || response.status >= 500) unavailable ??= response.status;
        if (response.status !== 200) continue;
        let server: oauth.AuthorizationServer;
        try {
          server = await issuerMetadata(issuer, response);
        } catch (error) {
          unusable ??= withStatus(failure(error), 200);
          continue;
        }
        const algorithms =
          openid &&
          location.document === "oauth" &&
          server.id_token_signing_alg_values_supported === undefined
            ? await openidAlgorithms(server.issuer)
            : undefined;
        return {
          server:
            algorithms === undefined
              ? server
              : { ...server, id_token_signing_alg_values_supported: algorithms },
          document: location.document,
        };
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
                ...(found.document === undefined ? {} : { document: found.document }),
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

  /** One metadata document, read only from a 200 response. Redirects are never followed. */
  const metadataDocument = (location: ResourceMetadataLocation, endpoint: URL, url?: URL) =>
    request(async (settings) => {
      const response =
        location === "path"
          ? await oauth.resourceDiscoveryRequest(endpoint, settings)
          : await settings[oauth.customFetch](
              (url ?? new URL("/.well-known/oauth-protected-resource", endpoint)).href,
              {
                method: "GET",
                body: undefined,
                headers: { accept: "application/json" },
                redirect: "manual",
                signal: settings.signal,
              },
            );
      const document: unknown = response.status === 200 ? await response.json() : undefined;
      return { status: response.status, document };
    });

  /**
   * RFC 9728 protected-resource metadata, as MCP clients look for it: the document a Bearer
   * challenge names, otherwise the path-suffixed well-known URL and then the root one. A
   * well-known URL that does not answer 200 publishes nothing, so the next one is tried; a
   * challenge names its own document, so a missing one is a failure. Every lookup is recorded.
   */
  const readResourceMetadata = (endpoint: URL, advertised: string | undefined) =>
    Effect.gen(function* () {
      const lookups: Array<ResourceMetadataSignal> = [];
      const done = (outcome: Omit<ResourceRead, "lookups">): ResourceRead => ({
        lookups,
        ...outcome,
      });
      const record = (
        location: ResourceMetadataLocation,
        result: ResourceMetadataSignal["result"],
        status?: number,
      ) =>
        lookups.push(
          ResourceMetadataSignal.make({
            location,
            result,
            ...(status === undefined ? {} : { status }),
          }),
        );
      const challengeUrl =
        advertised === undefined ? undefined : parseDestination(advertised, options.urlPolicy);
      if (advertised !== undefined && challengeUrl === undefined) {
        record("challenge", "blocked");
        return done({ failed: new OAuthProtocolFailed({ reason: "destination_blocked" }) });
      }
      const locations: ReadonlyArray<ResourceMetadataLocation> =
        challengeUrl !== undefined
          ? ["challenge"]
          : endpoint.pathname === "/"
            ? ["root"]
            : ["path", "root"];
      for (const location of locations) {
        const answer = yield* Effect.result(metadataDocument(location, endpoint, challengeUrl));
        if (Result.isFailure(answer)) {
          const failed = answer.failure;
          record(location, failed.reason === "request" ? "unavailable" : "invalid", failed.status);
          return done({ failed });
        }
        const { status, document } = answer.success;
        if (status === 429 || status >= 500) {
          record(location, "unavailable", status);
          return done({ failed: new OAuthProtocolFailed({ reason: "request", status }) });
        }
        if (status !== 200) {
          record(location, "missing", status);
          if (location !== "challenge") continue;
          return done({
            failed: new OAuthProtocolFailed({
              reason: status === 404 || status === 410 ? "metadata_missing" : "invalid_response",
              status,
            }),
          });
        }
        const decoded = yield* Effect.result(decode(OAuthResource, document));
        if (Result.isFailure(decoded)) {
          record(location, "invalid", status);
          return done({ failed: decoded.failure });
        }
        const metadata = decoded.success;
        const resource = parseDestination(metadata.resource, options.urlPolicy);
        if (resource === undefined) {
          record(location, "blocked", status);
          return done({ failed: new OAuthProtocolFailed({ reason: "destination_blocked" }) });
        }
        // A resource can cover /mcp from the origin root, but cannot name a sibling
        // service or a different host. Preserve its exact advertised identifier.
        const prefix = resource.pathname.endsWith("/")
          ? resource.pathname
          : resource.pathname + "/";
        if (
          resource.origin !== endpoint.origin ||
          (resource.pathname !== endpoint.pathname && !endpoint.pathname.startsWith(prefix))
        ) {
          record(location, "mismatch", status);
          return done({ failed: new OAuthProtocolFailed({ reason: "resource_mismatch" }) });
        }
        record(location, "found", status);
        return done({ found: { metadata, location } });
      }
      return done({});
    });

  /**
   * The authorization server named by the resource metadata. Without resource metadata, MCP's
   * earlier authorization rules use the server itself, then its origin, as the authorization
   * base; Atlassian publishes metadata only at the origin. Only missing metadata falls back:
   * served metadata that is invalid or names another issuer never selects a different issuer.
   */
  const resolveIssuer = (
    issuerUrl: URL,
    fromResourceMetadata: boolean,
    openid: boolean,
    metadataUrl?: URL,
  ) =>
    metadataUrl === undefined && !fromResourceMetadata && issuerUrl.pathname !== "/"
      ? discoverIssuer(issuerUrl, openid).pipe(
          Effect.flatMap((path) =>
            "missing" in path
              ? Effect.annotateCurrentSpan("oauth.discovery.fallback", "origin").pipe(
                  Effect.andThen(discoverIssuer(new URL(issuerUrl.origin), openid)),
                )
              : Effect.succeed(path),
          ),
        )
      : discoverIssuer(issuerUrl, openid, metadataUrl);

  const discoverResource = (endpoint: URL) =>
    Effect.gen(function* () {
      // Inspect only headers: a successful MCP GET may open an endless SSE stream.
      const challenge = yield* probeOAuthChallenge(endpoint, options.httpClient).pipe(
        Effect.flatMap((response) =>
          response.status === 429 || response.status >= 500
            ? limitedUntil(response.status, response.retryAfter).pipe(
                Effect.flatMap((retryAfter) =>
                  Effect.fail(
                    new OAuthProtocolFailed({
                      reason: "request",
                      status: response.status,
                      ...(retryAfter === undefined ? {} : { retryAfter }),
                    }),
                  ),
                ),
              )
            : Effect.succeed(response),
        ),
        Effect.mapError(failure),
      );
      const read = yield* readResourceMetadata(endpoint, challenge.resourceMetadata);
      if (read.failed !== undefined) return yield* read.failed;
      return { metadata: read.found?.metadata, scopes: challenge.scopes };
    });

  type OAuthMethod = Extract<ProviderAuthMethod, { type: "oauth2" }>;

  /**
   * Settings discovered from a resource whose protected-resource metadata was already read:
   * the authorization server that metadata names, or the resource itself without metadata.
   */
  const fromResource = (
    method: OAuthMethod,
    resource: URL,
    read: {
      readonly metadata?: OAuthResource | undefined;
      readonly scopes?: ReadonlyArray<string> | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const found = read.metadata;
      const metadataUrl =
        method.authorizationServerMetadataUrl === undefined
          ? undefined
          : yield* secureUrl(method.authorizationServerMetadataUrl);
      const issuer = found === undefined ? resource.href : found.authorization_servers[0];
      if (issuer === undefined)
        return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
      const issuerUrl = yield* secureUrl(issuer);
      // Authored scopes win. MCP challenges name the operations' required scopes; the
      // resource metadata's scope list is the default only when the challenge omits it. The list
      // never widens a challenge: an issuer can support two scopes and refuse them together.
      const scopes = new Set(method.scopes ?? read.scopes ?? resourceScopes(found) ?? []);
      const { server, audienceFromScopes, document } = yield* resolveIssuer(
        issuerUrl,
        found !== undefined,
        scopes.has("openid"),
        metadataUrl,
      ).pipe(Effect.flatMap(requireIssuer));
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
      const settings = {
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
      return { settings, ...(document === undefined ? {} : { document }) };
    });

  /**
   * Every endpoint account setup would call must satisfy the host's URL policy. The optional
   * revocation endpoint is not required to connect; the transport still enforces this policy
   * when revocation calls it.
   */
  const allowedEndpoints = (server: OAuthTokenServer) =>
    Effect.forEach(
      [
        server.issuer,
        server.authorization_endpoint,
        server.token_endpoint,
        server.registration_endpoint,
      ].filter((address) => address !== undefined),
      secureUrl,
      { discard: true },
    );

  /**
   * A browser sign-in needs an authorization endpoint, and Executor always sends PKCE with S256.
   * A server that lists its PKCE methods without S256 is refused. One that omits the list still
   * gets S256: Microsoft Entra ID and Sign in with Apple accept it without listing it, so
   * refusing such a server, as MCP asks, would refuse every MCP server they protect. Account
   * setup and import checks both apply this, so a check never confirms OAuth that setup would
   * refuse.
   */
  const browserServer = (server: OAuthTokenServer) =>
    Effect.gen(function* () {
      yield* allowedEndpoints(server);
      const browser = yield* decode(OAuthServer, server);
      if (
        browser.code_challenge_methods_supported !== undefined &&
        !browser.code_challenge_methods_supported.includes("S256")
      )
        return yield* new OAuthProtocolFailed({
          reason: "unsupported",
          field: "code_challenge_methods_supported",
        });
      return browser;
    });

  return {
    discover: (method: OAuthMethod) =>
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
          const read = yield* discoverResource(resource);
          return (yield* fromResource(method, resource, read)).settings;
        });
        // Frozen on the attempt and grant, so renewal sends what sign-in did.
        const requestEncoding = {
          ...(method.scopeSeparator === undefined ? {} : { scopeSeparator: method.scopeSeparator }),
          ...(method.tokenRequestFormat === undefined
            ? {}
            : { tokenRequestFormat: method.tokenRequestFormat }),
        };
        if (method.grant === "client_credentials") {
          yield* allowedEndpoints(resolved.server);
          return { ...resolved, ...requestEncoding, grant: "client_credentials" as const };
        }
        return {
          ...resolved,
          ...requestEncoding,
          grant: "authorization_code" as const,
          server: yield* browserServer(resolved.server),
          ...(method.authorizationParams === undefined
            ? {}
            : { authorizationParams: method.authorizationParams }),
          ...(method.tokenResponse === undefined ? {} : { tokenResponse: method.tokenResponse }),
        };
      }).pipe(protocolStage("discover")),
    /**
     * What a resource advertises about authorization-code OAuth, for an import check. The caller
     * has already requested the resource and passes the challenge it saw, so nothing is probed
     * here. `originFallback` applies MCP's earlier rule for a server that rejects anonymous use
     * but publishes no resource metadata. The rest is account setup's own discovery and checks,
     * and `registration` is how setup on this host would obtain a client, so an import check
     * never confirms OAuth that setup would refuse. Every lookup is returned as a signal.
     */
    inspect: (
      endpoint: URL,
      observed: {
        readonly resourceMetadata?: string | undefined;
        readonly originFallback: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const read = yield* readResourceMetadata(endpoint, observed.resourceMetadata);
        const signals: Array<ResourceOAuthSignal> = [...read.lookups];
        if (read.failed !== undefined)
          return ResourceOAuth.cases.OAuthUnusable.make({
            reason: unusableReason(read.failed),
            signals,
          });
        if (read.found === undefined && !observed.originFallback)
          return ResourceOAuth.cases.OAuthNotAdvertised.make({ signals });
        const issuer = read.found === undefined ? "origin" : "resource_metadata";
        // The provider an import generates declares only `discover`, so setup sees this method.
        const method: OAuthMethod = { type: "oauth2", discover: endpoint.href, response: {} };
        const checked = yield* Effect.result(
          fromResource(method, endpoint, { metadata: read.found?.metadata }).pipe(
            Effect.flatMap(({ settings, document }) =>
              browserServer(settings.server).pipe(Effect.map((server) => ({ server, document }))),
            ),
          ),
        );
        if (Result.isFailure(checked)) {
          const failed = checked.failure;
          const reason = unusableReason(failed);
          signals.push(
            AuthorizationServerSignal.make({
              issuer,
              result:
                reason === "metadata_missing"
                  ? "missing"
                  : reason === "unavailable" || reason === "blocked" || reason === "unsupported"
                    ? reason
                    : "invalid",
              ...(failed.status === undefined ? {} : { status: failed.status }),
            }),
          );
          // Without resource metadata, a missing authorization server means no OAuth at all.
          return reason === "metadata_missing" && read.found === undefined
            ? ResourceOAuth.cases.OAuthNotAdvertised.make({ signals })
            : ResourceOAuth.cases.OAuthUnusable.make({ reason, signals });
        }
        const { server, document } = checked.success;
        const registration = clientRegistration(
          server,
          method.tokenEndpointAuthMethod,
          options.clientMetadataUrl,
        );
        signals.push(
          AuthorizationServerSignal.make({
            issuer,
            result: "found",
            ...(document === undefined ? {} : { document }),
            registration,
          }),
        );
        return ResourceOAuth.cases.OAuthAdvertised.make({ registration, signals });
      }).pipe(Effect.withSpan("oauth.inspect")),
    register: (
      server: OAuthServer,
      redirect: URL,
      scopes: readonly string[],
      configured?: OAuthClientAuth,
    ) =>
      Effect.gen(function* () {
        const method = yield* clientMethod(server, "registered", configured);
        const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
        const registered = yield* request(
          async (settings) => {
            const response = await oauth.dynamicClientRegistrationRequest(
              metadata(server),
              {
                client_name: options.clientName,
                redirect_uris: [redirect.href],
                application_type: applicationType(redirect),
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
            // A registration request sends no secret.
          },
          { sent: [] },
        );
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
        const state = `${options.statePrefix ?? ""}${yield* Effect.sync(oauth.generateRandomState)}`;
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
        catch: callbackFailure,
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
      request(
        async (settings) => {
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
        },
        {
          format: input.tokenRequestFormat,
          sent: [parameters.get("code"), input.verifier, ...clientSecrets(input.client)],
        },
      ).pipe(protocolStage("exchange")),
    clientCredentials: (input: {
      server: OAuthTokenServer;
      client: OAuthConfidentialRegistration;
      scopes: readonly string[];
      resource?: string | undefined;
      scopeSeparator?: string | undefined;
      tokenRequestFormat?: OAuthTokenRequestFormat | undefined;
    }) =>
      request(
        async (settings) => {
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
        },
        { format: input.tokenRequestFormat, sent: clientSecrets(input.client) },
      ).pipe(protocolStage("clientCredentials")),
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
      request(
        async (settings) => {
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
        },
        {
          format: input.tokenRequestFormat,
          sent: [input.refreshToken, ...clientSecrets(input.client)],
        },
      ).pipe(protocolStage("refresh")),
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
 * What a protected resource advertises about authorization-code OAuth an account connection can
 * complete, with the lookups that decided it. The caller passes the challenge it observed when it
 * requested the resource. A discovery failure is reported, never replaced by another method.
 */
export const discoverResourceOAuth = (
  resource: string,
  options: Pick<OAuthOptions, "httpClient" | "urlPolicy" | "clientMetadataUrl">,
  observed: { readonly resourceMetadata?: string | undefined; readonly originFallback: boolean },
) => {
  const endpoint = parseDestination(resource, options.urlPolicy);
  return endpoint === undefined
    ? Effect.succeed(ResourceOAuth.cases.OAuthUnusable.make({ reason: "blocked", signals: [] }))
    : makeOAuthProtocol({ ...options, clientName: "Executor" }).inspect(endpoint, observed);
};
