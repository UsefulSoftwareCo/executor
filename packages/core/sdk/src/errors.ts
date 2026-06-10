import { Schema } from "effect";

import { ElicitationDeclinedError } from "./elicitation";
import type { StorageFailure } from "./fuma-runtime";
import { ConnectionName, IntegrationSlug, Owner, ProviderKey, ToolAddress } from "./ids";

/* The failure set the SDK surfaces. `execute`'s invoke failures are ported from
 * v1 but re-keyed by `address` (the full `tools.<integration>.<owner>.<connection>.<tool>`
 * handle) instead of an opaque tool id. Storage failures reuse fuma-runtime's
 * `StorageError`/`UniqueViolationError` (`StorageFailure`) — not redefined here. */

// ---------------------------------------------------------------------------
// Tool lifecycle
// ---------------------------------------------------------------------------

export class ToolNotFoundError extends Schema.TaggedErrorClass<ToolNotFoundError>()(
  "ToolNotFoundError",
  {
    address: ToolAddress,
    suggestions: Schema.optional(Schema.Array(ToolAddress)),
  },
) {}

export class ToolInvocationError extends Schema.TaggedErrorClass<ToolInvocationError>()(
  "ToolInvocationError",
  {
    address: ToolAddress,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** Tool invocation was rejected because a workspace `tool_policy` rule with
 *  `action: "block"` matched. `pattern` is the matched policy pattern. */
export class ToolBlockedError extends Schema.TaggedErrorClass<ToolBlockedError>()(
  "ToolBlockedError",
  {
    address: ToolAddress,
    pattern: Schema.String,
  },
) {}

/** Tool row exists but its owning plugin isn't loaded in this executor config. */
export class PluginNotLoadedError extends Schema.TaggedErrorClass<PluginNotLoadedError>()(
  "PluginNotLoadedError",
  {
    address: ToolAddress,
    pluginId: Schema.String,
  },
) {}

/** Tool was found but its owning plugin has no `invokeTool` handler. */
export class NoHandlerError extends Schema.TaggedErrorClass<NoHandlerError>()("NoHandlerError", {
  address: ToolAddress,
  pluginId: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Integration / connection lifecycle
// ---------------------------------------------------------------------------

export class IntegrationNotFoundError extends Schema.TaggedErrorClass<IntegrationNotFoundError>()(
  "IntegrationNotFoundError",
  { slug: IntegrationSlug },
) {}

/** An "add integration" operation targeted a slug (namespace) that is already
 *  registered. The core `integrations.register` primitive upserts by design
 *  (for idempotent boot re-registration); add-operation layers gate on this to
 *  prevent silently clobbering an existing integration's tools, connections,
 *  and policies. */
export class IntegrationAlreadyExistsError extends Schema.TaggedErrorClass<IntegrationAlreadyExistsError>()(
  "IntegrationAlreadyExistsError",
  { slug: IntegrationSlug },
  { httpApiStatus: 409 },
) {}

/** `integrations.remove` was called on an integration declared statically by a
 *  plugin at startup (`canRemove: false`). */
export class IntegrationRemovalNotAllowedError extends Schema.TaggedErrorClass<IntegrationRemovalNotAllowedError>()(
  "IntegrationRemovalNotAllowedError",
  { slug: IntegrationSlug },
) {}

export class ConnectionNotFoundError extends Schema.TaggedErrorClass<ConnectionNotFoundError>()(
  "ConnectionNotFoundError",
  {
    owner: Owner,
    integration: IntegrationSlug,
    name: ConnectionName,
  },
) {}

/** A connection create request was rejected before anything was written: the
 *  input is structurally invalid (no credential inputs for a credentialed
 *  template, mixed pasted/external origins, …) or targets owner `user` in a
 *  context that has no user subject. The message says which — it is safe to
 *  show to the caller. */
export class InvalidConnectionInputError extends Schema.TaggedErrorClass<InvalidConnectionInputError>()(
  "InvalidConnectionInputError",
  { message: Schema.String },
) {}

/** A connection references a credential provider key that isn't registered on
 *  the executor. */
export class CredentialProviderNotRegisteredError extends Schema.TaggedErrorClass<CredentialProviderNotRegisteredError>()(
  "CredentialProviderNotRegisteredError",
  { provider: ProviderKey },
) {}

/** A connection's value could not be resolved — the provider returned nothing,
 *  or an OAuth token refresh failed and the user must re-auth. */
export class CredentialResolutionError extends Schema.TaggedErrorClass<CredentialResolutionError>()(
  "CredentialResolutionError",
  {
    owner: Owner,
    integration: IntegrationSlug,
    name: ConnectionName,
    message: Schema.String,
    /** True when the stored grant is permanently invalid and the user must
     *  sign in again (RFC 6749 §5.2 invalid_grant and friends). */
    reauthRequired: Schema.optional(Schema.Boolean),
  },
) {}

// ---------------------------------------------------------------------------
// Union — the failure channel of `execute`.
// ---------------------------------------------------------------------------

export type ExecuteError =
  | ToolNotFoundError
  | ToolInvocationError
  | ToolBlockedError
  | PluginNotLoadedError
  | NoHandlerError
  | ConnectionNotFoundError
  | CredentialProviderNotRegisteredError
  | CredentialResolutionError
  | ElicitationDeclinedError
  | StorageFailure;

/** Convenience union spanning every typed error the SDK raises. */
export type ExecutorError =
  | ExecuteError
  | IntegrationNotFoundError
  | IntegrationRemovalNotAllowedError;
