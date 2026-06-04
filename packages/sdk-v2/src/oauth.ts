import type { Connection } from "./connection";
import type {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Owner,
} from "./ids";

/* OAuth is a credential mechanism, not an integration type. A client is a
 * registered app; running its flow mints a Connection. The client is
 * self-contained (carries its own endpoints) and integration-independent, so the
 * same app can back connections on whatever integrations share that provider. */

export type OAuthGrant = "authorization_code" | "client_credentials";

/** Provider OAuth config an integration declares as one of its auth templates —
 *  what to request. (The flow itself runs off the self-contained OAuthClient.) */
export type OAuthAuthentication = {
  readonly slug: AuthTemplateSlug;
  readonly type: "oauth";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
};

/** A registered OAuth app — clientId/secret + its own endpoints/scopes.
 *  Owner-scoped: a shared org app or a user's own BYO app. */
export type OAuthClient = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly grant: OAuthGrant;
  readonly clientId: string;
  readonly clientSecret: string;
};

/** Flow-aware result of `oauth.start` — the status says what's next. */
export type ConnectResult =
  | { readonly status: "connected"; readonly connection: Connection }
  | { readonly status: "redirect"; readonly authorizationUrl: string; readonly state: OAuthState };

export type CreateOAuthClientInput = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly grant: OAuthGrant;
  readonly clientId: string;
  readonly clientSecret: string;
};

/** Start a flow through a client to mint a connection for one integration.
 *  `template` is the integration's oauth template the minted token is applied
 *  through. */
export type OAuthStartInput = {
  readonly client: OAuthClientSlug;
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
};

export type OAuthCompleteInput = {
  readonly state: OAuthState;
  readonly code: string;
};
