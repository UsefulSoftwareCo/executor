import { Effect, Match, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  authToolFailure,
  definePlugin,
  IntegrationAlreadyExistsError,
  IntegrationSlug,
  ToolName,
  ToolResult,
  tool,
  type IntegrationConfig,
  type PluginCtx,
  type ToolAnnotations,
  type ToolDef,
  type ToolInvocationCredential,
} from "@executor-js/sdk";

import {
  introspect,
  parseIntrospectionJson,
  type IntrospectionResult,
  type IntrospectionType,
  type IntrospectionField,
  type IntrospectionTypeRef,
} from "./introspect";
import { extract } from "./extract";
import {
  GraphqlAuthRequiredError,
  GraphqlExtractionError,
  GraphqlIntrospectionError,
  GraphqlInvocationError,
} from "./errors";
import { invokeWithLayer } from "./invoke";
import { graphqlPresets } from "./presets";
import {
  type ApiKeyHeaderTemplate,
  type ApiKeyQueryTemplate,
  AuthTemplate,
  ExtractedField,
  GraphqlIntegrationConfig,
  type GraphqlOperationKind,
  type OAuthTemplate,
  OperationBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

const GraphqlErrorBody = Schema.Struct({ message: Schema.String });
const GraphqlErrorsBody = Schema.Array(Schema.Unknown);
const decodeGraphqlErrorBody = Schema.decodeUnknownOption(GraphqlErrorBody);
const decodeGraphqlErrorsBody = Schema.decodeUnknownOption(GraphqlErrorsBody);
const decodeIntegrationConfig = Schema.decodeUnknownOption(GraphqlIntegrationConfig);

const decodeGraphqlErrors = (errors: unknown): readonly unknown[] | undefined =>
  Option.getOrUndefined(decodeGraphqlErrorsBody(errors));

const extractGraphqlErrorMessage = (errors: readonly unknown[]): string | undefined =>
  errors
    .map((error: unknown) => Option.getOrUndefined(decodeGraphqlErrorBody(error))?.message)
    .find((message: string | undefined) => message !== undefined && message.length > 0);

const GRAPHQL_PLUGIN_ID = "graphql-greenfield";

/** The default auth template a connection applies through when the integration
 *  declares no explicit `authentication`. Renders the value as a bearer header. */
const DEFAULT_OAUTH_TEMPLATE_SLUG = "oauth";

// ---------------------------------------------------------------------------
// Public input contracts — derived from the Effect Schemas so the wire shape
// and the TypeScript type stay in lockstep.
// ---------------------------------------------------------------------------

const AddGraphqlIntegrationInputSchema = Schema.Struct({
  /** The integration slug (catalog identity). */
  slug: Schema.String,
  /** The GraphQL endpoint URL. */
  endpoint: Schema.String,
  /** Display description for the catalog. */
  description: Schema.optional(Schema.String),
  /** Optional introspection JSON (when the endpoint can't be reached live). */
  introspectionJson: Schema.optional(Schema.String),
  /** Auth methods a connection can apply through. Defaults to a single bearer
   *  oauth template if omitted. */
  authentication: Schema.optional(Schema.Array(AuthTemplate)),
  /** Headers applied to the add-time introspection request only. */
  introspectionHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type AddGraphqlIntegrationInput = typeof AddGraphqlIntegrationInputSchema.Type;

const ConfigureGraphqlIntegrationInputSchema = Schema.Struct({
  slug: Schema.String,
  endpoint: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  authentication: Schema.optional(Schema.Array(AuthTemplate)),
});
/** Patch applied by `configureIntegration` (the `slug` identifies which one). */
export type ConfigureGraphqlIntegrationInput = Omit<
  typeof ConfigureGraphqlIntegrationInputSchema.Type,
  "slug"
>;

const ConfigureGraphqlIntegrationOutputSchema = Schema.Struct({
  configured: Schema.Boolean,
});

const StaticAddIntegrationOutputSchema = Schema.Struct({
  slug: Schema.String,
  toolCount: Schema.Number,
});
const StaticGetIntegrationInputSchema = Schema.Struct({ slug: Schema.String });
const StaticGetIntegrationOutputSchema = Schema.Struct({
  integration: Schema.NullOr(Schema.Unknown),
});

const toStandard = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema));

const StaticAddIntegrationInputStandardSchema = toStandard(AddGraphqlIntegrationInputSchema);
const StaticAddIntegrationOutputStandardSchema = toStandard(StaticAddIntegrationOutputSchema);
const StaticGetIntegrationInputStandardSchema = toStandard(StaticGetIntegrationInputSchema);
const StaticGetIntegrationOutputStandardSchema = toStandard(StaticGetIntegrationOutputSchema);
const StaticConfigureIntegrationInputStandardSchema = toStandard(
  ConfigureGraphqlIntegrationInputSchema,
);
const StaticConfigureIntegrationOutputStandardSchema = toStandard(
  ConfigureGraphqlIntegrationOutputSchema,
);

const graphqlToolFailure = (code: string, message: string, details?: unknown) =>
  ToolResult.fail({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

const graphqlAuthToolFailure = (failure: GraphqlAuthRequiredError) =>
  authToolFailure({
    code: failure.code,
    message: failure.message,
    source: { id: failure.integration },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
    },
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.details !== undefined
      ? {
          upstream: {
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            details: failure.details,
          },
        }
      : {}),
    recovery: { configureSourceTool: "executor.graphql-greenfield.configureIntegration" },
  });

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Match `token` as a separator-bounded run inside a URL hostname or path,
 *  used as a low-confidence detection hint when introspection fails. */
const urlMatchesToken = (url: URL, token: string): boolean => {
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i");
  return re.test(url.hostname) || re.test(url.pathname);
};

/** Derive a slug from an endpoint URL. */
const slugFromEndpoint = (endpoint: string): string => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL construction throws; this helper intentionally falls back to the stable default slug
  try {
    const url = new URL(endpoint);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "graphql";
  }
};

// ---------------------------------------------------------------------------
// Operation-string building
// ---------------------------------------------------------------------------

const formatTypeRef = (ref: IntrospectionTypeRef): string =>
  Match.value(ref.kind).pipe(
    Match.when("NON_NULL", () => (ref.ofType ? `${formatTypeRef(ref.ofType)}!` : "Unknown!")),
    Match.when("LIST", () => (ref.ofType ? `[${formatTypeRef(ref.ofType)}]` : "[Unknown]")),
    Match.option,
    Option.getOrElse(() => ref.name ?? "Unknown"),
  );

const unwrapTypeName = (ref: IntrospectionTypeRef): string => {
  if (ref.name) return ref.name;
  if (ref.ofType) return unwrapTypeName(ref.ofType);
  return "Unknown";
};

const buildSelectionSet = (
  ref: IntrospectionTypeRef,
  types: ReadonlyMap<string, IntrospectionType>,
  depth: number,
  seen: Set<string>,
): string => {
  if (depth > 2) return "";

  const leafName = unwrapTypeName(ref);
  if (seen.has(leafName)) return "";

  const objectType = types.get(leafName);
  if (!objectType?.fields) return "";

  const kind = objectType.kind;
  if (kind === "SCALAR" || kind === "ENUM") return "";

  seen.add(leafName);

  const subFields = objectType.fields
    .filter((f: IntrospectionField) => !f.name.startsWith("__"))
    .slice(0, 12)
    .map((f: IntrospectionField) => {
      const sub = buildSelectionSet(f.type, types, depth + 1, seen);
      return sub ? `${f.name} ${sub}` : f.name;
    });

  seen.delete(leafName);

  return subFields.length > 0 ? `{ ${subFields.join(" ")} }` : "";
};

const buildOperationStringForField = (
  kind: GraphqlOperationKind,
  field: IntrospectionField,
  types: ReadonlyMap<string, IntrospectionType>,
): string => {
  const opType = kind === "query" ? "query" : "mutation";

  const varDefs = field.args.map((arg) => {
    const typeName = formatTypeRef(arg.type);
    return `$${arg.name}: ${typeName}`;
  });

  const argPasses = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const selectionSet = buildSelectionSet(field.type, types, 0, new Set());

  const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(", ")})` : "";
  const argPassStr = argPasses.length > 0 ? `(${argPasses.join(", ")})` : "";

  return `${opType}${varDefsStr} { ${field.name}${argPassStr}${selectionSet ? ` ${selectionSet}` : ""} }`;
};

const prepareOperations = (
  fields: readonly ExtractedField[],
  introspection: IntrospectionResult,
): readonly OperationBinding[] => {
  const typeMap = new Map<string, IntrospectionType>();
  for (const t of introspection.__schema.types) {
    typeMap.set(t.name, t);
  }

  const fieldMap = new Map<string, { kind: GraphqlOperationKind; field: IntrospectionField }>();
  const schema = introspection.__schema;
  for (const rootKind of ["query", "mutation"] as const) {
    const typeName = rootKind === "query" ? schema.queryType?.name : schema.mutationType?.name;
    if (!typeName) continue;
    const rootType = typeMap.get(typeName);
    if (!rootType?.fields) continue;
    for (const f of rootType.fields) {
      if (!f.name.startsWith("__")) {
        fieldMap.set(`${rootKind}.${f.name}`, { kind: rootKind, field: f });
      }
    }
  }

  return fields.map((extracted: ExtractedField) => {
    const prefix = extracted.kind === "mutation" ? "mutation" : "query";
    // A tool's name keeps its `<kind>.<field>` path (e.g. `query.hello`,
    // `mutation.setGreeting`). The address grammar treats `<tool>` as the
    // trailing remainder (see parseToolAddress), so the dot nests naturally.
    const toolName = `${prefix}.${extracted.fieldName}`;
    const description = Option.getOrElse(
      extracted.description,
      () => `GraphQL ${extracted.kind}: ${extracted.fieldName} -> ${extracted.returnTypeName}`,
    );

    const key = `${extracted.kind}.${extracted.fieldName}`;
    const entry = fieldMap.get(key);
    const operationString = entry
      ? buildOperationStringForField(entry.kind, entry.field, typeMap)
      : `${extracted.kind} { ${extracted.fieldName} }`;

    return OperationBinding.make({
      toolName,
      kind: extracted.kind,
      fieldName: extracted.fieldName,
      operationString,
      variableNames: extracted.arguments.map((a) => a.name),
      description,
      inputSchema: Option.getOrUndefined(extracted.inputSchema),
    });
  });
};

const annotationsFor = (binding: OperationBinding): ToolAnnotations | undefined => {
  if (binding.kind === "mutation") {
    return {
      requiresApproval: true,
      approvalDescription: `mutation ${binding.fieldName}`,
    };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Auth-template rendering — D11: the plugin derives the resolved connection
// value into the integration's auth-template format. An OAuth access token and
// an apiKey both arrive as a single `value` and render identically.
// ---------------------------------------------------------------------------

interface RenderedAuth {
  readonly headers: Record<string, string>;
  readonly queryParams: Record<string, string>;
}

const selectAuthTemplate = (
  authentication: readonly AuthTemplate[],
  templateSlug: string,
): AuthTemplate | null => {
  const match = authentication.find((t: AuthTemplate) => t.slug === templateSlug);
  if (match) return match;
  // Fall back to the first declared template, or a synthesized default oauth.
  if (authentication.length > 0) return authentication[0] ?? null;
  return null;
};

const renderAuth = (template: AuthTemplate | null, value: string): RenderedAuth => {
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};

  if (template === null) {
    // No declared template — default to a bearer Authorization header.
    headers.Authorization = `Bearer ${value}`;
    return { headers, queryParams };
  }

  Match.value(template).pipe(
    Match.when({ type: "apiKey", in: "header" }, (t: ApiKeyHeaderTemplate) => {
      headers[t.name] = `${t.prefix ?? ""}${value}`;
    }),
    Match.when({ type: "apiKey", in: "query" }, (t: ApiKeyQueryTemplate) => {
      queryParams[t.name] = `${t.prefix ?? ""}${value}`;
    }),
    Match.when({ type: "oauth" }, (t: OAuthTemplate) => {
      const header = t.header ?? "Authorization";
      const prefix = t.prefix ?? "Bearer ";
      headers[header] = `${prefix}${value}`;
    }),
    Match.exhaustive,
  );

  return { headers, queryParams };
};

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface GraphqlPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}

const defaultAuthentication = (
  authentication: readonly AuthTemplate[] | undefined,
): readonly AuthTemplate[] =>
  authentication && authentication.length > 0
    ? authentication
    : [AuthTemplate.make({ slug: DEFAULT_OAUTH_TEMPLATE_SLUG, type: "oauth" })];

const integrationConfigFrom = (config: IntegrationConfig): GraphqlIntegrationConfig | null =>
  Option.getOrNull(decodeIntegrationConfig(config));

const makeGraphqlExtension = (
  ctx: PluginCtx<Record<string, never>>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) => {
  const buildConfig = (input: AddGraphqlIntegrationInput) =>
    Effect.gen(function* () {
      let introspectionResult: IntrospectionResult;
      if (input.introspectionJson) {
        introspectionResult = yield* parseIntrospectionJson(input.introspectionJson);
      } else {
        introspectionResult = yield* introspect(input.endpoint, input.introspectionHeaders).pipe(
          Effect.provide(httpClientLayer),
        );
      }

      const { result, definitions } = yield* extract(introspectionResult);
      const operations = prepareOperations(result.fields, introspectionResult);

      const config = GraphqlIntegrationConfig.make({
        endpoint: input.endpoint,
        ...(input.introspectionJson ? { introspectionJson: input.introspectionJson } : {}),
        authentication: defaultAuthentication(input.authentication),
        operations,
        ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
      });
      return { config, toolCount: operations.length };
    });

  const addIntegration = (input: AddGraphqlIntegrationInput) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(input.slug);

      // Block re-adding an existing slug. The core `integrations.register`
      // primitive upserts (so boot re-registration is idempotent), but an
      // explicit add must NOT silently clobber an existing integration's tools,
      // connections, and policies. To add more auth, update the existing one.
      const existing = yield* ctx.core.integrations.get(slug);
      if (existing) {
        return yield* new IntegrationAlreadyExistsError({ slug });
      }

      return yield* ctx.transaction(
        Effect.gen(function* () {
          const { config, toolCount } = yield* buildConfig(input);
          yield* ctx.core.integrations.register({
            slug,
            description: input.description ?? input.slug,
            config,
            canRemove: true,
            canRefresh: true,
          });
          return { slug: input.slug, toolCount };
        }),
      );
    });

  const getIntegration = (slug: string) =>
    ctx.core.integrations.get(IntegrationSlug.make(slug)).pipe(
      Effect.map((record) => {
        if (record === null) return null;
        const config = integrationConfigFrom(record.config);
        return { ...record, config };
      }),
    );

  const configureIntegration = (slug: string, input: ConfigureGraphqlIntegrationInput) =>
    Effect.gen(function* () {
      const integrationSlug = IntegrationSlug.make(slug);
      const record = yield* ctx.core.integrations.get(integrationSlug);
      if (record === null) return;
      const existing = integrationConfigFrom(record.config);
      if (existing === null) return;
      const nextConfig = GraphqlIntegrationConfig.make({
        ...existing,
        endpoint: input.endpoint ?? existing.endpoint,
        authentication: input.authentication ?? existing.authentication,
      });
      yield* ctx.core.integrations.update(integrationSlug, {
        ...(input.description ? { description: input.description } : {}),
        config: nextConfig,
      });
    });

  const removeIntegration = (slug: string) =>
    ctx.core.integrations.remove(IntegrationSlug.make(slug));

  return {
    addIntegration,
    getIntegration,
    configureIntegration,
    removeIntegration,
  };
};

export type GraphqlPluginExtension = ReturnType<typeof makeGraphqlExtension>;

export const graphqlPlugin = definePlugin((options?: GraphqlPluginOptions) => {
  return {
    id: GRAPHQL_PLUGIN_ID as typeof GRAPHQL_PLUGIN_ID,
    packageName: "@executor-js/plugin-graphql-greenfield",
    integrationPresets: graphqlPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      summary: preset.summary,
      url: preset.url,
      endpoint: preset.endpoint,
      ...(preset.icon ? { icon: preset.icon } : {}),
      ...(preset.featured ? { featured: preset.featured } : {}),
    })),
    storage: (): Record<string, never> => ({}),

    extension: (ctx) => makeGraphqlExtension(ctx, options?.httpClientLayer ?? ctx.httpClientLayer),

    staticSources: (self) => [
      {
        id: GRAPHQL_PLUGIN_ID,
        kind: "executor",
        name: "GraphQL",
        tools: [
          tool({
            name: "addIntegration",
            description:
              "Add a GraphQL endpoint as an integration and register its operations as tools. Introspects the endpoint (or uses `introspectionJson`) and stores the operation bindings plus auth templates in the integration catalog. After adding, create a connection for the integration (via `connections.create` or `oauth.start`) to make its tools callable.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add a GraphQL integration",
            },
            inputSchema: StaticAddIntegrationInputStandardSchema,
            outputSchema: StaticAddIntegrationOutputStandardSchema,
            execute: (input) =>
              self.addIntegration(input as AddGraphqlIntegrationInput).pipe(
                Effect.map((result) => ToolResult.ok(result)),
                Effect.catchTags({
                  GraphqlIntrospectionError: ({ message }: GraphqlIntrospectionError) =>
                    Effect.succeed(graphqlToolFailure("graphql_introspection_failed", message)),
                  GraphqlExtractionError: ({ message }: GraphqlExtractionError) =>
                    Effect.succeed(graphqlToolFailure("graphql_extraction_failed", message)),
                  IntegrationAlreadyExistsError: ({ slug }: IntegrationAlreadyExistsError) =>
                    Effect.succeed(
                      graphqlToolFailure(
                        "integration_already_exists",
                        `Integration ${slug} already exists; update it instead of re-adding.`,
                      ),
                    ),
                }),
              ),
          }),
          tool({
            name: "getIntegration",
            description:
              "Inspect an existing GraphQL integration, including its endpoint, auth templates, and registered operations. Use before reconfiguring with `graphql-greenfield.configureIntegration`.",
            inputSchema: StaticGetIntegrationInputStandardSchema,
            outputSchema: StaticGetIntegrationOutputStandardSchema,
            execute: (input) =>
              self
                .getIntegration((input as { slug: string }).slug)
                .pipe(Effect.map((integration) => ToolResult.ok({ integration }))),
          }),
          tool({
            name: "configureIntegration",
            description:
              "Reconfigure an existing GraphQL integration's endpoint, description, or auth templates. Does not re-introspect; existing connections keep their tools. Use `graphql-greenfield.addIntegration` (or `connections.refresh`) to re-derive tools from a new schema.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Configure a GraphQL integration",
            },
            inputSchema: StaticConfigureIntegrationInputStandardSchema,
            outputSchema: StaticConfigureIntegrationOutputStandardSchema,
            execute: (input) => {
              const { slug, ...patch } = input as ConfigureGraphqlIntegrationInput & {
                readonly slug: string;
              };
              return self
                .configureIntegration(slug, patch)
                .pipe(Effect.as(ToolResult.ok({ configured: true })));
            },
          }),
        ],
      },
    ],

    resolveTools: ({ config }) =>
      Effect.sync(() => {
        const parsed = integrationConfigFrom(config);
        if (parsed === null) return { tools: [] as readonly ToolDef[] };
        const tools: ToolDef[] = parsed.operations.map((op: OperationBinding) => {
          const annotations = annotationsFor(op);
          return {
            name: ToolName.make(op.toolName),
            ...(op.description ? { description: op.description } : {}),
            ...(op.inputSchema !== undefined ? { inputSchema: op.inputSchema } : {}),
            ...(annotations ? { annotations } : {}),
          };
        });
        return {
          tools,
          ...(parsed.definitions ? { definitions: parsed.definitions } : {}),
        };
      }),

    invokeTool: ({
      ctx,
      credential,
      toolRow,
      args,
    }: {
      ctx: PluginCtx<Record<string, never>>;
      credential: ToolInvocationCredential;
      toolRow: { name: string };
      args: unknown;
    }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const config = integrationConfigFrom(credential.config);
        if (config === null) {
          return yield* new GraphqlInvocationError({
            message: `No GraphQL configuration found for integration "${credential.integration}"`,
            statusCode: Option.none(),
          });
        }

        const op = config.operations.find(
          (candidate: OperationBinding) => candidate.toolName === toolRow.name,
        );
        if (!op) {
          return yield* new GraphqlInvocationError({
            message: `No GraphQL operation found for tool "${toolRow.name}"`,
            statusCode: Option.none(),
          });
        }

        if (credential.value === null) {
          return yield* new GraphqlAuthRequiredError({
            code: "oauth_connection_missing",
            owner: credential.owner,
            integration: String(credential.integration),
            connection: String(credential.connection),
            credentialKind: "oauth",
            credentialLabel: "GraphQL credential",
            message:
              `Missing credential value for GraphQL connection ` +
              `"${credential.connection}" on integration "${credential.integration}". ` +
              `Re-authenticate or update the connection before retrying this tool.`,
          });
        }

        const template = selectAuthTemplate(config.authentication, String(credential.template));
        const rendered = renderAuth(template, credential.value);

        const result = yield* invokeWithLayer(
          op,
          (args ?? {}) as Record<string, unknown>,
          config.endpoint,
          rendered.headers,
          rendered.queryParams,
          httpClientLayer,
        );

        const errors = decodeGraphqlErrors(result.errors);
        if (errors !== undefined && errors.length > 0) {
          const firstMessage = extractGraphqlErrorMessage(errors);
          return ToolResult.fail({
            code: "graphql_errors",
            message: firstMessage !== undefined ? firstMessage : "GraphQL request returned errors",
            details: { errors },
          });
        }
        if (result.status < 200 || result.status >= 300) {
          if (result.status === 401 || result.status === 403) {
            return authToolFailure({
              code: "connection_rejected",
              status: result.status,
              message:
                `Upstream rejected credentials for GraphQL integration ` +
                `"${credential.integration}" with HTTP ${result.status}. Re-authenticate or ` +
                `update the connection before retrying this tool.`,
              source: { id: String(credential.integration) },
              credential: { kind: "upstream", label: "Upstream authorization" },
              upstream: {
                status: result.status,
                details: {
                  data: result.data,
                  errors: result.errors,
                },
              },
              recovery: {
                configureSourceTool: "executor.graphql-greenfield.configureIntegration",
              },
            });
          }
          return ToolResult.fail({
            code: "graphql_http_error",
            status: result.status,
            message: `GraphQL request failed with HTTP ${result.status}`,
            details: {
              status: result.status,
              data: result.data,
              errors: result.errors,
            },
          });
        }
        return ToolResult.ok(result.data);
      }).pipe(
        Effect.catchTag("GraphqlAuthRequiredError", (error: GraphqlAuthRequiredError) =>
          Effect.succeed(graphqlAuthToolFailure(error)),
        ),
      ),

    detect: ({ ctx, url }: { ctx: PluginCtx<Record<string, never>>; url: string }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const trimmed = url.trim();
        if (!trimmed || !URL.canParse(trimmed)) return null;
        const parsedUrl = new URL(trimmed);

        const ok = yield* introspect(trimmed).pipe(
          Effect.provide(httpClientLayer),
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );

        const slug = slugFromEndpoint(trimmed);

        if (ok) {
          return {
            kind: "graphql",
            confidence: "high" as const,
            endpoint: trimmed,
            name: slug,
            slug,
          };
        }

        if (urlMatchesToken(parsedUrl, "graphql")) {
          return {
            kind: "graphql",
            confidence: "low" as const,
            endpoint: trimmed,
            name: slug,
            slug,
          };
        }

        return null;
      }),
  };
});
