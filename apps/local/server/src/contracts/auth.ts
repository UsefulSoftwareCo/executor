import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
/** Local browser pairing and the private desktop bootstrap protocol. */
import { Schema, type Effect } from "effect";
import { AppId } from "@executor-js/sdk";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** Ephemeral proof of local possession, redacted immediately at ingress. */
export const BootstrapToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
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
export const PairingUnauthorized = ApiError.define({
  tag: "PairingUnauthorized",
  status: 401,
  message: "This request needs the local server's API key or a paired browser session.",
});
export type PairingUnauthorized = typeof PairingUnauthorized.Type;
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
export const SessionHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
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

/** OS credential-store service. Each installation's entry uses its installation ID as the account. */
export const LocalCredentialService = "com.usefulsoftware.executor.v2";
/**
 * A data directory's `installation.json`. It pairs the directory with its OS credential entry,
 * or with `keys.json` when its state is `file`.
 */
export const LocalInstallation = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
  // Binaries released before "file" reject that record as invalid instead of misreading it.
  state: Schema.Literals(["pending", "ready", "external", "file"]),
});
/**
 * Why local key setup refused to start. `credential-unavailable` means the directory needs the OS
 * store and there is none. `credential-denied` means it exists but refused access, was cancelled
 * or is locked; the next start prompts again. `misconfigured` means the environment's key settings
 * (`EXECUTOR_KEY_STORAGE`, supplied keys) cannot apply to this directory and must be changed. In
 * these the data may be intact, so a desktop parent must not offer to reset it. `credential-missing`
 * and `invalid` mean the saved keys or record are gone or damaged.
 */
export const LocalConfigurationReason = Schema.Literals([
  "credential-unavailable",
  "credential-denied",
  "credential-missing",
  "invalid",
  "misconfigured",
  "locked",
  "io",
]);
export type LocalConfigurationReason = typeof LocalConfigurationReason.Type;

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
