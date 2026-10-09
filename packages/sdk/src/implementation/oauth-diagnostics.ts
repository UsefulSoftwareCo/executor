/**
 * Safe diagnostic evidence for OAuth protocol failures. Every recorded value comes from a fixed
 * vocabulary: library messages become labels, and provider codes, challenge schemes, claim and
 * attribute names and media types are recorded only when they are known. Anything else becomes
 * `unrecognized`. Provider free text such as `error_description` is recorded only as a length.
 * The shape of a value is never taken as proof that it is safe to record. The service's own words,
 * returned to the person connecting as `OAuthServiceError`, never enter these diagnostics.
 */
import { Schema } from "effect";
import * as oauth from "oauth4webapi";

/** Stable labels for the checks that failed. Library message text itself is never recorded. */
export const OAuthFailureDetail = Schema.Literals([
  // The service answered with an OAuth error.
  "response_body_error",
  "www_authenticate_challenge",
  "authorization_response_error",
  "unsupported_operation",
  // Response shape.
  "unexpected_status",
  "content_type_unexpected",
  "body_not_json",
  "body_not_object",
  "body_property_invalid",
  "body_property_mismatch",
  "server_metadata_missing",
  "server_metadata_invalid",
  "https_required",
  "protocol_forbidden",
  // ID tokens and other JWTs.
  "jwt_claim_mismatch",
  "jwt_claim_missing",
  "jwt_claim_invalid",
  "jwt_timestamp",
  "jwt_alg_unexpected",
  "jwt_header_unexpected",
  "jwt_signature_invalid",
  "jwt_malformed",
  "jwks_key_not_found",
  "jwks_key_ambiguous",
  // The authorization response that returned to the callback.
  "callback_unparseable",
  "callback_fragment",
  "callback_credentials",
  "callback_state_missing",
  "callback_state_short",
  "callback_state_repeated",
  "callback_state_mismatch",
  "callback_state_unexpected",
  "callback_attempt_not_found",
  "callback_redirect_mismatch",
  "callback_issuer_missing",
  "callback_issuer_mismatch",
  "callback_parameter_repeated",
  "callback_code_missing",
  "callback_jarm_unsupported",
  "unrecognized",
]);
export type OAuthFailureDetail = typeof OAuthFailureDetail.Type;

/** Parts of the returned authorization response that callback validation checks. */
export const OAuthCallbackField = Schema.Literals([
  "callback_url",
  "redirect_uri",
  "state",
  "code",
  "iss",
  "error",
]);
export type OAuthCallbackField = typeof OAuthCallbackField.Type;

/** Marks a value that was present but is not in the vocabulary. The value itself is dropped. */
const unrecognized = "unrecognized";

/**
 * Error codes defined by RFC 6749, RFC 6750, RFC 7009, RFC 7591, RFC 8628, RFC 8707, RFC 9449 and
 * OpenID Connect, and the aliases services send in their place.
 */
export const OAuthKnownErrorCode = Schema.Literals([
  // RFC 6749 §4.1.2.1 and §5.2.
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  // RFC 6750 §3.1.
  "invalid_token",
  "insufficient_scope",
  // RFC 7009 §2.2.1.
  "unsupported_token_type",
  // RFC 7591 §3.2.2.
  "invalid_redirect_uri",
  "invalid_client_metadata",
  "invalid_software_statement",
  "unapproved_software_statement",
  // RFC 8628 §3.5.
  "authorization_pending",
  "slow_down",
  "expired_token",
  // RFC 8707 §2 and RFC 9449 §5, §7.1.
  "invalid_target",
  "invalid_dpop_proof",
  "use_dpop_nonce",
  // OpenID Connect Core §3.1.2.6.
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
  "invalid_request_uri",
  "invalid_request_object",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
  // Aliases: GitHub, Google and others.
  "incorrect_client_credentials",
  "invalid_client_id",
  "invalid_client_secret",
  "redirect_uri_mismatch",
  "bad_verification_code",
  unrecognized,
]);
export type OAuthKnownErrorCode = typeof OAuthKnownErrorCode.Type;

/** WWW-Authenticate schemes, lowercase. */
export const OAuthChallengeScheme = Schema.Literals([
  "bearer",
  "dpop",
  "basic",
  "digest",
  "negotiate",
  unrecognized,
]);

/** JWT claims that ID token and JWT validation checks. */
export const OAuthClaimName = Schema.Literals([
  "iss",
  "sub",
  "aud",
  "azp",
  "exp",
  "iat",
  "nbf",
  "auth_time",
  "nonce",
  "at_hash",
  "c_hash",
  "s_hash",
  "acr",
  "amr",
  "sid",
  "jti",
  "htm",
  "htu",
  "ath",
  unrecognized,
]);

/** Response body and authorization server metadata attributes that validation checks. */
export const OAuthAttributeName = Schema.Literals([
  "access_token",
  "token_type",
  "expires_in",
  "refresh_token",
  "id_token",
  "scope",
  "client_id",
  "client_secret",
  "client_secret_expires_at",
  "issuer",
  "resource",
  "sub",
  "keys",
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
  "jwks_uri",
  "userinfo_endpoint",
  "introspection_endpoint",
  "revocation_endpoint",
  "device_authorization_endpoint",
  "pushed_authorization_request_endpoint",
  "end_session_endpoint",
  unrecognized,
]);

/** Response media types, without parameters. */
export const OAuthMediaType = Schema.Literals([
  "application/json",
  "application/jwt",
  "application/jwk-set+json",
  "application/problem+json",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/octet-stream",
  "text/html",
  "text/plain",
  "text/xml",
  unrecognized,
]);
export type OAuthMediaType = typeof OAuthMediaType.Type;

/** Character classes of an unrecognized code; its characters are never recorded. */
export const OAuthCodeCharset = Schema.Literals(["lowercase_code", "code", "printable", "other"]);

/** Private diagnostic evidence. Every value is a fixed label or a size. */
export const OAuthDiagnostics = Schema.Struct({
  detail: Schema.optional(OAuthFailureDetail),
  /** The JWT claim that failed, such as `iss`, `aud` or `nonce`. */
  claim: Schema.optional(OAuthClaimName),
  /** The JSON body or metadata attribute that failed, such as `issuer` or `token_endpoint`. */
  attribute: Schema.optional(OAuthAttributeName),
  callbackField: Schema.optional(OAuthCallbackField),
  challengeScheme: Schema.optional(OAuthChallengeScheme),
  /** The challenge's `error` parameter. */
  challengeError: Schema.optional(OAuthKnownErrorCode),
  contentType: Schema.optional(OAuthMediaType),
  /** The provider's `error` code. */
  providerCode: Schema.optional(OAuthKnownErrorCode),
  /** The length and character class of an unrecognized provider `error` code. */
  unrecognizedCode: Schema.optional(
    Schema.Struct({ length: Schema.Int, charset: OAuthCodeCharset }),
  ),
  /** The length of the provider's `error_description`. Its text is never recorded. */
  descriptionLength: Schema.optional(Schema.Int),
});
export type OAuthDiagnostics = typeof OAuthDiagnostics.Type;

/** Match a present value against a vocabulary, ignoring case; anything else is `unrecognized`. */
const vocabulary =
  <A extends string>(is: (value: unknown) => value is A) =>
  (value: unknown): A | typeof unrecognized | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    const lower = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return is(lower) ? lower : unrecognized;
  };
const knownCode = vocabulary(Schema.is(OAuthKnownErrorCode));
const knownScheme = vocabulary(Schema.is(OAuthChallengeScheme));
const knownClaim = vocabulary(Schema.is(OAuthClaimName));
const knownAttribute = vocabulary(Schema.is(OAuthAttributeName));
const knownMediaType = vocabulary(Schema.is(OAuthMediaType));

const charset = (value: string) =>
  /^[a-z0-9_]+$/.test(value)
    ? "lowercase_code"
    : /^[A-Za-z0-9_.-]+$/.test(value)
      ? "code"
      : /^[\x20-\x7e]+$/.test(value)
        ? "printable"
        : "other";

/** A provider `error`: the known code, or `unrecognized` with its length and character class. */
export const providerCodeDiagnostics = (value: unknown): OAuthDiagnostics => {
  const code = knownCode(value);
  if (code === undefined) return {};
  return code === unrecognized && typeof value === "string"
    ? { providerCode: code, unrecognizedCode: { length: value.length, charset: charset(value) } }
    : { providerCode: code };
};

/** The length of a provider `error_description`. */
export const descriptionLength = (value: unknown) =>
  typeof value === "string" && value !== "" ? value.length : undefined;

/** The response media type, without parameters such as charset or boundary. */
export const mediaType = (value: string | null | undefined) => knownMediaType(value?.split(";")[0]);

/** The first WWW-Authenticate challenge's scheme and `error` parameter. */
export const challengeDiagnostics = (header: string | null | undefined): OAuthDiagnostics => {
  if (header === null || header === undefined) return {};
  const scheme = /^[\s,]*([^\s,]+)/.exec(header)?.[1];
  const error = /(?:^|[\s,])error\s*=\s*"?([^",\s]*)/i.exec(header)?.[1];
  return withDefined({ challengeScheme: knownScheme(scheme), challengeError: knownCode(error) });
};

const withDefined = (values: {
  readonly [Key in keyof OAuthDiagnostics]: OAuthDiagnostics[Key] | undefined;
}): OAuthDiagnostics =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

/** Map an oauth4webapi message, a fixed library string, to its stable label and named part. */
const libraryMessage = (
  message: string,
  code: unknown,
): { detail: OAuthFailureDetail; claim?: string; attribute?: string } => {
  const quoted = /"([a-z_]+)"/.exec(message)?.[1];
  const property = /^"response" body "([a-z_]+)" property/.exec(message)?.[1];
  const jwtClaim = /^(?:unexpected )?(?:JWT|ID Token) "([a-z_]+)"/.exec(message)?.[1];
  if (code === oauth.JWT_TIMESTAMP_CHECK)
    return { detail: "jwt_timestamp", ...(jwtClaim === undefined ? {} : { claim: jwtClaim }) };
  if (message.includes('JWT "alg"')) return { detail: "jwt_alg_unexpected" };
  if (message.startsWith('unexpected JWT "typ" header')) return { detail: "jwt_header_unexpected" };
  if (message === "JWT signature verification failed") return { detail: "jwt_signature_invalid" };
  if (message.startsWith("error when selecting a JWT verification key"))
    return { detail: message.includes("multiple") ? "jwks_key_ambiguous" : "jwks_key_not_found" };
  if (message === "Invalid JWT" || /^(?:failed to parse )?JWT (?:Header|Payload)/.test(message))
    return { detail: "jwt_malformed" };
  if (jwtClaim !== undefined)
    return {
      detail: message.endsWith("claim missing")
        ? "jwt_claim_missing"
        : message.endsWith("claim type")
          ? "jwt_claim_invalid"
          : "jwt_claim_mismatch",
      claim: jwtClaim,
    };
  if (/^invalid ID Token "([a-z_]+)"/.test(message))
    return { detail: "jwt_claim_mismatch", ...(quoted === undefined ? {} : { claim: quoted }) };
  if (message.startsWith('"response" content-type must be'))
    return { detail: "content_type_unexpected" };
  if (message.startsWith('"response" is not a conform')) return { detail: "unexpected_status" };
  if (message === 'failed to parse "response" body as JSON') return { detail: "body_not_json" };
  if (message === '"response" body must be a top level object')
    return { detail: "body_not_object" };
  if (property !== undefined)
    return {
      detail: message.endsWith("does not match the expected value")
        ? "body_property_mismatch"
        : "body_property_invalid",
      attribute: property,
    };
  if (message.startsWith("authorization server metadata does not contain"))
    return {
      detail:
        code === oauth.MISSING_SERVER_METADATA
          ? "server_metadata_missing"
          : "server_metadata_invalid",
    };
  if (message === "only requests to HTTPS are allowed") return { detail: "https_required" };
  if (message === "only HTTP and HTTPS requests are allowed")
    return { detail: "protocol_forbidden" };
  if (message === 'response parameter "iss" (issuer) missing')
    return { detail: "callback_issuer_missing" };
  if (message === 'unexpected "iss" (issuer) response parameter value')
    return { detail: "callback_issuer_mismatch" };
  if (message === 'response parameter "state" missing') return { detail: "callback_state_missing" };
  if (message === 'unexpected "state" response parameter value')
    return { detail: "callback_state_mismatch" };
  if (message === 'unexpected "state" response parameter encountered')
    return { detail: "callback_state_unexpected" };
  if (message.endsWith("parameter must be provided only once"))
    return { detail: "callback_parameter_repeated" };
  if (message.startsWith('"parameters" contains a JARM response'))
    return { detail: "callback_jarm_unsupported" };
  return { detail: "unrecognized" };
};

const callbackFields: Partial<Record<OAuthFailureDetail, OAuthCallbackField>> = {
  callback_issuer_missing: "iss",
  callback_issuer_mismatch: "iss",
  callback_state_missing: "state",
  callback_state_mismatch: "state",
  callback_state_unexpected: "state",
};

/** Response evidence shared by every failure that saw one. */
const responseDiagnostics = (response: unknown): OAuthDiagnostics =>
  response instanceof Response
    ? withDefined({
        contentType: mediaType(response.headers.get("content-type")),
        ...challengeDiagnostics(response.headers.get("www-authenticate")),
      })
    : {};

/** Safe evidence from an oauth4webapi error. Its message, cause values and body are not kept. */
export const libraryDiagnostics = (error: unknown): OAuthDiagnostics => {
  if (error instanceof oauth.ResponseBodyError)
    return withDefined({
      ...responseDiagnostics(error.response),
      detail: "response_body_error",
      ...providerCodeDiagnostics(error.error),
      descriptionLength: descriptionLength(error.error_description),
    });
  if (error instanceof oauth.WWWAuthenticateChallengeError) {
    const [first] = error.cause;
    return withDefined({
      ...responseDiagnostics(error.response),
      detail: "www_authenticate_challenge",
      challengeScheme: knownScheme(first?.scheme),
      challengeError: knownCode(first?.parameters.error),
      descriptionLength: descriptionLength(first?.parameters.error_description),
    });
  }
  if (error instanceof oauth.AuthorizationResponseError)
    return withDefined({
      detail: "authorization_response_error",
      callbackField: "error",
      ...providerCodeDiagnostics(error.error),
      descriptionLength: descriptionLength(error.error_description),
    });
  if (error instanceof oauth.UnsupportedOperationError) return { detail: "unsupported_operation" };
  if (!(error instanceof oauth.OperationProcessingError)) return {};
  const cause: unknown = error.cause;
  const named = libraryMessage(error.message, error.code);
  const claim =
    typeof cause === "object" && cause !== null && !(cause instanceof Response)
      ? knownClaim(Reflect.get(cause, "claim"))
      : undefined;
  const attribute =
    typeof cause === "object" && cause !== null && !(cause instanceof Response)
      ? knownAttribute(Reflect.get(cause, "attribute"))
      : undefined;
  const repeated =
    named.detail === "callback_parameter_repeated"
      ? /^"([a-z_]+)"/.exec(error.message)?.[1]
      : undefined;
  return withDefined({
    ...responseDiagnostics(cause),
    detail: named.detail,
    claim: claim ?? knownClaim(named.claim),
    attribute: attribute ?? knownAttribute(named.attribute),
    callbackField:
      callbackFields[named.detail] ??
      (Schema.is(OAuthCallbackField)(repeated) ? repeated : undefined),
  });
};

/** Span attributes for diagnostic evidence. */
export const diagnosticAttributes = (diagnostics: OAuthDiagnostics | undefined) => {
  const attributes: Record<string, string | number> = {};
  if (diagnostics === undefined) return attributes;
  for (const [name, value] of [
    ["oauth.error.detail", diagnostics.detail],
    ["oauth.error.claim", diagnostics.claim],
    ["oauth.error.attribute", diagnostics.attribute],
    ["oauth.error.callback_field", diagnostics.callbackField],
    ["oauth.error.challenge.scheme", diagnostics.challengeScheme],
    ["oauth.error.challenge.error", diagnostics.challengeError],
    ["oauth.error.known_provider_code", diagnostics.providerCode],
    ["oauth.error.unrecognized_code.length", diagnostics.unrecognizedCode?.length],
    ["oauth.error.unrecognized_code.charset", diagnostics.unrecognizedCode?.charset],
    ["oauth.error.description_length", diagnostics.descriptionLength],
    ["oauth.response.content_type", diagnostics.contentType],
  ] as const)
    if (value !== undefined) attributes[name] = value;
  return attributes;
};
