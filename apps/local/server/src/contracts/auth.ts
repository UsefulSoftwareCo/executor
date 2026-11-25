import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
import { Config, Schema, type Effect } from "effect";
import { AppId } from "@executor-js/sdk";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

export const BootstrapToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
export class PairingRejected extends Schema.TaggedError<PairingRejected>()(
  "PairingRejected",
  {},
  {
    httpApiStatus: 401,
    description:
      "This connection link has expired or was already used. Open a new link from Executor desktop or the CLI.",
  },
) {}
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
export type AuthForbidden = typeof AuthForbidden.Type;
export const PairingUnauthorized = ApiError.define({
  tag: "PairingUnauthorized",
  status: 401,
  message: "This request needs the local server's API key or a paired browser session.",
});
export type PairingUnauthorized = typeof PairingUnauthorized.Type;
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
export type AuthStorageError = typeof AuthStorageError.Type;
export const SessionHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand("SessionHash"),
);
export type SessionHash = typeof SessionHash.Type;
export const AppSessionTarget = Schema.Struct({ app: AppId, origin: Schema.String });
export type AppSessionTarget = typeof AppSessionTarget.Type;
export const SessionAccess = Schema.Union([
  Schema.Literal("dashboard"),
  Schema.Struct({ ...AppSessionTarget.fields, parent: SessionHash }),
]);
export type SessionAccess = typeof SessionAccess.Type;
export const StoredBrowserSession = Schema.Struct({
  hash: SessionHash,
  expiresAt: Schema.Date,
  access: SessionAccess,
});
export type StoredBrowserSession = typeof StoredBrowserSession.Type;
export interface BrowserSessions {
  readonly put: (session: StoredBrowserSession, now: Date) => Effect.Effect<void, AuthStorageError>;
  readonly get: (hash: SessionHash) => Effect.Effect<StoredBrowserSession | null, AuthStorageError>;
  readonly revoke: (hash: SessionHash) => Effect.Effect<void, AuthStorageError>;
}
export const BrowserSession = Schema.Struct({ authenticated: Schema.Boolean });
export const PairingLink = Schema.Struct({
  url: Schema.RedactedFromValue(Schema.String),
  expiresAt: Schema.Date,
});

export const LocalCredentialService = "com.usefulsoftware.executor.v2";
export const LocalInstallation = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
  state: Schema.Literals(["pending", "ready", "external", "file"]),
});
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

export class LocalConfigurationError extends Schema.TaggedError<LocalConfigurationError>()(
  "LocalConfigurationError",
  {
    reason: LocalConfigurationReason,
    message: Schema.String,
  },
) {}

export const KeyStorage = Schema.Literals(["os", "file"]);
export type KeyStorage = typeof KeyStorage.Type;
export const keyStorageConfig = Config.schema(KeyStorage, "EXECUTOR_KEY_STORAGE").pipe(
  Config.option,
);
export const keyStorageInvalid =
  'EXECUTOR_KEY_STORAGE must be "file" (keep keys in keys.json) or "os" (OS credential store only), or unset. Nothing was changed.';

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
