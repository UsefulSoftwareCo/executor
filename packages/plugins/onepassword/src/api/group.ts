import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ScopeId } from "@executor-js/sdk/core";
import { InternalError } from "@executor-js/api";

import { OnePasswordError } from "../sdk/errors";
import { OnePasswordConfig, OnePasswordConfigSchema, Vault, ConnectionStatus } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const ConfigurePayload = OnePasswordConfigSchema;

const ListVaultsParams = Schema.Struct({
  authKind: Schema.Literals(["desktop-app", "service-account"]),
  account: Schema.String,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const ListVaultsResponse = Schema.Struct({
  vaults: Schema.Array(Vault),
});

const GetConfigResponse = Schema.NullOr(OnePasswordConfig);

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (OnePasswordError) are declared once at the group level
// via `.addError(...)` — every endpoint inherits. The error carries its own
// 502 status via `HttpApiSchema.annotations` in errors.ts.
//
// `InternalError` is the shared opaque 500 schema translated at the HTTP
// edge by `withCapture` (see observability.ts). Storage failures on
// `ctx.storage`/`ctx.secrets` flow through as `StorageFailure` in the
// typed channel and are captured + downgraded to `InternalError({ traceId })`
// at Layer composition. No per-handler translation.
// ---------------------------------------------------------------------------

export const OnePasswordGroup = HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.get("getConfig", "/scopes/:scopeId/onepassword/config", {
      params: ScopeParams,
      success: GetConfigResponse,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.put("configure", "/scopes/:scopeId/onepassword/config", {
      params: ScopeParams,
      payload: ConfigurePayload,
      success: Schema.Void,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeConfig", "/scopes/:scopeId/onepassword/config", {
      params: ScopeParams,
      success: Schema.Void,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/scopes/:scopeId/onepassword/status", {
      params: ScopeParams,
      success: ConnectionStatus,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listVaults", "/scopes/:scopeId/onepassword/vaults", {
      params: ScopeParams,
      query: ListVaultsParams,
      success: ListVaultsResponse,
      error: [InternalError, OnePasswordError],
    }),
  );
