import type { IntegrationSlug } from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { OpenApiClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms — v2: the integration catalog is the unit of identity (the v1
// per-scope `source` row is gone). `getIntegration` returns the catalog entry
// (slug/description/kind/canRemove/canRefresh); credentials are owner-scoped
// connections read from the shared `connections` API, not bound per source.
// ---------------------------------------------------------------------------

export const openApiIntegrationAtom = (slug: IntegrationSlug) =>
  OpenApiClient.query("openapi", "getIntegration", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

// The full opaque config (including `authenticationTemplate`), used by the
// configure UX to render existing auth methods and add custom ones.
export const openApiConfigAtom = (slug: IntegrationSlug) =>
  OpenApiClient.query("openapi", "getConfig", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const previewOpenApiSpec = OpenApiClient.mutation("openapi", "previewSpec");

export const addOpenApiSpec = OpenApiClient.mutation("openapi", "addSpec");

export const removeOpenApiSpec = OpenApiClient.mutation("openapi", "removeSpec");

/** Re-fetch (or replace) the integration's spec and rebuild its tools in
 *  place — connections, policies, and the description survive. Pass
 *  `reactivityKeys: integrationWriteKeys` at the call site. */
export const updateOpenApiSpec = OpenApiClient.mutation("openapi", "updateSpec");

// Add / merge custom auth methods onto an integration's `authenticationTemplate`.
export const openapiConfigure = OpenApiClient.mutation("openapi", "configure");

// `getIntegration` is read-only; the atom family lets a caller pass a slug.
export const openApiIntegrationFamily = Atom.family(openApiIntegrationAtom);

// `getConfig` is read-only; the atom family lets a caller pass a slug.
export const openApiConfigFamily = Atom.family(openApiConfigAtom);
