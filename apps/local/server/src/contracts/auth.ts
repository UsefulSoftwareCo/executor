import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Local browser pairing and the private desktop bootstrap protocol. */
import { Schema, type Effect } from "effect";
import { AppId } from "@executor-js/sdk";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

/** Ephemeral proof of local possession, redacted immediately at ingress. */
export const BootstrapToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
);
/** An exchange requires a valid, unused bootstrap credential. */
export class PairingRejected extends Schema.TaggedError<PairingRejected>()(
  "PairingRejected",
  {},
  {
    httpApiStatus: 401,
    description:
      "This connection link has expired or was already used. Open a new link from Executor desktop or the CLI.",
  },
) {}
/** Browser requests must come from this server's exact loopback origin. */
export const AuthForbidden = UserFacingError.define({
  tag: "AuthForbidden",
  status: 403,
  title: "Local request not allowed",
  description: "This browser request did not come from the expected local Executor address.",
  recovery: {
    action: "Open Executor at its local address directly in your browser and try again.",
    instructions:
      "Check the local Executor origin and open its supported address directly. Correct a stale or unsupported browser origin. Preserve host and origin validation; keep connection-link credentials private.",
  },
});
/** Parsed AuthForbidden failure. */
export type AuthForbidden = typeof AuthForbidden.Type;
/** Programmatic pairing requires the local API key. Browser pairing uses a verified session. */
export class PairingUnauthorized extends Schema.TaggedError<PairingUnauthorized>()(
  "PairingUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}
/** Session persistence failed; never treat an unavailable store as a signed-out browser. */
export const AuthStorageError = UserFacingError.define({
  tag: "AuthStorageError",
  status: 503,
  title: "Executor access storage unavailable",
  description: "Executor could not read or save the access information needed for this action.",
  recovery: {
    action:
      "Try again. If this continues, copy the fix prompt into your agent to check Executor’s access storage.",
    instructions:
      "Inspect the local Executor instance’s access-record storage and safe diagnostics. Restore storage access without deleting grants, resetting credentials, or weakening authorization.",
  },
  retryable: true,
});
/** Parsed AuthStorageError failure. */
export type AuthStorageError = typeof AuthStorageError.Type;
/** SHA-256 digest of an opaque browser credential, never the credential itself. */
export const SessionHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("SessionHash"),
);
export type SessionHash = typeof SessionHash.Type;
/** The exact app and browser origin an app session may access. */
export const AppSessionTarget = Schema.Struct({ app: AppId, origin: Schema.String });
export type AppSessionTarget = typeof AppSessionTarget.Type;
/** App access requires a parent dashboard session; it cannot grant dashboard access. */
export const SessionAccess = Schema.Union([
  Schema.Literal("dashboard"),
  Schema.Struct({ ...AppSessionTarget.fields, parent: SessionHash }),
]);
export type SessionAccess = typeof SessionAccess.Type;
/** Product-owned session record. Raw cookie values are never stored. */
export const StoredBrowserSession = Schema.Struct({
  hash: SessionHash,
  expiresAt: Schema.Date,
  access: SessionAccess,
});
export type StoredBrowserSession = typeof StoredBrowserSession.Type;
/** Persistent session operations; the local product owns their storage and lifetime. */
export interface BrowserSessions {
  readonly put: (session: StoredBrowserSession, now: Date) => Effect.Effect<void, AuthStorageError>;
  readonly get: (hash: SessionHash) => Effect.Effect<StoredBrowserSession | null, AuthStorageError>;
  readonly revoke: (hash: SessionHash) => Effect.Effect<void, AuthStorageError>;
}
/** Authentication state exposes no session or bootstrap credential. */
export const BrowserSession = Schema.Struct({ authenticated: Schema.Boolean });
/** Explicitly requested one-use link returned to a trusted CLI or an authenticated dashboard. */
export const PairingLink = Schema.Struct({
  url: Schema.RedactedFromValue(Schema.String),
  expiresAt: Schema.Date,
});
/** Private pipe payload sent by a desktop parent, never command-line arguments or environment. */
export const DesktopBootstrap = Schema.Struct({
  version: Schema.Literal(1),
  token: BootstrapToken,
});
export type DesktopBootstrap = typeof DesktopBootstrap.Type;
/** Parent/CLI ready notification contains no credential. */
export const ServerReady = Schema.Struct({ version: Schema.Literal(1), url: Schema.String });

/** Shared contracts used by the local browser, CLI, and future desktop parent. */
export const LocalAuthApi = HttpApi.make("local-auth").add(
  HttpApiGroup.make("auth")
    .add(
      HttpApiEndpoint.get("session", "/auth/session", {
        success: BrowserSession,
        error: [AuthForbidden, AuthStorageError],
      }),
    )
    .add(
      HttpApiEndpoint.post("exchange", "/auth/exchange", {
        payload: Schema.Struct({ token: BootstrapToken }),
        success: BrowserSession,
        error: [PairingRejected, AuthForbidden, AuthStorageError],
      }),
    )
    .add(
      HttpApiEndpoint.delete("logout", "/auth/session", {
        success: BrowserSession,
        error: [AuthForbidden, AuthStorageError],
      }),
    )
    .add(
      HttpApiEndpoint.post("pair", "/auth/pair", {
        success: PairingLink,
        error: [PairingUnauthorized, AuthForbidden, AuthStorageError],
      }),
    ),
);
