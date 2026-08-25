// ---------------------------------------------------------------------------
// Identity Assertion JWT Authorization Grant (ID-JAG) support for the OAuth
// test server — a generic protocol-conformance fixture for
// draft-ietf-oauth-identity-assertion-authz-grant-04, not a fake of any named
// product.
//
// The fixture is deliberately STRICTER than any deployed server we know of. A
// lenient fixture is worse than none: it lets a client bug (an unsigned
// assertion, an audience meant for someone else, a `typ` nobody checked) pass
// the suite and fail in production. Every MUST in §4.4.1 is enforced here.
//
// Signing is real RS256 over a per-server RSA keypair, published as an RFC 7517
// JWKS. The Resource Authorization Server half fetches that JWKS from the IdP's
// advertised metadata exactly as a deployed server would, so a forged or
// tampered assertion cannot pass.
// ---------------------------------------------------------------------------

import {
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { Option, Schema } from "effect";

/** draft §3.1 — the media type an ID-JAG MUST carry in its JWT header. */
export const ID_JAG_HEADER_TYP = "oauth-id-jag+jwt";

/** draft §7.2 grant profile identifier. */
export const ID_JAG_GRANT_PROFILE_URN = "urn:ietf:params:oauth:grant-profile:id-jag";

export const ID_JAG_TOKEN_TYPE_URN = "urn:ietf:params:oauth:token-type:id-jag";
export const TOKEN_EXCHANGE_GRANT_TYPE_URN = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_BEARER_GRANT_TYPE_URN = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface IdJagSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export const createIdJagSigningKey = (): IdJagSigningKey => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { keyId: `idjag-${randomUUID()}`, privateKey, publicKey };
};

/** The RFC 7517 JWKS document a fixture IdP publishes at its `jwks_uri`. */
export const jwksDocumentFor = (key: IdJagSigningKey): Readonly<Record<string, unknown>> => ({
  keys: [
    {
      ...(key.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: key.keyId,
      use: "sig",
      alg: "RS256",
    },
  ],
});

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export interface IdJagClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly client_id: string;
  readonly exp: number;
  readonly iat: number;
  readonly jti: string;
  readonly resource?: string;
  readonly scope?: string;
  readonly email?: string;
}

/** Mint a signed ID-JAG. `typ` is a parameter rather than a constant so a test
 *  can prove the Resource Authorization Server rejects a wrongly-typed JWT. */
export const signIdJag = (input: {
  readonly key: IdJagSigningKey;
  readonly claims: IdJagClaims;
  readonly typ?: string;
}): string => {
  const header = base64UrlJson({
    alg: "RS256",
    typ: input.typ ?? ID_JAG_HEADER_TYP,
    kid: input.key.keyId,
  });
  const payload = base64UrlJson(input.claims);
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(input.key.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
};

// ---------------------------------------------------------------------------
// Verification (the Resource Authorization Server half of §4.4.1)
// ---------------------------------------------------------------------------

const JwtHeaderSchema = Schema.Struct({
  alg: Schema.String,
  typ: Schema.optional(Schema.String),
  kid: Schema.optional(Schema.String),
});

const JwtClaimsSchema = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  client_id: Schema.String,
  exp: Schema.Number,
  iat: Schema.Number,
  jti: Schema.String,
  resource: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(JwtHeaderSchema));
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaimsSchema));

/** Only the RSA public parameters this fixture signs with. Decoding the key set
 *  into a precise shape (rather than probing an untyped record) is what lets the
 *  verification below hand `node:crypto` a key it already knows is well formed. */
const RsaPublicJwkSchema = Schema.Struct({
  kty: Schema.Literal("RSA"),
  n: Schema.String,
  e: Schema.String,
  kid: Schema.optional(Schema.String),
});

const JwksSchema = Schema.Struct({ keys: Schema.Array(RsaPublicJwkSchema) });

const decodeJwks = Schema.decodeUnknownOption(JwksSchema);

const segment = (token: string, index: number): string | null => {
  const parts = token.split(".");
  return parts.length === 3 ? (parts[index] ?? null) : null;
};

const decodedSegment = (token: string, index: number): string | null => {
  const raw = segment(token, index);
  if (raw === null) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: an untrusted assertion segment that is not base64url is simply not a JWT
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

export type IdJagVerification =
  | { readonly ok: true; readonly claims: typeof JwtClaimsSchema.Type }
  | { readonly ok: false; readonly detail: string };

const rejected = (detail: string): IdJagVerification => ({ ok: false, detail });

/** Verify an ID-JAG the way draft §4.4.1 requires a Resource Authorization
 *  Server to. Every check below is a MUST in the draft, and each one is exactly
 *  what stops a class of client bug from shipping:
 *
 *    - `typ` guards against a plain ID token being replayed as a grant;
 *    - the signature check against the IdP's published JWKS guards against a
 *      forged or tampered assertion;
 *    - `aud` equal to THIS server's issuer is the confused-deputy defence: an
 *      assertion minted for a different authorization server must not work
 *      here, no matter who presents it;
 *    - `client_id` equal to the authenticated client preserves the OAuth client
 *      binding across the two trust domains;
 *    - `exp` keeps a stale assertion from being an unbounded credential.
 */
export const verifyIdJag = (input: {
  readonly assertion: string;
  readonly trustedIssuer: string;
  readonly jwks: unknown;
  /** This server's own RFC 8414 issuer identifier. */
  readonly audience: string;
  /** The client id the token request authenticated as. */
  readonly authenticatedClientId: string;
  readonly nowSeconds?: number;
}): IdJagVerification => {
  const headerJson = decodedSegment(input.assertion, 0);
  const claimsJson = decodedSegment(input.assertion, 1);
  const signature = segment(input.assertion, 2);
  if (headerJson === null || claimsJson === null || signature === null) {
    return rejected("assertion is not a three-part JWT");
  }
  const header = decodeHeader(headerJson);
  if (Option.isNone(header)) return rejected("assertion header is not a JWT header");
  if (header.value.typ !== ID_JAG_HEADER_TYP) {
    return rejected(`assertion typ must be ${ID_JAG_HEADER_TYP}, got ${String(header.value.typ)}`);
  }
  if (header.value.alg !== "RS256") {
    return rejected(`assertion alg must be RS256, got ${header.value.alg}`);
  }

  const jwks = decodeJwks(input.jwks);
  if (Option.isNone(jwks)) return rejected("the issuer's JWKS could not be read");
  const jwk = jwks.value.keys.find((candidate) => candidate.kid === header.value.kid);
  if (!jwk) return rejected(`no JWKS key matches kid ${String(header.value.kid)}`);

  const signingInput = `${segment(input.assertion, 0)}.${segment(input.assertion, 1)}`;
  const signatureValid = (() => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: an untrusted key or signature encoding must read as "invalid signature", never crash the fixture
    try {
      return createVerify("RSA-SHA256")
        .update(signingInput)
        .verify(
          createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" }),
          Buffer.from(signature, "base64url"),
        );
    } catch {
      return false;
    }
  })();
  if (!signatureValid) return rejected("assertion signature is invalid");

  const claims = decodeClaims(claimsJson);
  if (Option.isNone(claims)) {
    return rejected("assertion is missing one of the required §3.1 claims");
  }
  const payload = claims.value;
  if (payload.iss !== input.trustedIssuer) {
    return rejected(`assertion iss ${payload.iss} is not a trusted identity provider`);
  }
  // §4.4.1: `aud` may be a string or a single-element array, and MUST equal this
  // server's issuer identifier.
  const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
  if (audiences.length !== 1 || audiences[0] !== input.audience) {
    return rejected(
      `assertion aud ${JSON.stringify(payload.aud)} does not name this authorization server (${input.audience})`,
    );
  }
  if (payload.client_id !== input.authenticatedClientId) {
    return rejected(
      `assertion client_id ${payload.client_id} does not match the authenticated client ${input.authenticatedClientId}`,
    );
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return rejected("assertion has expired");

  return { ok: true, claims: payload };
};
