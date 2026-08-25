// ---------------------------------------------------------------------------
// Enterprise-Managed Authorization (EMA) — the client half.
//
// MCP "Enterprise-Managed Authorization" profiles
// draft-ietf-oauth-identity-assertion-authz-grant-04 for the case where the MCP
// client and the MCP server share an enterprise IdP. Instead of walking the
// user through per-server consent, the client:
//
//   1. holds an identity assertion from SSO with the IdP,
//   2. exchanges it at the IdP for an Identity Assertion JWT Authorization
//      Grant (ID-JAG) naming the MCP server's authorization server (§4.3), and
//   3. redeems that ID-JAG at the Resource Authorization Server for an access
//      token bound to the MCP server (§4.4).
//
// The IdP evaluates administrator policy at step 2, which is the whole point of
// the profile (§7.2): the enterprise decides which users may reach which
// servers with which scopes. That makes the error taxonomy below load-bearing
// rather than cosmetic — see `EmaPolicyDenied`.
//
// This module owns the chain only. Discovery lives in `./oauth-discovery`, the
// two token-endpoint round trips in `./oauth-helpers`, and persistence in the
// executor's credential lifecycle.
// ---------------------------------------------------------------------------

import { Data, Effect, Option, Schema } from "effect";

import { OAuthClientSlug, Owner } from "./ids";
import {
  DEFAULT_SUBJECT_TOKEN_TYPE,
  SubjectTokenTypeSchema,
  type SubjectTokenType,
} from "./oauth-client";
import {
  ID_JAG_GRANT_PROFILE,
  supportsIdJagGrantProfile,
  type OAuthAuthorizationServerMetadata,
} from "./oauth-discovery";
import {
  exchangeSubjectTokenForIdJag,
  redeemIdJagAssertion,
  type OAuth2Error,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";

// ---------------------------------------------------------------------------
// Persisted connection state
//
// Everything the renewal path needs that is NOT already a column on the
// connection or its `oauth_client` row. The `oauth_client` supplies the client's
// registration at the Resource Authorization Server (id/secret/token URL/
// resource); the connection supplies the granted scope and the identity
// assertion (stored in the same credential-provider item a refresh token would
// occupy — it plays exactly that role here). What remains is the pointer to the
// IdP registration and the discovered `audience`, which cannot be derived from
// either.
// ---------------------------------------------------------------------------

export const EnterpriseManagedConnectionStateSchema = Schema.Struct({
  /** `oauth_client` slug of the client's registration at the enterprise IdP. */
  idpClient: OAuthClientSlug,
  idpClientOwner: Owner,
  /** The Resource Authorization Server's issuer identifier, as discovered from
   *  its RFC 8414 metadata when the connection was made. */
  audience: Schema.String,
  subjectTokenType: SubjectTokenTypeSchema,
}).annotate({
  identifier: "EnterpriseManagedConnectionState",
  description:
    "Enterprise-managed authorization wiring persisted on a connection: which IdP registration mints its ID-JAG, and the audience that ID-JAG must name.",
});
export type EnterpriseManagedConnectionState = typeof EnterpriseManagedConnectionStateSchema.Type;

/** The key `EnterpriseManagedConnectionState` occupies inside a connection's
 *  `provider_state` JSON, alongside the other core-owned keys. */
export const ENTERPRISE_MANAGED_PROVIDER_STATE_KEY = "enterpriseManaged";

const decodeEnterpriseManagedProviderState = Schema.decodeUnknownOption(
  Schema.Struct({
    [ENTERPRISE_MANAGED_PROVIDER_STATE_KEY]: EnterpriseManagedConnectionStateSchema,
  }),
);

/** Read the enterprise-managed wiring off a connection's decoded
 *  `provider_state`, or null when the connection is not enterprise-managed.
 *  A malformed entry reads as absent — the refresh path then fails loudly with
 *  "not enterprise-managed" rather than half-running the chain on fragments. */
export const enterpriseManagedStateFrom = (
  providerState: unknown,
): EnterpriseManagedConnectionState | null =>
  Option.match(decodeEnterpriseManagedProviderState(providerState), {
    onNone: () => null,
    onSome: (decoded) => decoded[ENTERPRISE_MANAGED_PROVIDER_STATE_KEY],
  });

// ---------------------------------------------------------------------------
// Errors
//
// The distinctions here drive product behavior, so they are separate tags
// rather than one error carrying a code:
//
//   - `EmaGrantProfileUnsupported` is the ONLY failure that permits falling
//     back to the ordinary interactive per-server OAuth flow. The server simply
//     does not implement the profile.
//   - `EmaPolicyDenied` and `EmaSubjectTokenRejected` MUST NOT fall back.
//     Falling back would let a user route around the enterprise policy the IdP
//     just enforced, which is precisely the control this profile exists to
//     provide.
// ---------------------------------------------------------------------------

/** The Resource Authorization Server does not advertise the ID-JAG grant
 *  profile in its RFC 8414 metadata (draft §7.2). Enterprise-managed
 *  authorization is not available for this server; the caller MAY fall back to
 *  the ordinary interactive authorization-code flow. */
export class EmaGrantProfileUnsupported extends Data.TaggedError("EmaGrantProfileUnsupported")<{
  readonly issuer: string;
  readonly advertised: readonly string[];
}> {
  override get message(): string {
    return `The authorization server ${this.issuer} does not advertise ${ID_JAG_GRANT_PROFILE}${
      this.advertised.length > 0 ? ` (advertised: ${this.advertised.join(", ")})` : ""
    }.`;
  }
}

/** The enterprise IdP refused to mint an ID-JAG for this client, user, resource
 *  or scope set. This is an administrator decision, not a credential problem:
 *  the user cannot fix it by signing in again, and the client MUST NOT offer
 *  the interactive per-server flow as an alternative route. Surface it as
 *  blocked-by-admin and stop. */
export class EmaPolicyDenied extends Data.TaggedError("EmaPolicyDenied")<{
  /** The IdP's RFC 6749 §5.2 error code (`unauthorized_client`, `access_denied`,
   *  `invalid_target`, `invalid_scope`, `invalid_client`, …). */
  readonly error: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `Your organization's identity provider did not authorize this MCP server (${this.error}): ${this.detail}`;
  }
}

/** The IdP rejected the identity assertion itself (RFC 6749 `invalid_grant`):
 *  expired, revoked, or issued for a different client. The user must sign in
 *  with the enterprise IdP again to obtain a fresh assertion. */
export class EmaSubjectTokenRejected extends Data.TaggedError("EmaSubjectTokenRejected")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `The enterprise identity assertion was rejected and a new single sign-on is required: ${this.detail}`;
  }
}

/** The Resource Authorization Server refused the ID-JAG (draft §4.4.1): wrong
 *  `typ`, an `aud` naming a different authorization server, a `client_id` claim
 *  that does not match the authenticated client, a bad signature, or expiry. */
export class EmaRedemptionRejected extends Data.TaggedError("EmaRedemptionRejected")<{
  /** The Resource Authorization Server's RFC 6749 §5.2 code, when it returned one. */
  readonly error: string | undefined;
  readonly detail: string;
}> {
  override get message(): string {
    return `The MCP server's authorization server rejected the identity assertion grant${
      this.error === undefined ? "" : ` (${this.error})`
    }: ${this.detail}`;
  }
}

/** A token endpoint could not be reached, timed out, or answered with something
 *  that is not an OAuth response at all. Carries no authorization verdict, so
 *  it is retryable: the next attempt may well succeed. */
export class EmaUpstreamUnavailable extends Data.TaggedError("EmaUpstreamUnavailable")<{
  readonly step: "token-exchange" | "redemption";
  readonly detail: string;
}> {
  override get message(): string {
    return `The enterprise-managed authorization ${this.step} request failed: ${this.detail}`;
  }
}

/** What running the two-step grant can fail with. Notably NOT
 *  `EmaGrantProfileUnsupported`: minting never inspects metadata, so it cannot
 *  reach that verdict, and callers of `mintEnterpriseManagedAccessToken` must
 *  not be made to write an arm for a case that cannot occur. */
export type EnterpriseManagedMintError =
  | EmaPolicyDenied
  | EmaSubjectTokenRejected
  | EmaRedemptionRejected
  | EmaUpstreamUnavailable;

/** Everything `runEnterpriseManagedAuthorization` can fail with: the mint
 *  failures plus the one discovery verdict only it can produce. */
export type EnterpriseManagedAuthorizationError =
  | EnterpriseManagedMintError
  | EmaGrantProfileUnsupported;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The client's registration at the enterprise IdP — the relationship that
 *  authenticates the token-exchange request (draft §5: this is a DIFFERENT
 *  registration from the one at the Resource Authorization Server). */
export interface EnterpriseIdentityProvider {
  /** The IdP's token endpoint, where the RFC 8693 exchange is POSTed. */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Empty or null for a public client the IdP does not authenticate. */
  readonly clientSecret?: string | null;
}

/** The client's registration at the MCP server's Resource Authorization Server
 *  — the credentials that authenticate the ID-JAG redemption (draft §4.4). */
export interface ResourceAuthorizationServerClient {
  readonly tokenUrl: string;
  /** The Resource Authorization Server's RFC 8414 issuer identifier. Sent as
   *  the exchange's `audience` and validated by the server as the ID-JAG's
   *  `aud` claim, which is what stops an ID-JAG minted for one server from
   *  being replayed at another (draft §4.4.1). */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string | null;
}

export interface EnterpriseManagedAuthorizationInput {
  readonly idp: EnterpriseIdentityProvider;
  readonly resourceAuthorizationServer: ResourceAuthorizationServerClient;
  /** The identity assertion obtained from single sign-on with the IdP. */
  readonly subjectToken: string;
  readonly subjectTokenType?: SubjectTokenType;
  /** RFC 9728 resource identifier of the MCP server (EMA profile §4). */
  readonly resource?: string | null;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
}

/** An access token minted through the ID-JAG chain, plus the scope the Resource
 *  Authorization Server actually granted. There is no refresh token by design
 *  (draft §4.4.3): renewal re-runs the chain. */
export interface EnterpriseManagedGrant {
  readonly token: OAuth2TokenResponse;
  /** Granted scope as echoed by the Resource Authorization Server, falling back
   *  to what the IdP recorded in the ID-JAG. Null when neither said. */
  readonly scope: string | null;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

const exchangeFailure = (cause: OAuth2Error): EnterpriseManagedMintError => {
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error declares `message` as a field; this is a typed failure, not an unknown throwable
  const detail = cause.message;
  // RFC 6749 §5.2: `invalid_grant` is the code for a grant that is invalid,
  // expired or revoked — here, the identity assertion the client presented. Any
  // OTHER definitive code is the IdP declining to authorize this client for
  // this target, which is an administrator decision.
  if (cause.error === "invalid_grant") {
    return new EmaSubjectTokenRejected({ detail });
  }
  if (cause.error !== undefined) {
    return new EmaPolicyDenied({ error: cause.error, detail });
  }
  return new EmaUpstreamUnavailable({ step: "token-exchange", detail });
};

const redemptionFailure = (cause: OAuth2Error): EnterpriseManagedMintError => {
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: see `exchangeFailure` above
  const detail = cause.message;
  return cause.error === undefined
    ? new EmaUpstreamUnavailable({ step: "redemption", detail })
    : new EmaRedemptionRejected({ error: cause.error, detail });
};

/** Run the two-step grant: exchange the identity assertion for an ID-JAG at the
 *  IdP, then redeem the ID-JAG at the Resource Authorization Server.
 *
 *  The ID-JAG is deliberately NOT retained. Draft §4.4.3 lets a client re-submit
 *  a still-valid ID-JAG when only the access token expired, but that saves one
 *  round trip at the cost of persisting a second bearer-equivalent credential
 *  whose expiry the client would then have to track. Re-running the exchange is
 *  the simpler correct behavior and is what §4.4.3 prescribes once the ID-JAG
 *  itself has expired. */
export const mintEnterpriseManagedAccessToken = (
  input: EnterpriseManagedAuthorizationInput,
): Effect.Effect<EnterpriseManagedGrant, EnterpriseManagedMintError> =>
  Effect.gen(function* () {
    const grant = yield* exchangeSubjectTokenForIdJag({
      tokenUrl: input.idp.tokenUrl,
      clientId: input.idp.clientId,
      clientSecret: input.idp.clientSecret,
      subjectToken: input.subjectToken,
      subjectTokenType: input.subjectTokenType ?? DEFAULT_SUBJECT_TOKEN_TYPE,
      audience: input.resourceAuthorizationServer.issuer,
      resource: input.resource,
      scopes: input.scopes,
      timeoutMs: input.timeoutMs,
      endpointUrlPolicy: input.endpointUrlPolicy,
      fetch: input.fetch,
    }).pipe(Effect.mapError(exchangeFailure));

    // Re-request only what the IdP granted. Policy MAY narrow the set (§4.3.3),
    // and asking the Resource Authorization Server for more than the ID-JAG
    // carries would be asking it to exceed the enterprise's own decision.
    const grantedScopes =
      grant.scope === undefined ? input.scopes : grant.scope.split(/\s+/).filter(Boolean);

    const token = yield* redeemIdJagAssertion({
      tokenUrl: input.resourceAuthorizationServer.tokenUrl,
      issuerUrl: input.resourceAuthorizationServer.issuer,
      clientId: input.resourceAuthorizationServer.clientId,
      clientSecret: input.resourceAuthorizationServer.clientSecret,
      assertion: grant.assertion,
      resource: input.resource,
      scopes: grantedScopes,
      timeoutMs: input.timeoutMs,
      endpointUrlPolicy: input.endpointUrlPolicy,
      fetch: input.fetch,
    }).pipe(Effect.mapError(redemptionFailure));

    return {
      token,
      scope: token.scope ?? grant.scope ?? null,
    } satisfies EnterpriseManagedGrant;
  }).pipe(
    Effect.withSpan("executor.oauth.enterprise_managed", {
      attributes: { "executor.oauth.has_resource": input.resource != null },
    }),
  );

/** Detect the profile on the target's discovered metadata, then run the chain.
 *  The connect path uses this; the credential-refresh path calls
 *  `mintEnterpriseManagedAccessToken` directly, because the profile was already
 *  confirmed when the connection was made and re-discovering it on every token
 *  renewal would add a round trip that can only ever confirm what is stored. */
export const runEnterpriseManagedAuthorization = (
  input: Omit<EnterpriseManagedAuthorizationInput, "resourceAuthorizationServer"> & {
    readonly authorizationServerMetadata: OAuthAuthorizationServerMetadata;
    readonly resourceAuthorizationServer: Omit<
      ResourceAuthorizationServerClient,
      "tokenUrl" | "issuer"
    >;
  },
): Effect.Effect<EnterpriseManagedGrant, EnterpriseManagedAuthorizationError> =>
  Effect.suspend<EnterpriseManagedGrant, EnterpriseManagedAuthorizationError, never>(() => {
    const metadata = input.authorizationServerMetadata;
    if (!supportsIdJagGrantProfile(metadata)) {
      return Effect.fail(
        new EmaGrantProfileUnsupported({
          issuer: metadata.issuer,
          advertised: metadata.authorization_grant_profiles_supported ?? [],
        }),
      );
    }
    return mintEnterpriseManagedAccessToken({
      ...input,
      resourceAuthorizationServer: {
        ...input.resourceAuthorizationServer,
        tokenUrl: metadata.token_endpoint,
        issuer: metadata.issuer,
      },
    });
  });
