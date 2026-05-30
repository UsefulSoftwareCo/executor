import { type Client, type InValue } from "@libsql/client";
import { Option, Schema } from "effect";
import { randomBytes } from "node:crypto";

import { queryFirst, queryRows } from "./libsql";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const GoogleDiscoveryConfig = Schema.Struct({
  discoveryUrl: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  rootUrl: Schema.String,
  servicePath: Schema.optional(Schema.String),
});

const GoogleDiscoveryParameter = Schema.Struct({
  name: Schema.String,
  location: Schema.String,
  required: Schema.optional(Schema.Boolean),
  repeated: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Unknown),
});

const GoogleDiscoveryBinding = Schema.Struct({
  method: Schema.String,
  pathTemplate: Schema.String,
  hasBody: Schema.optional(Schema.Boolean),
  parameters: Schema.optional(Schema.Array(GoogleDiscoveryParameter)),
});

const JsonInputSchema = Schema.Struct({
  properties: Schema.optional(UnknownRecord),
});

const GoogleDiscoveryScopes = Schema.Array(Schema.String);

const decodeGoogleDiscoveryConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(GoogleDiscoveryConfig),
);
const decodeGoogleDiscoveryBinding = Schema.decodeUnknownOption(
  Schema.fromJsonString(GoogleDiscoveryBinding),
);
const decodeInputSchema = Schema.decodeUnknownOption(Schema.fromJsonString(JsonInputSchema));
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecord);
const decodeGoogleDiscoveryScopes = Schema.decodeUnknownOption(
  Schema.fromJsonString(GoogleDiscoveryScopes),
);

type GoogleDiscoveryConfig = typeof GoogleDiscoveryConfig.Type;
type GoogleDiscoveryBinding = typeof GoogleDiscoveryBinding.Type;

type GoogleSourceRow = {
  readonly id: string;
  readonly scope_id: string;
  readonly name: string;
  readonly config: string;
  readonly auth_kind: string;
  readonly auth_connection_id: string | null;
  readonly auth_client_id_secret_id: string | null;
  readonly auth_client_secret_secret_id: string | null;
  readonly auth_scopes: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type GoogleBindingRow = {
  readonly id: string;
  readonly scope_id: string;
  readonly source_id: string;
  readonly binding: string;
};

type ToolRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input_schema: string | null;
  readonly output_schema: string | null;
};

type DefinitionRow = {
  readonly name: string;
  readonly schema: string;
};

type CredentialRow = {
  readonly name: string;
  readonly kind: string;
  readonly text_value: string | null;
  readonly secret_id: string | null;
  readonly secret_prefix: string | null;
};

type MigratedCredentialBinding =
  | {
      readonly slot: string;
      readonly kind: "secret";
      readonly secretId: string;
      readonly prefix?: string | null;
    }
  | {
      readonly slot: string;
      readonly kind: "connection";
      readonly connectionId: string;
    };

type OpenApiParameter = {
  readonly name: string;
  readonly location: string;
  readonly required: boolean;
  readonly schema: unknown;
  readonly style?: "form";
  readonly explode?: boolean;
  readonly description?: string;
};

const textDecoder = new TextDecoder();

// libSQL returns BLOB columns as ArrayBuffer (legacy rows stored JSON as bytes),
// TEXT columns as string. Normalize both to text before JSON-decoding.
const decodeJsonColumnOption = <A>(
  decode: (value: unknown) => Option.Option<A>,
  value: string | Uint8Array | ArrayBuffer | null | undefined,
): Option.Option<A> => {
  if (!value) return Option.none();
  const text =
    typeof value === "string"
      ? value
      : textDecoder.decode(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  return decode(text);
};

const decodeJsonColumnOrUndefined = (
  value: string | Uint8Array | ArrayBuffer | null | undefined,
): unknown | undefined => Option.getOrUndefined(decodeJsonColumnOption(decodeUnknownJson, value));

const recordFromUnknown = (value: unknown): Record<string, unknown> =>
  Option.getOrElse(decodeUnknownRecord(value), () => ({}));

const nonEmptyStringOrUndefined = (value: string | undefined): string | undefined =>
  value && value.length > 0 ? value : undefined;

const googleSchemaRef = (name: string): string => `#/$defs/${name}`;

const openApiPluginStorageId = (collection: string, key: string): string =>
  JSON.stringify(["openapi", collection, key]);

const openApiCredentialBindingId = (scopeId: string, sourceId: string, slot: string): string =>
  JSON.stringify(["openapi", scopeId, sourceId, slot]);

const slugifyCredentialSlotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

const openApiHeaderSlot = (name: string): string => `header:${slugifyCredentialSlotPart(name)}`;

const openApiQueryParamSlot = (name: string): string =>
  `query_param:${slugifyCredentialSlotPart(name)}`;

const googleOAuthSecuritySchemeName = "googleOAuth2";

const googleOAuthSlotPart = slugifyCredentialSlotPart(googleOAuthSecuritySchemeName);

const googleOAuthClientIdSlot = `oauth2:${googleOAuthSlotPart}:client-id`;
const googleOAuthClientSecretSlot = `oauth2:${googleOAuthSlotPart}:client-secret`;
const googleOAuthConnectionSlot = `oauth2:${googleOAuthSlotPart}:connection`;

const randomRowId = (): string => randomBytes(12).toString("hex");

const googleCredentialMap = (
  rows: readonly CredentialRow[],
  slotForName: (name: string) => string,
  bindings: MigratedCredentialBinding[],
): Record<string, unknown> | undefined => {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.kind === "text" && row.text_value != null) {
      values[row.name] = row.text_value;
      continue;
    }
    if (row.kind === "secret" && row.secret_id != null) {
      const slot = slotForName(row.name);
      values[row.name] =
        row.secret_prefix != null
          ? { kind: "binding", slot, prefix: row.secret_prefix }
          : { kind: "binding", slot };
      bindings.push({
        slot,
        kind: "secret",
        secretId: row.secret_id,
        prefix: row.secret_prefix,
      });
    }
  }
  return Object.keys(values).length > 0 ? values : undefined;
};

const readSourceConfig = (source: GoogleSourceRow): GoogleDiscoveryConfig | null => {
  const decoded = decodeJsonColumnOption(decodeGoogleDiscoveryConfig, source.config);
  if (Option.isNone(decoded)) return null;
  return decoded.value;
};

const readBinding = (row: GoogleBindingRow): GoogleDiscoveryBinding | null => {
  const decoded = decodeJsonColumnOption(decodeGoogleDiscoveryBinding, row.binding);
  if (Option.isNone(decoded)) return null;
  return decoded.value;
};

const readBodySchema = (tool: ToolRow | undefined): Record<string, unknown> => {
  const decoded = decodeJsonColumnOption(decodeInputSchema, tool?.input_schema);
  if (Option.isNone(decoded)) return {};
  return recordFromUnknown(decoded.value.properties?.body);
};

const readScopes = (value: string | null): readonly string[] =>
  Option.getOrElse(decodeJsonColumnOption(decodeGoogleDiscoveryScopes, value), () => []);

const openApiParameters = (
  parameters: readonly (typeof GoogleDiscoveryParameter.Type)[] | undefined,
): readonly OpenApiParameter[] =>
  (parameters ?? []).map((parameter) => ({
    name: parameter.name,
    location: parameter.location,
    required: parameter.location === "path" ? true : parameter.required === true,
    schema: parameter.schema ?? { type: "string" },
    ...(parameter.location === "query"
      ? { style: "form" as const, explode: parameter.repeated === true }
      : {}),
    ...(parameter.description ? { description: parameter.description } : {}),
  }));

// One-shot startup migration over the LIVE libSQL handle (same file the app
// runs on). Each source migrates inside its own write transaction so a failure
// leaves that source atomic; reads and the BEGIN/COMMIT/ROLLBACK block move from
// synchronous bun:sqlite to async `client.execute` / `client.transaction`.
export const oneShotMigrateGoogleDiscoveryToOpenApi = async (client: Client): Promise<number> => {
  const table = await queryFirst(
    client,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ["google_discovery_source"],
  );
  if (!table) return 0;

  const sources = await queryRows<GoogleSourceRow>(
    client,
    "SELECT * FROM google_discovery_source ORDER BY scope_id, id",
  );
  let migrated = 0;
  const migrateSource = async (source: GoogleSourceRow): Promise<boolean> => {
    const config = readSourceConfig(source);
    if (!config) return false;

    const baseUrl = new URL(config.servicePath ?? "", config.rootUrl).toString();
    const service = nonEmptyStringOrUndefined(config.service) ?? source.id;
    const version = nonEmptyStringOrUndefined(config.version) ?? "v1";
    const discoveryUrl = nonEmptyStringOrUndefined(config.discoveryUrl);

    const bindings = await queryRows<GoogleBindingRow>(
      client,
      "SELECT * FROM google_discovery_binding WHERE scope_id = ? AND source_id = ? ORDER BY id",
      [source.scope_id, source.id],
    );
    if (bindings.length === 0) return false;

    const toolRows = new Map(
      (
        await queryRows<ToolRow>(
          client,
          "SELECT id, name, description, input_schema, output_schema FROM tool WHERE scope_id = ? AND source_id = ?",
          [source.scope_id, source.id],
        )
      ).map((row) => [row.id, row] as const),
    );
    const definitions = await queryRows<DefinitionRow>(
      client,
      "SELECT name, schema FROM definition WHERE scope_id = ? AND source_id = ? ORDER BY name",
      [source.scope_id, source.id],
    );

    const paths: Record<string, Record<string, unknown>> = {};
    const operationRows: Array<{ readonly toolId: string; readonly binding: unknown }> = [];

    for (const row of bindings) {
      const binding = readBinding(row);
      if (!binding) continue;

      const method = binding.method.toLowerCase();
      const pathTemplate = binding.pathTemplate.startsWith("/")
        ? binding.pathTemplate
        : `/${binding.pathTemplate}`;
      const tool = toolRows.get(row.id);
      const toolPath = tool?.name ?? row.id.slice(source.id.length + 1);
      const bodySchema = readBodySchema(tool);
      const responseSchema = decodeJsonColumnOrUndefined(tool?.output_schema) ?? {};
      const parameters = openApiParameters(binding.parameters);

      paths[pathTemplate] ??= {};
      paths[pathTemplate]![method] = {
        operationId: toolPath,
        "x-executor-toolPath": toolPath,
        ...(tool?.description ? { description: tool.description } : {}),
        parameters: parameters.map(({ location, ...parameter }) => ({
          ...parameter,
          in: location,
        })),
        ...(binding.hasBody === true
          ? {
              requestBody: {
                required: false,
                content: {
                  "application/json": {
                    schema: Object.keys(bodySchema).length > 0 ? bodySchema : { type: "object" },
                  },
                },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: responseSchema,
              },
            },
          },
        },
      };

      operationRows.push({
        toolId: row.id,
        binding: {
          method,
          pathTemplate,
          parameters,
          ...(binding.hasBody === true
            ? {
                requestBody: {
                  required: false,
                  contentType: "application/json",
                  schema: Object.keys(bodySchema).length > 0 ? bodySchema : { type: "object" },
                  contents: [
                    {
                      contentType: "application/json",
                      schema: Object.keys(bodySchema).length > 0 ? bodySchema : { type: "object" },
                    },
                  ],
                },
              }
            : {}),
        },
      });
    }

    if (operationRows.length === 0) return false;

    const schemaDefinitions = Object.fromEntries(
      definitions.map((definition) => [
        definition.name,
        decodeJsonColumnOrUndefined(definition.schema) ?? {
          $ref: googleSchemaRef(definition.name),
        },
      ]),
    );
    const scopes = readScopes(source.auth_scopes);
    const oauth2 =
      source.auth_kind === "oauth2" && source.auth_connection_id && source.auth_client_id_secret_id
        ? {
            kind: "oauth2",
            securitySchemeName: googleOAuthSecuritySchemeName,
            flow: "authorizationCode",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            issuerUrl: "https://accounts.google.com",
            tokenUrl: "https://oauth2.googleapis.com/token",
            clientIdSlot: googleOAuthClientIdSlot,
            clientSecretSlot: source.auth_client_secret_secret_id
              ? googleOAuthClientSecretSlot
              : null,
            connectionSlot: googleOAuthConnectionSlot,
            scopes,
          }
        : undefined;

    const spec = {
      openapi: "3.1.0",
      info: { title: source.name, version },
      servers: [{ url: baseUrl }],
      paths,
      components: {
        schemas: schemaDefinitions,
        ...(oauth2
          ? {
              securitySchemes: {
                [googleOAuthSecuritySchemeName]: {
                  type: "oauth2",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: oauth2.authorizationUrl,
                      tokenUrl: oauth2.tokenUrl,
                      scopes: Object.fromEntries(scopes.map((scope) => [scope, ""])),
                    },
                  },
                },
              },
            }
          : {}),
      },
      ...(oauth2 ? { security: [{ [googleOAuthSecuritySchemeName]: scopes }] } : {}),
      "x-executor-origin": {
        kind: "googleDiscovery",
        ...(discoveryUrl ? { discoveryUrl } : {}),
        service,
        version,
      },
    };

    const credentialBindings: MigratedCredentialBinding[] = [];

    const headerRows = await queryRows<CredentialRow>(
      client,
      "SELECT name, kind, text_value, secret_id, secret_prefix FROM google_discovery_source_credential_header WHERE scope_id = ? AND source_id = ?",
      [source.scope_id, source.id],
    );
    const queryParamRows = await queryRows<CredentialRow>(
      client,
      "SELECT name, kind, text_value, secret_id, secret_prefix FROM google_discovery_source_credential_query_param WHERE scope_id = ? AND source_id = ?",
      [source.scope_id, source.id],
    );
    const headers = googleCredentialMap(headerRows, openApiHeaderSlot, credentialBindings);
    const queryParams = googleCredentialMap(
      queryParamRows,
      openApiQueryParamSlot,
      credentialBindings,
    );

    if (oauth2 && source.auth_client_id_secret_id) {
      credentialBindings.push({
        slot: googleOAuthClientIdSlot,
        kind: "secret",
        secretId: source.auth_client_id_secret_id,
      });
      if (source.auth_client_secret_secret_id) {
        credentialBindings.push({
          slot: googleOAuthClientSecretSlot,
          kind: "secret",
          secretId: source.auth_client_secret_secret_id,
        });
      }
      if (source.auth_connection_id) {
        credentialBindings.push({
          slot: googleOAuthConnectionSlot,
          kind: "connection",
          connectionId: source.auth_connection_id,
        });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const sourceData = {
      namespace: source.id,
      scope: source.scope_id,
      name: source.name,
      config: {
        spec: JSON.stringify(spec),
        baseUrl,
        namespace: source.id,
        ...(headers ? { headers } : {}),
        ...(queryParams ? { queryParams } : {}),
        ...(oauth2 ? { oauth2 } : {}),
      },
    };

    // Each source migrates atomically: a libSQL write transaction replaces the
    // bun:sqlite BEGIN IMMEDIATE / COMMIT / ROLLBACK block.
    const tx = await client.transaction("write");
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: one-shot startup migration should leave each source atomic on write failure
    try {
      await tx.execute({
        sql: "INSERT OR REPLACE INTO plugin_storage (plugin_id, collection, key, data, created_at, updated_at, row_id, id, scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          "openapi",
          "source",
          source.id,
          JSON.stringify(sourceData),
          source.created_at ?? now,
          now,
          randomRowId(),
          openApiPluginStorageId("source", source.id),
          source.scope_id,
        ] satisfies InValue[],
      });

      for (const operation of operationRows) {
        await tx.execute({
          sql: "INSERT OR REPLACE INTO plugin_storage (plugin_id, collection, key, data, created_at, updated_at, row_id, id, scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            "openapi",
            "operation",
            operation.toolId,
            JSON.stringify({
              toolId: operation.toolId,
              sourceId: source.id,
              binding: operation.binding,
            }),
            source.created_at ?? now,
            now,
            randomRowId(),
            openApiPluginStorageId("operation", operation.toolId),
            source.scope_id,
          ] satisfies InValue[],
        });
      }

      for (const binding of credentialBindings) {
        const secretId = binding.kind === "secret" ? binding.secretId : null;
        const secretScopeId = binding.kind === "secret" ? source.scope_id : null;
        const connectionId = binding.kind === "connection" ? binding.connectionId : null;
        await tx.execute({
          sql: "INSERT OR REPLACE INTO credential_binding (plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, secret_scope_id, connection_id, created_at, updated_at, row_id, id, scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            "openapi",
            source.id,
            source.scope_id,
            binding.slot,
            binding.kind,
            null,
            secretId,
            secretScopeId,
            connectionId,
            now,
            now,
            randomRowId(),
            openApiCredentialBindingId(source.scope_id, source.id, binding.slot),
            source.scope_id,
          ] satisfies InValue[],
        });
      }

      await tx.execute({
        sql: "UPDATE source SET plugin_id = ?, kind = ?, url = ?, can_refresh = ?, can_edit = ?, updated_at = ? WHERE scope_id = ? AND id = ?",
        args: ["openapi", "openapi", baseUrl, 0, 1, now, source.scope_id, source.id],
      });
      await tx.execute({
        sql: "UPDATE tool SET plugin_id = ?, updated_at = ? WHERE scope_id = ? AND source_id = ?",
        args: ["openapi", now, source.scope_id, source.id],
      });
      await tx.execute({
        sql: "UPDATE definition SET plugin_id = ? WHERE scope_id = ? AND source_id = ?",
        args: ["openapi", source.scope_id, source.id],
      });
      await tx.execute({
        sql: "DELETE FROM google_discovery_binding WHERE scope_id = ? AND source_id = ?",
        args: [source.scope_id, source.id],
      });
      await tx.execute({
        sql: "DELETE FROM google_discovery_source_credential_header WHERE scope_id = ? AND source_id = ?",
        args: [source.scope_id, source.id],
      });
      await tx.execute({
        sql: "DELETE FROM google_discovery_source_credential_query_param WHERE scope_id = ? AND source_id = ?",
        args: [source.scope_id, source.id],
      });
      await tx.execute({
        sql: "DELETE FROM google_discovery_source WHERE scope_id = ? AND id = ?",
        args: [source.scope_id, source.id],
      });
      await tx.commit();
    } catch (cause) {
      await tx.rollback();
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the migration rolls back then preserves the original startup failure
      throw cause;
    }

    return true;
  };

  for (const source of sources) {
    if (await migrateSource(source)) {
      migrated++;
    }
  }

  if (migrated > 0) {
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  return migrated;
};
