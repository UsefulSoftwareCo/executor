import { Schema } from "effect";

/* Branded identifiers. Schema brands (not plain `Brand.nominal`) so they're
 * usable both as types and as fields inside Schema structs/errors. Construct
 * with `X.make("…")`. */

/** An integration's catalog slug — one API surface (e.g. "vercel", "google"). */
export const IntegrationSlug = Schema.String.pipe(Schema.brand("IntegrationSlug"));
export type IntegrationSlug = typeof IntegrationSlug.Type;

/** Which of an integration's declared auth methods a connection applies through. */
export const AuthTemplateSlug = Schema.String.pipe(Schema.brand("AuthTemplateSlug"));
export type AuthTemplateSlug = typeof AuthTemplateSlug.Type;

/** The sentinel template for integrations that require no credential (e.g. a
 *  public MCP server). Connections on it legitimately bind zero inputs — an
 *  empty `item_ids` map is their canonical persisted shape. */
export const NO_AUTH_TEMPLATE = AuthTemplateSlug.make("none");

/** A connection's name — the `<connection>` segment of an address, scoped under
 *  its integration + owner (so the same name can exist on two integrations). */
export const ConnectionName = Schema.String.pipe(Schema.brand("ConnectionName"));
export type ConnectionName = typeof ConnectionName.Type;

/** A registered OAuth app's slug. */
export const OAuthClientSlug = Schema.String.pipe(Schema.brand("OAuthClientSlug"));
export type OAuthClientSlug = typeof OAuthClientSlug.Type;

/** OAuth flow correlation token, minted by `start`, consumed by `complete`. */
export const OAuthState = Schema.String.pipe(Schema.brand("OAuthState"));
export type OAuthState = typeof OAuthState.Type;

/** A credential backend's key (e.g. "default", "1password", "keychain"). */
export const ProviderKey = Schema.String.pipe(Schema.brand("ProviderKey"));
export type ProviderKey = typeof ProviderKey.Type;

/** A provider's own opaque handle for a stored value. Core never parses it. */
export const ProviderItemId = Schema.String.pipe(Schema.brand("ProviderItemId"));
export type ProviderItemId = typeof ProviderItemId.Type;

/** Handle for one connection: `tools.<integration>.<owner>.<connection>`. */
export const ConnectionAddress = Schema.String.pipe(Schema.brand("ConnectionAddress"));
export type ConnectionAddress = typeof ConnectionAddress.Type;

/** Full callable tool address: `<connectionAddress>.<tool>` =
 *  `tools.<integration>.<owner>.<connection>.<tool>`. */
export const ToolAddress = Schema.String.pipe(Schema.brand("ToolAddress"));
export type ToolAddress = typeof ToolAddress.Type;

/** Final address segment — a tool's own name. */
export const ToolName = Schema.String.pipe(Schema.brand("ToolName"));
export type ToolName = typeof ToolName.Type;

/** Correlation id for a URL elicitation callback. */
export const ElicitationId = Schema.String.pipe(Schema.brand("ElicitationId"));
export type ElicitationId = typeof ElicitationId.Type;

/** A tool-policy rule id. */
export const PolicyId = Schema.String.pipe(Schema.brand("PolicyId"));
export type PolicyId = typeof PolicyId.Type;

/**
 * The isolation partition (the org/workspace). Owns the catalog and namespaces
 * every connection. The executor is bound to one; `owner: "org"` files at this
 * level. Opaque to the SDK.
 */
export const Tenant = Schema.String.pipe(Schema.brand("Tenant"));
export type Tenant = typeof Tenant.Type;

/** The acting member identity. Required for `owner: "user"` writes. Opaque. */
export const Subject = Schema.String.pipe(Schema.brand("Subject"));
export type Subject = typeof Subject.Type;

/**
 * Who owns a connection: the org (tenant-shared, everyone uses it) or the acting
 * user (this subject's own). The `<owner>` segment of an address. Maps onto the
 * executor's tenant/subject binding; the SDK never interprets further.
 */
export const Owner = Schema.Literals(["org", "user"]);
export type Owner = typeof Owner.Type;
