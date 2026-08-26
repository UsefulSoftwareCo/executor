import type { Connection, HealthCheckResult } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Enterprise-managed connections — what a row may offer.
//
// An enterprise-managed connection mirrors organization policy. It holds no
// durable grant of its own: renewal re-runs the ID-JAG chain from the identity
// assertion, and the enterprise identity provider decides every time. Two
// consequences drive everything below.
//
//   1. There is nothing local to delete. A "Remove" that dropped the row would
//      claim the user had revoked access when they had not — the identity
//      provider still authorizes them, and the next connect would hand it
//      straight back. Revocation lives at the provider.
//
//   2. There is no interactive route to re-run. Reconnect exists to re-consent
//      through the browser, and this profile has no consent step; the console
//      also holds no identity assertion to present. Offering it would produce
//      a failure the user cannot act on.
//
// Connect stays available for ADDITIONAL personal accounts on the same
// integration: enterprise-managed authorization binds exactly one enterprise
// identity, and it does not claim the integration.
// ---------------------------------------------------------------------------

/** Grayscale, a word, no hue — see design.md, "Status and semantics". */
export const MANAGED_CONNECTION_BADGE = "Managed by your organization";

/** Why the row offers no Remove. Shown as helper text, sentence case. */
export const MANAGED_CONNECTION_REVOCATION_HINT =
  "This connection follows your organization's policy. Revoke access at your identity provider, not here.";

/** What an enterprise-managed row shows when the identity provider has since
 *  declined to renew it. The status word for this state — NOT "Expired",
 *  which would invite a reconnect that cannot succeed. */
export const MANAGED_CONNECTION_BLOCKED_LABEL = "Blocked by your organization";

export interface ConnectionRowPolicy {
  /** The connection was minted through enterprise-managed authorization. */
  readonly managed: boolean;
  /** An administrator decision is the CURRENT state of this connection: the
   *  last credential resolution was refused by the identity provider. */
  readonly blockedByAdmin: boolean;
  /** The provider's RFC 6749 §5.2 code, for support traceability. */
  readonly oauthErrorCode: string | null;
  /** Whether the row may offer to delete this connection. */
  readonly canRemove: boolean;
  /** Whether the row may offer to re-run an interactive OAuth flow. */
  readonly canReconnect: boolean;
}

/**
 * What one connection row may offer, from the connection and its freshest
 * health verdict.
 *
 * Both inputs are read STRUCTURALLY: `enterpriseManaged` is projected from the
 * connection's persisted provider state, and `blockedByAdmin` is a typed field
 * on the health result. Neither is inferred from a message, a status word, or
 * the grant of the OAuth app behind the connection — an `id_jag` app still
 * falls back to the interactive flow against a server that does not advertise
 * the profile, and such a connection is ordinary in every way.
 */
export const connectionRowPolicy = (
  connection: Connection,
  health: HealthCheckResult | null | undefined,
): ConnectionRowPolicy => {
  const managed = connection.enterpriseManaged === true;
  const blockedByAdmin = health?.blockedByAdmin === true;
  return {
    managed,
    blockedByAdmin,
    oauthErrorCode: blockedByAdmin ? (health?.oauthErrorCode ?? null) : null,
    canRemove: !managed,
    // A blocked connection is never reconnectable either, managed or not: the
    // interactive flow is exactly the route the enterprise just closed.
    canReconnect: !managed && !blockedByAdmin,
  };
};
