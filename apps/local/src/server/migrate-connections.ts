// ---------------------------------------------------------------------------
// OAuth legacy → Connection backfill (local)
// ---------------------------------------------------------------------------
//
// Explicit one-shot helper for rows still on the pre-refactor inline-OAuth
// shape (openapi_source, mcp_source, google_discovery_source). It mints a
// Connection row, re-parents the referenced secret(s), and rewrites the
// source's stored auth to the new pointer shape. Normal runtime startup must
// not call this helper; runtime code assumes Drizzle migrations have already
// produced the final model.
//
// Self-contained: the only plugin imports are current-shape parsing
// helpers. Each legacy shape is defined inline — this file is the last
// place in the codebase that still needs to know about them.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { Effect, Option, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  parse as parseOpenApi,
  resolveSpecText,
  OAuth2SourceConfig,
} from "@executor-js/plugin-openapi";
import { McpConnectionAuth } from "@executor-js/plugin-mcp";
import { discoverAuthorizationServerMetadata, OAUTH2_PROVIDER_KEY } from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === "string") : [];

const originOrNull = (value: string | null): string | null => {
  if (!value || !URL.canParse(value)) return null;
  return new URL(value).origin;
};

const slotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

const openApiOauth2ClientIdSlot = (securitySchemeName: string): string =>
  `oauth2:${slotPart(securitySchemeName)}:client-id`;
const openApiOauth2ClientSecretSlot = (securitySchemeName: string): string =>
  `oauth2:${slotPart(securitySchemeName)}:client-secret`;
const openApiOauth2ConnectionSlot = (securitySchemeName: string): string =>
  `oauth2:${slotPart(securitySchemeName)}:connection`;

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObject);

const decodeUnknownOptionAs = <A>(schema: Schema.Decoder<A>) => {
  // oxlint-disable-next-line executor/no-inline-schema-compile -- schema bound by parameter; compiler hoisted into closure
  const decode = Schema.decodeUnknownOption(schema);
  return (input: unknown): Option.Option<A> => decode(input);
};

const decodeJsonObjectString = Schema.decodeUnknownOption(JsonObjectFromString);

const failUnmigratableConnection = (message: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: one-shot Promise migration must abort when legacy OAuth cannot be represented
  throw new Error(message);
};

/** Pre-flight: bail unless the drizzle migration that added the Connection
 *  table + `secret.owned_by_connection_id` has completed. */
const connectionsReady = (sqlite: Database): boolean => {
  const secretColumns = sqlite.prepare("PRAGMA table_info('secret')").all() as ReadonlyArray<{
    readonly name: string;
  }>;
  if (!secretColumns.some((c) => c.name === "owned_by_connection_id")) return false;
  const connectionTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connection'")
    .get();
  return connectionTable !== null && connectionTable !== undefined;
};

const tableExists = (sqlite: Database, name: string): boolean => {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== null && row !== undefined;
};

const columnExists = (sqlite: Database, table: string, column: string): boolean => {
  const columns = sqlite
    .prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`)
    .all() as ReadonlyArray<{ readonly name: string }>;
  return columns.some((c) => c.name === column);
};

type SecretRow = { id: string; owned_by_connection_id: string | null };

/** Shared: re-parent the pointed-to secret ids to the new connection,
 *  backfilling any missing routing rows. Returns `null` on success, an
 *  error message string on skip. */
const rewireSecrets = (
  sqlite: Database,
  scopeId: string,
  connectionId: string,
  secretIds: ReadonlyArray<string>,
  namesByIndex: ReadonlyArray<string>,
): string | null => {
  const selectSecret = sqlite.prepare(
    "SELECT id, owned_by_connection_id FROM secret WHERE scope_id = ? AND id = ?",
  );
  const selectAnySecretProvider = sqlite.prepare(
    "SELECT provider FROM secret WHERE scope_id = ? LIMIT 1",
  );
  const updateSecretOwner = sqlite.prepare(
    "UPDATE secret SET owned_by_connection_id = ? WHERE scope_id = ? AND id = ?",
  );
  const insertSecret = sqlite.prepare(
    `INSERT INTO secret (
       id, scope_id, provider, name,
       owned_by_connection_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const rows = secretIds.map((sid) => selectSecret.get(scopeId, sid) as SecretRow | undefined);
  const alreadyOwned = rows
    .filter((r): r is SecretRow => !!r)
    .filter((r) => r.owned_by_connection_id !== null && r.owned_by_connection_id !== connectionId);
  if (alreadyOwned.length > 0) return "secret(s) already owned";

  // Early-onboarded rows never got a `secret` routing row — pre-refactor
  // `secretsGet` resolved them via provider enumeration. Pick the
  // provider already in use at this scope (or fall back to keychain) so
  // the new id-indexed fast path resolves. If we guess wrong the SDK's
  // enumerate-fallback still works.
  const missingCount = rows.filter((r) => r === undefined).length;
  let fallbackProvider: string | null = null;
  if (missingCount > 0) {
    const existing = selectAnySecretProvider.get(scopeId) as { provider: string } | undefined;
    fallbackProvider = existing?.provider ?? "keychain";
  }

  const now = Date.now();
  for (let i = 0; i < secretIds.length; i++) {
    const sid = secretIds[i]!;
    if (rows[i] === undefined) {
      insertSecret.run(sid, scopeId, fallbackProvider!, namesByIndex[i]!, connectionId, now);
    } else {
      updateSecretOwner.run(connectionId, scopeId, sid);
    }
  }
  return null;
};

const insertConnectionRow = (
  sqlite: Database,
  params: {
    id: string;
    scopeId: string;
    provider: string;
    identityLabel: string;
    accessTokenSecretId: string;
    refreshTokenSecretId: string | null;
    expiresAt: number | null;
    scope: string | null;
    providerState: unknown;
  },
): void => {
  const hasKind = columnExists(sqlite, "connection", "kind");
  const stmt = hasKind
    ? sqlite.prepare(
        `INSERT INTO connection (
           id, scope_id, provider, kind, identity_label,
           access_token_secret_id, refresh_token_secret_id,
           expires_at, scope, provider_state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
    : sqlite.prepare(
        `INSERT INTO connection (
           id, scope_id, provider, identity_label,
           access_token_secret_id, refresh_token_secret_id,
           expires_at, scope, provider_state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
  const now = Date.now();
  const values = [
    params.id,
    params.scopeId,
    params.provider,
    ...(hasKind ? ["user"] : []),
    params.identityLabel,
    params.accessTokenSecretId,
    params.refreshTokenSecretId,
    params.expiresAt,
    params.scope,
    JSON.stringify(params.providerState),
    now,
    now,
  ];
  stmt.run(...values);
};

const insertCredentialBinding = (
  sqlite: Database,
  params: {
    pluginId: string;
    scopeId: string;
    sourceId: string;
    slotKey: string;
    kind: "secret" | "connection";
    secretId?: string;
    connectionId?: string;
  },
): void => {
  if (!tableExists(sqlite, "credential_binding")) return;
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO credential_binding (
         id, scope_id, plugin_id, source_id, source_scope_id, slot_key,
         kind, text_value, secret_id, connection_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      JSON.stringify([params.pluginId, params.scopeId, params.sourceId, params.slotKey]),
      params.scopeId,
      params.pluginId,
      params.sourceId,
      params.scopeId,
      params.slotKey,
      params.kind,
      params.secretId ?? null,
      params.connectionId ?? null,
      now,
      now,
    );
};

const insertOpenApiCredentialBinding = (
  sqlite: Database,
  params: Omit<Parameters<typeof insertCredentialBinding>[1], "pluginId">,
): void => insertCredentialBinding(sqlite, { pluginId: "openapi", ...params });

// ---------------------------------------------------------------------------
// OpenAPI — legacy shape
// ---------------------------------------------------------------------------

const OAuth2Flow = Schema.Literals(["authorizationCode", "clientCredentials"]);

class LegacyOpenApiOAuth2 extends Schema.Class<LegacyOpenApiOAuth2>("LegacyOpenApiOAuth2")({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
}) {}

const decodeOpenApiCurrent = Schema.decodeUnknownOption(OAuth2SourceConfig);
const decodeOpenApiLegacy = decodeUnknownOptionAs<LegacyOpenApiOAuth2>(LegacyOpenApiOAuth2);

const extractAuthorizationUrl = async (
  rawSpec: string,
  securitySchemeName: string,
  flow: "authorizationCode" | "clientCredentials",
): Promise<string | null> => {
  if (flow === "clientCredentials") return null;
  const parsed = await Effect.runPromise(
    resolveSpecText(rawSpec).pipe(
      Effect.flatMap((text) => parseOpenApi(text)),
      Effect.provide(FetchHttpClient.layer),
      Effect.result,
    ),
  );
  if (Result.isFailure(parsed)) return null;
  const spec = parsed.success as unknown;
  if (!isRecord(spec)) return null;
  const components = isRecord(spec.components) ? spec.components : null;
  const schemes =
    components && isRecord(components.securitySchemes) ? components.securitySchemes : null;
  const scheme =
    schemes && isRecord(schemes[securitySchemeName])
      ? (schemes[securitySchemeName] as Record<string, unknown>)
      : null;
  const flows = scheme && isRecord(scheme.flows) ? scheme.flows : null;
  const flowObj =
    flows && isRecord(flows.authorizationCode)
      ? (flows.authorizationCode as Record<string, unknown>)
      : null;
  return flowObj && isString(flowObj.authorizationUrl) ? flowObj.authorizationUrl : null;
};

type OpenApiRow = {
  scope_id: string;
  id: string;
  name: string;
  spec: string;
  invocation_config: string | null;
  oauth2: string | null;
};

const migrateOpenApi = async (sqlite: Database): Promise<void> => {
  if (!tableExists(sqlite, "openapi_source")) return;
  // After the plugin normalization migration, `invocation_config` is
  // gone (specFetchCredentials moved to child tables). The `oauth2`
  // column stays JSON — that's the canonical source for the OAuth
  // pointer. Pre-migration, both columns mirror each other; post-
  // migration, only `oauth2` is left. We read both when available and
  // fall back to `oauth2` so legacy data isn't silently skipped.
  const hasInvocationConfig = columnExists(sqlite, "openapi_source", "invocation_config");
  const selectCols = hasInvocationConfig
    ? "scope_id, id, name, spec, invocation_config, oauth2"
    : "scope_id, id, name, spec, NULL AS invocation_config, oauth2";
  const rows = sqlite
    .prepare(`SELECT ${selectCols} FROM openapi_source`)
    .all() as ReadonlyArray<OpenApiRow>;
  if (rows.length === 0) return;

  const updateSource = hasInvocationConfig
    ? sqlite.prepare(
        "UPDATE openapi_source SET oauth2 = ?, invocation_config = ? WHERE scope_id = ? AND id = ?",
      )
    : sqlite.prepare("UPDATE openapi_source SET oauth2 = ? WHERE scope_id = ? AND id = ?");

  for (const row of rows) {
    let invocation: Record<string, unknown> = {};
    if (row.invocation_config) {
      const parsed = decodeJsonObjectString(row.invocation_config);
      if (Option.isNone(parsed)) continue;
      invocation = parsed.value;
    }
    let oauth2Col: unknown = null;
    if (row.oauth2) {
      const parsed = decodeJsonObjectString(row.oauth2);
      if (Option.isSome(parsed)) oauth2Col = parsed.value;
    }
    const primary = invocation.oauth2 ?? oauth2Col;
    if (primary == null) continue;
    if (Option.isSome(decodeOpenApiCurrent(primary))) continue;

    const legacyOption = decodeOpenApiLegacy(primary);
    if (Option.isNone(legacyOption)) continue;
    const legacy = legacyOption.value;

    const authorizationUrl = await extractAuthorizationUrl(
      row.spec,
      legacy.securitySchemeName,
      legacy.flow,
    );
    if (legacy.flow === "authorizationCode" && authorizationUrl === null) {
      failUnmigratableConnection(
        `[migrate-connections] openapi ${row.scope_id}/${row.id}: authorizationCode flow but authorizationUrl unavailable`,
      );
    }
    if (legacy.flow === "clientCredentials" && legacy.clientSecretSecretId === null) {
      failUnmigratableConnection(
        `[migrate-connections] openapi ${row.scope_id}/${row.id}: clientCredentials flow without client secret`,
      );
    }

    const connectionId = `openapi-oauth2-${randomUUID()}`;
    const providerState =
      legacy.flow === "authorizationCode"
        ? {
            kind: "authorization-code" as const,
            tokenEndpoint: legacy.tokenUrl,
            issuerUrl: originOrNull(authorizationUrl),
            clientIdSecretId: legacy.clientIdSecretId,
            clientSecretSecretId: legacy.clientSecretSecretId,
            clientAuth: "body" as const,
            scopes: legacy.scopes,
            scope: legacy.scope,
          }
        : {
            kind: "client-credentials" as const,
            tokenEndpoint: legacy.tokenUrl,
            clientIdSecretId: legacy.clientIdSecretId,
            clientSecretSecretId: legacy.clientSecretSecretId,
            scopes: legacy.scopes,
            clientAuth: "body" as const,
            scope: legacy.scope,
          };
    const clientIdSlot = openApiOauth2ClientIdSlot(legacy.securitySchemeName);
    const clientSecretSlot =
      legacy.clientSecretSecretId === null
        ? null
        : openApiOauth2ClientSecretSlot(legacy.securitySchemeName);
    const connectionSlot = openApiOauth2ConnectionSlot(legacy.securitySchemeName);
    const oauth2Pointer = {
      kind: "oauth2" as const,
      securitySchemeName: legacy.securitySchemeName,
      flow: legacy.flow,
      tokenUrl: legacy.tokenUrl,
      authorizationUrl,
      clientIdSlot,
      clientSecretSlot,
      connectionSlot,
      scopes: legacy.scopes,
    };

    const secretIds = [legacy.accessTokenSecretId];
    const secretNames = [`Connection ${connectionId} access token`];
    if (legacy.refreshTokenSecretId) {
      secretIds.push(legacy.refreshTokenSecretId);
      secretNames.push(`Connection ${connectionId} refresh token`);
    }

    const txn = sqlite.transaction(() => {
      insertConnectionRow(sqlite, {
        id: connectionId,
        scopeId: row.scope_id,
        provider: OAUTH2_PROVIDER_KEY,
        identityLabel: row.name,
        accessTokenSecretId: legacy.accessTokenSecretId,
        refreshTokenSecretId: legacy.refreshTokenSecretId,
        expiresAt: legacy.expiresAt,
        scope: legacy.scope,
        providerState,
      });
      const err = rewireSecrets(sqlite, row.scope_id, connectionId, secretIds, secretNames);
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: bun:sqlite transaction callback must throw to roll back
      if (err) throw new Error(err);
      insertOpenApiCredentialBinding(sqlite, {
        scopeId: row.scope_id,
        sourceId: row.id,
        slotKey: clientIdSlot,
        kind: "secret",
        secretId: legacy.clientIdSecretId,
      });
      if (legacy.clientSecretSecretId !== null && clientSecretSlot !== null) {
        insertOpenApiCredentialBinding(sqlite, {
          scopeId: row.scope_id,
          sourceId: row.id,
          slotKey: clientSecretSlot,
          kind: "secret",
          secretId: legacy.clientSecretSecretId,
        });
      }
      insertOpenApiCredentialBinding(sqlite, {
        scopeId: row.scope_id,
        sourceId: row.id,
        slotKey: connectionSlot,
        kind: "connection",
        connectionId,
      });
      if (hasInvocationConfig) {
        const nextInvocation = { ...invocation, oauth2: oauth2Pointer };
        updateSource.run(
          JSON.stringify(oauth2Pointer),
          JSON.stringify(nextInvocation),
          row.scope_id,
          row.id,
        );
      } else {
        updateSource.run(JSON.stringify(oauth2Pointer), row.scope_id, row.id);
      }
    });
    txn();
    console.log(`[migrate-connections] openapi ${row.scope_id}/${row.id} -> ${connectionId}`);
  }
};

// ---------------------------------------------------------------------------
// MCP — legacy shape
// ---------------------------------------------------------------------------

const LegacyMcpOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String.pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed("Bearer")),
  ),
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  clientInformation: Schema.NullOr(JsonObject).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  tokenEndpoint: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  authorizationServerUrl: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  authorizationServerMetadata: Schema.NullOr(JsonObject).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  resourceMetadataUrl: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
});

const decodeMcpCurrent = Schema.decodeUnknownOption(McpConnectionAuth);
type LegacyMcpOAuth2Type = typeof LegacyMcpOAuth2.Type;
const decodeMcpLegacy = decodeUnknownOptionAs<LegacyMcpOAuth2Type>(LegacyMcpOAuth2);

const resolveMcpTokenEndpoint = async (legacy: LegacyMcpOAuth2Type): Promise<string | null> => {
  if (legacy.tokenEndpoint) return legacy.tokenEndpoint;
  const metadata = legacy.authorizationServerMetadata;
  if (metadata && isString(metadata.token_endpoint)) return metadata.token_endpoint;
  if (!legacy.authorizationServerUrl) return null;
  const discovered = await Effect.runPromise(
    discoverAuthorizationServerMetadata(legacy.authorizationServerUrl).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.result,
    ),
  );
  if (Result.isFailure(discovered)) return null;
  return discovered.success?.metadata.token_endpoint ?? null;
};

type McpRow = {
  scope_id: string;
  id: string;
  name: string;
  config: string;
};

const migrateMcp = async (sqlite: Database): Promise<void> => {
  if (!tableExists(sqlite, "mcp_source")) return;
  const rows = sqlite
    .prepare("SELECT scope_id, id, name, config FROM mcp_source")
    .all() as ReadonlyArray<McpRow>;
  if (rows.length === 0) return;

  // Drizzle migrations normalize current MCP auth first, then this
  // one-shot backfill handles older inline OAuth rows that still have
  // accessTokenSecretId in config.auth. The final model is auth slots
  // on mcp_source plus a core credential_binding row for the connection.
  const hasAuthSlotColumns = columnExists(sqlite, "mcp_source", "auth_connection_slot");
  const updateConfig = sqlite.prepare(
    "UPDATE mcp_source SET config = ? WHERE scope_id = ? AND id = ?",
  );
  const updateConfigAndAuth = hasAuthSlotColumns
    ? sqlite.prepare(
        "UPDATE mcp_source SET config = ?, auth_kind = 'oauth2', auth_connection_slot = 'auth:oauth2:connection' WHERE scope_id = ? AND id = ?",
      )
    : null;

  for (const row of rows) {
    const parsedConfig = decodeJsonObjectString(row.config);
    if (Option.isNone(parsedConfig)) continue;
    const config = parsedConfig.value;
    if (config.transport !== "remote") continue;
    const auth = config.auth;
    if (!isRecord(auth) || auth.kind !== "oauth2") continue;

    if (Option.isSome(decodeMcpCurrent(auth))) continue;

    const legacyOption = decodeMcpLegacy(auth);
    if (Option.isNone(legacyOption)) continue;
    const legacy = legacyOption.value;

    const endpoint = typeof config.endpoint === "string" ? config.endpoint : null;
    if (!endpoint) {
      failUnmigratableConnection(
        `[migrate-connections] mcp ${row.scope_id}/${row.id}: endpoint missing`,
      );
    }
    const tokenEndpoint = await resolveMcpTokenEndpoint(legacy);
    if (!tokenEndpoint) {
      failUnmigratableConnection(
        `[migrate-connections] mcp ${row.scope_id}/${row.id}: token endpoint unavailable`,
      );
    }
    const clientInformation = legacy.clientInformation ?? {};
    const metadata = legacy.authorizationServerMetadata ?? {};
    const connectionId = `mcp-oauth2-${row.id}`;
    const providerState = {
      kind: "dynamic-dcr" as const,
      tokenEndpoint,
      issuerUrl: isString(metadata.issuer) ? metadata.issuer : null,
      authorizationServerUrl: legacy.authorizationServerUrl,
      authorizationServerMetadataUrl: null,
      idTokenSigningAlgValuesSupported: stringArray(metadata.id_token_signing_alg_values_supported),
      clientId: isString(clientInformation.client_id) ? clientInformation.client_id : "",
      clientSecretSecretId: null,
      clientAuth:
        clientInformation.token_endpoint_auth_method === "client_secret_basic" ? "basic" : "body",
      scopes: [],
      scope: legacy.scope,
      resource: endpoint,
    };
    // Strip auth from config. The canonical home is mcp_source's
    // auth slot columns plus credential_binding.
    const { auth: _unused, ...configWithoutAuth } = config;
    void _unused;
    const nextConfig = hasAuthSlotColumns
      ? configWithoutAuth
      : { ...config, auth: { kind: "oauth2" as const, connectionId } };

    const secretIds = [legacy.accessTokenSecretId];
    const secretNames = [`Connection ${connectionId} access token`];
    if (legacy.refreshTokenSecretId) {
      secretIds.push(legacy.refreshTokenSecretId);
      secretNames.push(`Connection ${connectionId} refresh token`);
    }

    const txn = sqlite.transaction(() => {
      insertConnectionRow(sqlite, {
        id: connectionId,
        scopeId: row.scope_id,
        provider: OAUTH2_PROVIDER_KEY,
        identityLabel: row.name,
        accessTokenSecretId: legacy.accessTokenSecretId,
        refreshTokenSecretId: legacy.refreshTokenSecretId,
        expiresAt: legacy.expiresAt,
        scope: legacy.scope,
        providerState,
      });
      const err = rewireSecrets(sqlite, row.scope_id, connectionId, secretIds, secretNames);
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: bun:sqlite transaction callback must throw to roll back
      if (err) throw new Error(err);
      if (updateConfigAndAuth) {
        updateConfigAndAuth.run(JSON.stringify(nextConfig), row.scope_id, row.id);
        insertCredentialBinding(sqlite, {
          pluginId: "mcp",
          scopeId: row.scope_id,
          sourceId: row.id,
          slotKey: "auth:oauth2:connection",
          kind: "connection",
          connectionId,
        });
      } else {
        updateConfig.run(JSON.stringify(nextConfig), row.scope_id, row.id);
      }
    });
    txn();
    console.log(`[migrate-connections] mcp ${row.scope_id}/${row.id} -> ${connectionId}`);
  }
};

// ---------------------------------------------------------------------------
// google-discovery — legacy shape
// ---------------------------------------------------------------------------

const LegacyGoogleDiscoveryOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String.pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed("Bearer")),
  ),
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});

const CurrentGoogleDiscoveryOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  connectionId: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});

const decodeGoogleCurrent = Schema.decodeUnknownOption(CurrentGoogleDiscoveryOAuth2);
type LegacyGoogleDiscoveryOAuth2Type = typeof LegacyGoogleDiscoveryOAuth2.Type;
const decodeGoogleLegacy = decodeUnknownOptionAs<LegacyGoogleDiscoveryOAuth2Type>(
  LegacyGoogleDiscoveryOAuth2,
);

type GoogleRow = {
  scope_id: string;
  id: string;
  name: string;
  config: string;
};

const migrateGoogleDiscovery = (sqlite: Database): void => {
  if (!tableExists(sqlite, "google_discovery_source")) return;
  const rows = sqlite
    .prepare("SELECT scope_id, id, name, config FROM google_discovery_source")
    .all() as ReadonlyArray<GoogleRow>;
  if (rows.length === 0) return;

  const updateSource = sqlite.prepare(
    "UPDATE google_discovery_source SET config = ?, updated_at = ? WHERE scope_id = ? AND id = ?",
  );

  for (const row of rows) {
    const parsedConfig = decodeJsonObjectString(row.config);
    if (Option.isNone(parsedConfig)) continue;
    const config = parsedConfig.value;
    const auth = config.auth;
    if (!isRecord(auth) || auth.kind !== "oauth2") continue;

    if (Option.isSome(decodeGoogleCurrent(auth))) continue;

    const legacyOption = decodeGoogleLegacy(auth);
    if (Option.isNone(legacyOption)) continue;
    const legacy = legacyOption.value;

    const connectionId = `google-discovery-oauth2-${randomUUID()}`;
    const providerState = {
      kind: "authorization-code" as const,
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      issuerUrl: "https://accounts.google.com",
      clientIdSecretId: legacy.clientIdSecretId,
      clientSecretSecretId: legacy.clientSecretSecretId,
      clientAuth: "body" as const,
      scopes: legacy.scopes,
      scope: legacy.scope,
    };
    const authPointer = {
      kind: "oauth2" as const,
      connectionId,
      clientIdSecretId: legacy.clientIdSecretId,
      clientSecretSecretId: legacy.clientSecretSecretId,
      scopes: legacy.scopes,
    };
    const nextConfig = { ...config, auth: authPointer };

    const secretIds = [legacy.accessTokenSecretId];
    const secretNames = [`Connection ${connectionId} access token`];
    if (legacy.refreshTokenSecretId) {
      secretIds.push(legacy.refreshTokenSecretId);
      secretNames.push(`Connection ${connectionId} refresh token`);
    }

    const txn = sqlite.transaction(() => {
      insertConnectionRow(sqlite, {
        id: connectionId,
        scopeId: row.scope_id,
        provider: OAUTH2_PROVIDER_KEY,
        identityLabel: row.name,
        accessTokenSecretId: legacy.accessTokenSecretId,
        refreshTokenSecretId: legacy.refreshTokenSecretId,
        expiresAt: legacy.expiresAt,
        scope: legacy.scope,
        providerState,
      });
      const err = rewireSecrets(sqlite, row.scope_id, connectionId, secretIds, secretNames);
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: bun:sqlite transaction callback must throw to roll back
      if (err) throw new Error(err);
      updateSource.run(JSON.stringify(nextConfig), Date.now(), row.scope_id, row.id);
    });
    txn();
    console.log(
      `[migrate-connections] google-discovery ${row.scope_id}/${row.id} -> ${connectionId}`,
    );
  }
};

// ---------------------------------------------------------------------------
// Umbrella
// ---------------------------------------------------------------------------

/**
 * Scan openapi_source, mcp_source, and google_discovery_source; migrate
 * any row still on its plugin's legacy inline-OAuth shape to a fresh
 * Connection row + pointer. Idempotent — rows already on the current
 * shape are skipped. Legacy rows that cannot be represented in the new
 * model fail the migration instead of being silently left behind.
 */
export const migrateLegacyConnections = async (sqlite: Database): Promise<void> => {
  if (!connectionsReady(sqlite)) return;
  await migrateOpenApi(sqlite);
  await migrateMcp(sqlite);
  migrateGoogleDiscovery(sqlite);
};
