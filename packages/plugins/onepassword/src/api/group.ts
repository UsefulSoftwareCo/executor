import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError } from "@executor-js/sdk/shared";

import { OnePasswordError } from "../sdk/errors";
import {
  OnePasswordConfig,
  RedactedOnePasswordConfig,
  Vault,
  ConnectionStatus,
} from "../sdk/types";

// ---------------------------------------------------------------------------
// Payloads
//
// v2: config is a single per-owner binding the extension derives from the
// executor's owner binding — there are no scope segments in the path. The
// configure payload carries the full config (including the service-account
// token); reads return the redacted projection so the token never leaves the
// plugin.
// ---------------------------------------------------------------------------

const ConfigurePayload = OnePasswordConfig;

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

const GetConfigResponse = Schema.NullOr(RedactedOnePasswordConfig);

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (OnePasswordError) are declared once per endpoint via the
// `error` field — the error carries its own 502 status via `HttpApiSchema`
// annotations in errors.ts.
//
// `InternalError` is the shared opaque 500 schema translated at the HTTP edge
// by `withCapture`. Storage failures on `ctx.storage` flow through as
// `StorageFailure` in the typed channel and are captured + downgraded to
// `InternalError({ traceId })` at Layer composition.
// ---------------------------------------------------------------------------

export const OnePasswordGroup = HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.get("getConfig", "/onepassword/config", {
      success: GetConfigResponse,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.put("configure", "/onepassword/config", {
      payload: ConfigurePayload,
      success: Schema.Void,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeConfig", "/onepassword/config", {
      success: Schema.Void,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/onepassword/status", {
      success: ConnectionStatus,
      error: [InternalError, OnePasswordError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listVaults", "/onepassword/vaults", {
      query: ListVaultsParams,
      success: ListVaultsResponse,
      error: [InternalError, OnePasswordError],
    }),
  );
