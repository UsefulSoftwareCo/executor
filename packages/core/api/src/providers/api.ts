// ---------------------------------------------------------------------------
// Providers HTTP API — the v2 credential-backend discovery surface.
//
// A `CredentialProvider` is where a connection's value actually lives (the
// default store for pasted values, or an external backend like 1Password /
// keychain / workos-vault). `list` enumerates registered provider keys; `items`
// browses a provider's entries so the UI can pick an opaque `ProviderItemId` to
// reference when creating a `{ from: { provider, id } }` connection.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { InternalError, ProviderItemId, ProviderKey } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ProviderParams = { key: ProviderKey };

// ---------------------------------------------------------------------------
// Response schemas — mirrors the SDK's `ProviderEntry`.
// ---------------------------------------------------------------------------

const ProviderEntryResponse = Schema.Struct({
  id: ProviderItemId,
  name: Schema.String,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ProvidersApi = HttpApiGroup.make("providers")
  .add(
    HttpApiEndpoint.get("list", "/providers", {
      success: Schema.Array(ProviderKey),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("items", "/providers/:key/items", {
      params: ProviderParams,
      success: Schema.Array(ProviderEntryResponse),
      error: InternalError,
    }),
  );
