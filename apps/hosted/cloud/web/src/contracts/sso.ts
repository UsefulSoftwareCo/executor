import { revalidated } from "@executor-js/ui/contracts/refresh";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/client";
import {
  dashboardAuthClientOptions,
  hydratedResult,
  requestKey,
} from "@executor-js/ui/contracts/http";
import { authRequest, AuthFailed } from "@executor-js/hosted-web/contracts/auth";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { signInCallback } from "@executor-js/hosted-web/contracts/navigation";
import { acknowledgedQuery, acknowledge } from "@executor-js/ui/contracts/mutations";
import { Atom } from "effect/reactivity";
import { Effect, Redacted, Schema } from "effect";

const client = createAuthClient({
  ...dashboardAuthClientOptions,
  plugins: [ssoClient({ domainVerification: { enabled: true } })],
});

export const SsoConnection = Schema.Struct({
  providerId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
  issuer: Schema.String,
  domain: Schema.String,
  domainVerified: Schema.Boolean,
  type: Schema.Literals(["oidc", "saml"]),
});
export type SsoConnection = typeof SsoConnection.Type;

export const ssoConnectionsAtom = Atom.family((organizationId: string) =>
  acknowledgedQuery(
    BrowserAtoms.atom(
      authRequest((options) => client.sso.providers({}, options)).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ providers: Schema.Array(SsoConnection) })),
        ),
        Effect.map(({ providers }) =>
          providers.filter((row) => row.organizationId === organizationId),
        ),
      ),
    ).pipe(
      hydratedResult({
        key: `cloud:sso-connections:${requestKey({ organizationId })}`,
        success: Schema.Array(SsoConnection),
        error: AuthFailed,
      }),
      revalidated,
    ),
  ),
);

export const startSsoSignIn = (
  input: { readonly redirect: string } & (
    | { readonly email: string }
    | { readonly providerId: string }
  ),
) =>
  authRequest((options) =>
    client.signIn.sso(
      {
        ...("providerId" in input
          ? { providerId: input.providerId }
          : { email: input.email.trim().toLowerCase() }),
        callbackURL: signInCallback(input.redirect),
        errorCallbackURL: `/login/sso?redirect=${encodeURIComponent(input.redirect)}`,
      },
      options,
    ),
  ).pipe(Effect.asVoid);

export const ssoSignInAtom = BrowserAtoms.fn(startSsoSignIn);

export const updateSsoAtom = Atom.family((providerId: string) =>
  BrowserAtoms.fn(
    (
      input: { readonly organizationId: string } & (
        | { readonly clientSecret: Redacted.Redacted<string> }
        | { readonly metadata: string }
      ),
      get,
    ) =>
      authRequest((options) =>
        client.sso.updateProvider(
          {
            providerId,
            ...("clientSecret" in input
              ? { oidcConfig: { clientSecret: Redacted.value(input.clientSecret) } }
              : { samlConfig: { idpMetadata: { metadata: input.metadata } } }),
          },
          options,
        ),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SsoConnection)),
        Effect.tap((saved) =>
          Effect.sync(() =>
            acknowledge(get, ssoConnectionsAtom(input.organizationId), (current) =>
              current.map((row) => (row.providerId === saved.providerId ? saved : row)),
            ),
          ),
        ),
        Effect.asVoid,
      ),
  ),
);

export const deleteSsoAtom = Atom.family((organizationId: string) =>
  BrowserAtoms.fn((providerId: string, get) =>
    authRequest((options) => client.sso.deleteProvider({ providerId }, options)).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, ssoConnectionsAtom(organizationId), (current) =>
            current.filter((row) => row.providerId !== providerId),
          ),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);

type RegisterInput = {
  readonly organizationId: string;
  readonly providerId: string;
  readonly domain: string;
} & (
  | {
      readonly type: "oidc";
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted<string>;
    }
  | { readonly type: "saml"; readonly issuer: string; readonly metadata: string }
);

export const registerSsoAtom = Atom.family((organizationId: string) =>
  BrowserAtoms.fn((input: RegisterInput, get) =>
    Effect.gen(function* () {
      const body = {
        organizationId,
        providerId: input.providerId,
        domain: input.domain,
        issuer: input.issuer,
        ...(input.type === "oidc"
          ? {
              oidcConfig: {
                clientId: input.clientId,
                clientSecret: Redacted.value(input.clientSecret),
                pkce: true,
                scopes: ["openid", "email", "profile"],
              },
            }
          : {
              samlConfig: {
                issuer: input.issuer,
                entryPoint: yield* Effect.sync(() => {
                  const xml = new DOMParser().parseFromString(input.metadata, "application/xml");
                  if (xml.getElementsByTagName("parsererror").length > 0) return null;
                  return Array.from(xml.getElementsByTagNameNS("*", "SingleSignOnService"))
                    .find(
                      (service) =>
                        service.getAttribute("Binding") ===
                        "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                    )
                    ?.getAttribute("Location");
                }).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.NonEmptyString)),
                  Effect.mapError(
                    () =>
                      new AuthFailed({
                        message: "Use federation metadata with an HTTP-Redirect sign-in endpoint.",
                      }),
                  ),
                ),
                idpMetadata: { metadata: input.metadata },
                wantAssertionsSigned: true,
                mapping: {
                  email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
                  name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
                  firstName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
                  lastName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
                },
              },
            }),
      };
      return yield* authRequest((options) => client.sso.register(body, options)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SsoConnection)),
        Effect.tap((saved) =>
          Effect.sync(() =>
            acknowledge(get, ssoConnectionsAtom(organizationId), (current) => [
              ...current.filter((row) => row.providerId !== saved.providerId),
              saved,
            ]),
          ),
        ),
        Effect.asVoid,
      );
    }),
  ),
);

export const ssoDomainTokenAtom = Atom.family((providerId: string) =>
  BrowserAtoms.fn(() =>
    authRequest((options) => client.sso.requestDomainVerification({ providerId }, options)).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ domainVerificationToken: Schema.String })),
      ),
    ),
  ),
);

export const verifySsoDomainAtom = Atom.family((organizationId: string) =>
  BrowserAtoms.fn((providerId: string, get) =>
    authRequest((options) => client.sso.verifyDomain({ providerId }, options)).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, ssoConnectionsAtom(organizationId), (current) =>
            current.map((row) =>
              row.providerId === providerId ? { ...row, domainVerified: true } : row,
            ),
          ),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);
