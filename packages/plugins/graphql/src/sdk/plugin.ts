import { Effect, Match, Option, Schema } from "effect";
import type { Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import {
  authToolFailure,
  AuthTemplateSlug,
  definePlugin,
  IntegrationAlreadyExistsError,
  IntegrationDetectionResult,
  IntegrationSlug,
  mergeAuthTemplates,
  ToolName,
  ToolResult,
  type AuthMethodDescriptor,
  type AuthPlacementDescriptor,
  type IntegrationConfig,
  type IntegrationRecord,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
  type ToolDef,
} from "@executor-js/sdk/core";

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
  GraphqlIntrospectionError,
  GraphqlInvocationError,
} from "./errors";
import { invokeWithLayer } from "./invoke";
import { graphqlPresets } from "./presets";
import { makeDefaultGraphqlStore, type GraphqlStore, type StoredOperation } from "./store";
import {
  AuthTemplate,
  decodeGraphqlIntegrationConfig,
  decodeGraphqlIntegrationConfigOption,
  ExtractedField,
  GraphqlIntegrationConfig,
  OperationBinding,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// GraphQL error-body decoding (for invocation responses)
// ---------------------------------------------------------------------------

const GraphqlErrorBody = Schema.Struct({ message: Schema.String });
const GraphqlErrorsBody = Schema.Array(Schema.Unknown);
const decodeGraphqlErrorBody = Schema.decodeUnknownOption(GraphqlErrorBody);
const decodeGraphqlErrorsBody = Schema.decodeUnknownOption(GraphqlErrorsBody);

const decodeGraphqlErrors = (errors: unknown): readonly unknown[] | undefined =>
  Option.getOrUndefined(decodeGraphqlErrorsBody(errors));

const extractGraphqlErrorMessage = (errors: readonly unknown[]): string | undefined =>
  errors
    .map((error) => Option.getOrUndefined(decodeGraphqlErrorBody(error))?.message)
    .find((message) => message !== undefined && message.length > 0);

const GRAPHQL_PLUGIN_ID = "graphql";

// ---------------------------------------------------------------------------
// Extension input shapes
// ---------------------------------------------------------------------------

const AuthTemplateSchema = AuthTemplate;

/** Register a GraphQL integration in the catalog. `endpoint` is the GraphQL URL;
 *  `slug` (defaulted from the endpoint) is the catalog id; `introspectionJson`
 *  supplies the schema when the endpoint disables live introspection; `headers`
 *  / `queryParams` are static and also applied to add-time introspection;
 *  `authenticationTemplate` declares the auth methods a connection can apply
 *  through. */
const GraphqlAddIntegrationInputSchema = Schema.Struct({
  endpoint: Schema.String,
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthTemplateSchema)),
});
export type GraphqlAddIntegrationInput = typeof GraphqlAddIntegrationInputSchema.Type;

const GraphqlConfigureInputSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthTemplateSchema)),
});
export type GraphqlConfigureInput = typeof GraphqlConfigureInputSchema.Type;

/** Input for the custom-method-create flow (HTTP `POST /graphql/integrations/
 *  :slug/config`). Unlike `configure` (which REPLACES the whole config for the
 *  generic repair path), `configureAuth` MERGE-APPENDS these templates onto the
 *  integration's existing `authenticationTemplate`, mirroring OpenAPI's
 *  `configure`. */
const GraphqlConfigureAuthInputSchema = Schema.Struct({
  authenticationTemplate: Schema.Array(AuthTemplateSchema),
  mode: Schema.optional(Schema.Literals(["merge", "replace"])),
});
export type GraphqlConfigureAuthInput = typeof GraphqlConfigureAuthInputSchema.Type;

// ---------------------------------------------------------------------------
// Static control-tool schemas
// ---------------------------------------------------------------------------

const StaticAddIntegrationOutputSchema = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
});
const StaticGetIntegrationInputSchema = Schema.Struct({
  slug: Schema.String,
});
const StaticGetIntegrationOutputSchema = Schema.Struct({
  integration: Schema.NullOr(Schema.Unknown),
});

const StaticAddIntegrationInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(GraphqlAddIntegrationInputSchema),
);
const StaticAddIntegrationOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(StaticAddIntegrationOutputSchema),
);
const StaticGetIntegrationInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(StaticGetIntegrationInputSchema),
);
const StaticGetIntegrationOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(StaticGetIntegrationOutputSchema),
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
    source: { id: failure.integration, scope: failure.owner },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
      connectionId: failure.connection,
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
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Match `token` as a separator-bounded run inside a URL hostname or path,
 *  used as a low-confidence detection hint when introspection fails. */
const urlMatchesToken = (url: URL, token: string): boolean => {
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i");
  return re.test(url.hostname) || re.test(url.pathname);
};

/** Derive an integration slug from an endpoint URL. */
const slugFromEndpoint = (endpoint: string): string => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL construction throws; this helper intentionally falls back to the stable default slug
  try {
    const url = new URL(endpoint);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "graphql";
  }
};

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

// Name every generated operation: some servers reject anonymous operations, and
// APM tooling keys traces off the operation name. Field names are already valid
// GraphQL name tokens, so the upper-cased field name is a safe operation name.
const operationNameForField = (fieldName: string): string =>
  fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

const buildOperationStringForField = (
  kind: GraphqlOperationKind,
  field: IntrospectionField,
  types: ReadonlyMap<string, IntrospectionType>,
): string => {
  const opType = kind === "query" ? "query" : "mutation";
  const opName = operationNameForField(field.name);

  const varDefs = field.args.map((arg) => {
    const typeName = formatTypeRef(arg.type);
    return `$${arg.name}: ${typeName}`;
  });

  const argPasses = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const selectionSet = buildSelectionSet(field.type, types, 0, new Set());

  const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(", ")})` : "";
  const argPassStr = argPasses.length > 0 ? `(${argPasses.join(", ")})` : "";

  return `${opType} ${opName}${varDefsStr} { ${field.name}${argPassStr}${selectionSet ? ` ${selectionSet}` : ""} }`;
};

interface PreparedOperation {
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly binding: OperationBinding;
}

const prepareOperations = (
  fields: readonly ExtractedField[],
  introspection: IntrospectionResult,
): readonly PreparedOperation[] => {
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

  return fields.map((extracted) => {
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
      : `${extracted.kind} ${operationNameForField(extracted.fieldName)} { ${extracted.fieldName} }`;

    const binding = OperationBinding.make({
      kind: extracted.kind,
      fieldName: extracted.fieldName,
      operationString,
      variableNames: extracted.arguments.map((a) => a.name),
    });

    return {
      toolName,
      description,
      inputSchema: Option.getOrUndefined(extracted.inputSchema),
      binding,
    };
  });
};

const annotationsFor = (binding: OperationBinding): ToolAnnotations => {
  if (binding.kind === "mutation") {
    return {
      requiresApproval: true,
      approvalDescription: `mutation ${binding.fieldName}`,
    };
  }
  return {};
};

// ---------------------------------------------------------------------------
// Auth template rendering (D11) — apply the resolved credential value through
// the template the connection references, exactly like an apiKey bearer.
// ---------------------------------------------------------------------------

interface RenderedAuth {
  readonly headers: Record<string, string>;
  readonly queryParams: Record<string, string>;
}

const renderAuthTemplate = (template: AuthTemplate, value: string): RenderedAuth => {
  if (template.kind === "oauth2") {
    const header = template.header ?? "Authorization";
    const prefix = template.prefix ?? "Bearer ";
    return { headers: { [header]: `${prefix}${value}` }, queryParams: {} };
  }
  const rendered = template.prefix ? `${template.prefix}${value}` : value;
  if (template.in === "query") {
    return { headers: {}, queryParams: { [template.name]: rendered } };
  }
  return { headers: { [template.name]: rendered }, queryParams: {} };
};

// ---------------------------------------------------------------------------
// Introspection — produce operations from a config (live or stored JSON).
// ---------------------------------------------------------------------------

const buildToolDefs = (prepared: readonly PreparedOperation[]): readonly ToolDef[] =>
  prepared.map((p) => ({
    name: ToolName.make(p.toolName),
    description: p.description,
    inputSchema: p.inputSchema,
    annotations: annotationsFor(p.binding),
  }));

const toStoredOperations = (
  slug: IntegrationSlug,
  prepared: readonly PreparedOperation[],
): StoredOperation[] =>
  prepared.map((p) => ({
    toolName: p.toolName,
    integration: String(slug),
    binding: p.binding,
  }));

/** Render an integration's static + resolved-credential auth onto introspection
 *  headers/query params. Connection-create / tool-generation introspection runs
 *  with the connection's credential (exactly how its tools are invoked), so an
 *  auth-required endpoint introspects successfully here rather than at add-time. */
const introspectHeadersForConnection = (
  config: GraphqlIntegrationConfig,
  credentialValue: string | null,
  templateSlug: AuthTemplateSlug | null,
): RenderedAuth => {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const queryParams: Record<string, string> = { ...(config.queryParams ?? {}) };
  if (credentialValue !== null) {
    // Render the exact template the connection references; with no slug
    // (connection row not yet persisted) fall back to the first declared.
    const template =
      (templateSlug !== null
        ? config.authenticationTemplate.find((t: AuthTemplate) => t.slug === String(templateSlug))
        : undefined) ?? config.authenticationTemplate[0];
    if (template) {
      const rendered = renderAuthTemplate(template, credentialValue);
      Object.assign(headers, rendered.headers);
      Object.assign(queryParams, rendered.queryParams);
    }
  }
  return { headers, queryParams };
};

/** Introspect a config live or from its stored JSON, applying connection auth.
 *  `parseIntrospectionJson` short-circuits the network when a schema snapshot is
 *  present; otherwise this introspects the endpoint with the rendered credential. */
const introspectForConnection = (
  config: GraphqlIntegrationConfig,
  credentialValue: string | null,
  templateSlug: AuthTemplateSlug | null,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<IntrospectionResult, GraphqlIntrospectionError> => {
  if (config.introspectionJson) {
    return parseIntrospectionJson(config.introspectionJson);
  }
  const auth = introspectHeadersForConnection(config, credentialValue, templateSlug);
  return introspect(
    config.endpoint,
    Object.keys(auth.headers).length > 0 ? auth.headers : undefined,
    Object.keys(auth.queryParams).length > 0 ? auth.queryParams : undefined,
  ).pipe(Effect.provide(httpClientLayer));
};

/** Introspect an integration's endpoint (with this connection's credential),
 *  prepare its operations, persist the bindings, and return them. Invoked from
 *  `invokeTool` on a cache miss — i.e. when an integration was registered
 *  without an add-time schema and its bindings haven't been produced yet. */
const materializeOperations = (
  ctx: PluginCtx<GraphqlStore>,
  integration: string,
  config: GraphqlIntegrationConfig,
  credential: {
    readonly template: AuthTemplateSlug;
    readonly value: string | null;
  },
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<readonly StoredOperation[], GraphqlIntrospectionError | StorageFailure> =>
  Effect.gen(function* () {
    // Render the exact template this connection references (we have its slug
    // here, unlike `resolveTools`) so an auth-required endpoint introspects.
    const template = config.authenticationTemplate.find(
      (t: AuthTemplate) => t.slug === String(credential.template),
    );
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    const queryParams: Record<string, string> = {
      ...(config.queryParams ?? {}),
    };
    if (template && credential.value !== null) {
      const rendered = renderAuthTemplate(template, credential.value);
      Object.assign(headers, rendered.headers);
      Object.assign(queryParams, rendered.queryParams);
    }

    const introspection = config.introspectionJson
      ? yield* parseIntrospectionJson(config.introspectionJson)
      : yield* introspect(
          config.endpoint,
          Object.keys(headers).length > 0 ? headers : undefined,
          Object.keys(queryParams).length > 0 ? queryParams : undefined,
        ).pipe(Effect.provide(httpClientLayer));

    const { result } = yield* extract(introspection).pipe(
      Effect.catch(() =>
        Effect.succeed({
          result: { fields: [] as readonly ExtractedField[] },
        } as {
          readonly result: { readonly fields: readonly ExtractedField[] };
        }),
      ),
    );
    const prepared = prepareOperations(result.fields, introspection);
    const stored = toStoredOperations(IntegrationSlug.make(integration), prepared);
    yield* ctx.storage.replaceOperations(integration, stored);
    return stored;
  });

// ---------------------------------------------------------------------------
// Declared auth methods — project the stored `authenticationTemplate` into the
// catalog's plugin-agnostic `AuthMethodDescriptor[]`. Pure/sync and tolerant of
// a malformed or foreign config blob (returns `[]`). GraphQL has no accounts
// slot of its own, so this projection is what surfaces declared + custom methods
// through the catalog's `authMethods` to the hub / Add-account flows. Exported
// for tests.
//
//   apiKey → one apikey method carrying a single header/query placement (the
//            `name` from the template, with the template's `prefix` defaulted to
//            `""`).
//   oauth2 → one oauth method (no resolved endpoints; graphql renders the
//            connection value as a bearer at invoke time).
// ---------------------------------------------------------------------------

const graphqlApiKeyLabel = (placement: AuthPlacementDescriptor): string =>
  `API key (${placement.name || (placement.carrier === "header" ? "header" : "query")})`;

export const describeGraphqlAuthMethods = (
  record: IntegrationRecord,
): readonly AuthMethodDescriptor[] => {
  const config = Option.getOrUndefined(decodeGraphqlIntegrationConfigOption(record.config));
  if (!config) return [];
  return config.authenticationTemplate.map((template: AuthTemplate): AuthMethodDescriptor => {
    const slug = template.slug;
    if (template.kind === "oauth2") {
      return {
        id: slug,
        label: "OAuth",
        kind: "oauth",
        template: slug,
        oauth: {},
      };
    }
    const placement: AuthPlacementDescriptor = {
      carrier: template.in,
      name: template.name,
      prefix: template.prefix ?? "",
    };
    return {
      id: slug,
      label: graphqlApiKeyLabel(placement),
      kind: "apikey",
      template: slug,
      placements: [placement],
    };
  });
};

export const describeGraphqlIntegrationDisplay = (
  record: IntegrationRecord,
): { readonly url?: string } => {
  const config = Option.getOrUndefined(decodeGraphqlIntegrationConfigOption(record.config));
  return { url: config?.endpoint };
};

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

// The extension only registers integrations (and parses any pre-supplied
// introspection JSON offline). Live introspection — the only thing that needed
// an HTTP layer — is deferred to `resolveTools` / `invokeTool`, so the extension
// no longer takes one.
const makeGraphqlExtension = (ctx: PluginCtx<GraphqlStore>) => {
  const buildConfig = (input: GraphqlAddIntegrationInput): GraphqlIntegrationConfig =>
    GraphqlIntegrationConfig.make({
      endpoint: input.endpoint,
      name: input.name?.trim() || slugFromEndpoint(input.endpoint),
      ...(input.introspectionJson !== undefined
        ? { introspectionJson: input.introspectionJson }
        : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.queryParams !== undefined ? { queryParams: input.queryParams } : {}),
      authenticationTemplate: input.authenticationTemplate ?? [],
    });

  /** Register the integration in the catalog. Registering a source is a
   *  catalog statement ("we use this GraphQL endpoint now") and MUST NOT make a
   *  network call or require auth — exactly like MCP defers discovery. Live
   *  introspection (and the operation bindings it yields) is deferred to
   *  connection-create / tool-generation (`resolveTools`) and tool invocation
   *  (`invokeTool`), where a connection's credential is available.
   *
   *  When the caller pre-supplies `introspectionJson`, the schema is already in
   *  hand, so we parse it offline (no network) and persist the operation
   *  bindings up front. */
  const addIntegrationInternal = (input: GraphqlAddIntegrationInput) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(input.slug ?? slugFromEndpoint(input.endpoint));

      // Block re-adding an existing slug. The core `integrations.register`
      // primitive upserts (so boot re-registration is idempotent), but an
      // explicit add must NOT silently clobber an existing integration's tools,
      // connections, and policies. To add more auth, update the existing one.
      const existing = yield* ctx.core.integrations.get(slug);
      if (existing) {
        return yield* new IntegrationAlreadyExistsError({ slug });
      }

      return yield* addIntegrationTransaction(input, slug);
    });

  const addIntegrationTransaction = (input: GraphqlAddIntegrationInput, slug: IntegrationSlug) =>
    ctx.transaction(
      Effect.gen(function* () {
        const baseConfig = buildConfig(input);

        // No pre-supplied schema → register WITHOUT introspecting. Tools (and
        // their operation bindings) are produced lazily when a connection is
        // created (`resolveTools`) / a tool is first invoked (`invokeTool`),
        // using that connection's credential.
        if (baseConfig.introspectionJson === undefined) {
          yield* ctx.core.integrations.register({
            slug,
            description: baseConfig.name,
            config: baseConfig,
            canRemove: true,
            canRefresh: true,
          });
          return { slug: String(slug), name: baseConfig.name, toolCount: 0 };
        }

        // Pre-supplied introspection JSON: parse it offline (no network) and
        // persist the operation bindings + snapshot so production stays offline.
        const introspection = yield* parseIntrospectionJson(baseConfig.introspectionJson);
        const { result } = yield* extract(introspection);
        const prepared = prepareOperations(result.fields, introspection);

        // Snapshot the resolved schema so tool production never needs a live
        // HTTP layer (D6: tools are spec-derived and identical per connection).
        const config = GraphqlIntegrationConfig.make({
          ...baseConfig,
          introspectionJson: JSON.stringify({ data: introspection }),
        });

        yield* ctx.storage.replaceOperations(String(slug), toStoredOperations(slug, prepared));

        yield* ctx.core.integrations.register({
          slug,
          description: config.name,
          config,
          canRemove: true,
          canRefresh: true,
        });

        return {
          slug: String(slug),
          name: config.name,
          toolCount: prepared.length,
        };
      }),
    );

  const configureIntegration = (slug: string, input: GraphqlConfigureInput) =>
    Effect.gen(function* () {
      const record = yield* ctx.core.integrations.get(IntegrationSlug.make(slug));
      if (!record) return;
      const current = Option.getOrElse(
        // best-effort: re-decode the stored config, falling back to an
        // endpoint-only config if it was never set.
        yield* decodeGraphqlIntegrationConfig(record.config).pipe(Effect.option),
        () =>
          GraphqlIntegrationConfig.make({
            endpoint: "",
            name: record.description,
            authenticationTemplate: [],
          }),
      );

      const next = GraphqlIntegrationConfig.make({
        endpoint: input.endpoint ?? current.endpoint,
        name: input.name?.trim() || current.name,
        ...(current.introspectionJson !== undefined
          ? { introspectionJson: current.introspectionJson }
          : {}),
        ...((input.headers ?? current.headers) !== undefined
          ? { headers: input.headers ?? current.headers }
          : {}),
        ...((input.queryParams ?? current.queryParams) !== undefined
          ? { queryParams: input.queryParams ?? current.queryParams }
          : {}),
        authenticationTemplate: input.authenticationTemplate ?? current.authenticationTemplate,
      });

      yield* ctx.core.integrations.update(IntegrationSlug.make(slug), {
        description: next.name,
        config: next,
      });
    });

  /** Read the integration's decoded config (or `null` when absent / malformed).
   *  Surfaces `authenticationTemplate` for the configure / custom-method UX. */
  const getConfig = (
    slug: string,
  ): Effect.Effect<GraphqlIntegrationConfig | null, StorageFailure> =>
    ctx.core.integrations
      .get(IntegrationSlug.make(slug))
      .pipe(
        Effect.map((record) =>
          record ? Option.getOrNull(decodeGraphqlIntegrationConfigOption(record.config)) : null,
        ),
      );

  /** Merge-append custom auth methods onto the integration's existing
   *  `authenticationTemplate`. Returns the merged array. A no-op (returns `[]`)
   *  for an unknown slug or undecodable config. */
  const configureAuthMethods = (
    slug: string,
    input: GraphqlConfigureAuthInput,
  ): Effect.Effect<readonly AuthTemplate[], StorageFailure> =>
    ctx.transaction(
      Effect.gen(function* () {
        const record = yield* ctx.core.integrations.get(IntegrationSlug.make(slug));
        if (!record) return [] as readonly AuthTemplate[];
        const current = Option.getOrNull(decodeGraphqlIntegrationConfigOption(record.config));
        if (!current) return [] as readonly AuthTemplate[];

        const merged =
          input.mode === "replace"
            ? input.authenticationTemplate
            : mergeAuthTemplates(current.authenticationTemplate, input.authenticationTemplate);

        const next = GraphqlIntegrationConfig.make({
          ...current,
          authenticationTemplate: merged,
        });

        yield* ctx.core.integrations.update(IntegrationSlug.make(slug), {
          config: next,
        });

        return merged;
      }),
    );

  return {
    /** Register a GraphQL integration (introspects + persists operations). */
    addIntegration: (input: GraphqlAddIntegrationInput) => addIntegrationInternal(input),

    /** Read the integration's stored config. */
    getIntegration: (slug: string) =>
      ctx.core.integrations
        .get(IntegrationSlug.make(slug))
        .pipe(Effect.map((record) => (record ? record.config : null))),

    /** Read the integration's decoded config (auth templates surfaced). */
    getConfig,

    /** Merge-append custom auth methods (custom-method-create flow). */
    configureAuth: configureAuthMethods,

    removeIntegration: (slug: string) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.removeOperations(slug);
          yield* ctx.core.integrations
            .remove(IntegrationSlug.make(slug))
            .pipe(Effect.catchTag("IntegrationRemovalNotAllowedError", () => Effect.void));
        }),
      ),

    configure: configureIntegration,
  };
};

export type GraphqlPluginExtension = ReturnType<typeof makeGraphqlExtension>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface GraphqlPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}

export const graphqlPlugin = definePlugin((options?: GraphqlPluginOptions) => {
  return {
    id: GRAPHQL_PLUGIN_ID as "graphql",
    packageName: "@executor-js/plugin-graphql",
    integrationPresets: graphqlPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      summary: preset.summary,
      url: preset.url,
      endpoint: preset.endpoint,
      ...(preset.icon ? { icon: preset.icon } : {}),
      ...(preset.featured ? { featured: preset.featured } : {}),
    })),
    storage: (deps): GraphqlStore => makeDefaultGraphqlStore(deps),

    extension: (ctx: PluginCtx<GraphqlStore>) => makeGraphqlExtension(ctx),

    integrationConfigure: {
      type: "graphql",
      schema: GraphqlConfigureInputSchema,
      configure: ({ ctx, integration, config }) =>
        makeGraphqlExtension(ctx).configure(String(integration), config as GraphqlConfigureInput),
    },

    describeAuthMethods: describeGraphqlAuthMethods,
    describeIntegrationDisplay: describeGraphqlIntegrationDisplay,

    staticSources: (self: GraphqlPluginExtension) => [
      {
        id: "graphql",
        kind: "executor",
        name: "GraphQL",
        tools: [
          {
            name: "getIntegration",
            description:
              "Inspect an existing GraphQL integration, including endpoint, static headers/query params, and auth templates. Use this before repairing an integration with `graphql.configure` or creating a connection.",
            inputSchema: StaticGetIntegrationInputStandardSchema,
            outputSchema: StaticGetIntegrationOutputStandardSchema,
            handler: ({ args }) => {
              const input = args as typeof StaticGetIntegrationInputSchema.Type;
              return Effect.map(self.getIntegration(input.slug), (integration) =>
                ToolResult.ok({ integration }),
              );
            },
          },
          {
            name: "addIntegration",
            description:
              "Add a GraphQL endpoint to the catalog and register its operations. Introspects the endpoint (or uses provided introspection JSON). After adding, create an owner-scoped connection against the integration to materialize its per-connection tools. For API keys / bearer tokens, declare an `authenticationTemplate` and create a connection whose value is the token.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add a GraphQL integration",
            },
            inputSchema: StaticAddIntegrationInputStandardSchema,
            outputSchema: StaticAddIntegrationOutputStandardSchema,
            handler: ({ args }) => {
              const input = args as GraphqlAddIntegrationInput;
              return self.addIntegration(input).pipe(
                Effect.map((result) => ToolResult.ok({ slug: result.slug, name: result.name })),
                Effect.catchTags({
                  GraphqlIntrospectionError: ({ message }) =>
                    Effect.succeed(graphqlToolFailure("graphql_introspection_failed", message)),
                  GraphqlExtractionError: ({ message }) =>
                    Effect.succeed(graphqlToolFailure("graphql_extraction_failed", message)),
                  IntegrationAlreadyExistsError: ({ slug }: IntegrationAlreadyExistsError) =>
                    Effect.succeed(
                      graphqlToolFailure(
                        "integration_already_exists",
                        `Integration ${slug} already exists; update it instead of re-adding.`,
                      ),
                    ),
                }),
              );
            },
          },
        ],
      },
    ],

    // -----------------------------------------------------------------------
    // Per-connection tool production. THIS is where a GraphQL integration is
    // introspected — when a connection is created (or refreshed), with that
    // connection's credential — yielding one ToolDef per operation. Registering
    // the integration in the catalog makes no network call; discovery is
    // deferred to here, exactly how MCP defers tool discovery to connect time.
    // The introspected schema is identical across connections, so `invokeTool`
    // re-derives the same operation bindings; only the credential differs.
    // -----------------------------------------------------------------------
    resolveTools: ({
      config,
      template,
      getValue,
    }: {
      readonly config: IntegrationConfig;
      readonly template: AuthTemplateSlug | null;
      readonly getValue: () => Effect.Effect<string | null, unknown>;
    }) =>
      Effect.gen(function* () {
        const decoded = yield* decodeGraphqlIntegrationConfig(config).pipe(Effect.option);
        if (Option.isNone(decoded)) return { tools: [] };
        const graphqlConfig = decoded.value;
        // Live introspection (no stored snapshot) needs the connection's
        // credential for auth-required endpoints; resolve it lazily.
        const credentialValue =
          graphqlConfig.introspectionJson === undefined
            ? yield* getValue().pipe(Effect.catch(() => Effect.succeed(null)))
            : null;
        const introspection = yield* introspectForConnection(
          graphqlConfig,
          credentialValue,
          template,
          options?.httpClientLayer ?? httpClientLayerFallback,
        ).pipe(Effect.option);
        if (Option.isNone(introspection)) return { tools: [] };
        const extracted = yield* extract(introspection.value).pipe(Effect.option);
        if (Option.isNone(extracted)) return { tools: [] };
        const prepared = prepareOperations(extracted.value.result.fields, introspection.value);
        return {
          tools: buildToolDefs(prepared),
          definitions: extracted.value.definitions,
        };
      }).pipe(Effect.catch(() => Effect.succeed({ tools: [] as readonly ToolDef[] }))),

    // -----------------------------------------------------------------------
    // Invoke one of a connection's tools. Look up the operation by integration
    // + tool name, render the credential through the connection's auth
    // template, and execute the GraphQL request.
    // -----------------------------------------------------------------------
    invokeTool: ({ ctx, toolRow, credential, args }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const integration = toolRow.integration;
        const toolName = toolRow.name;

        const config = yield* decodeGraphqlIntegrationConfig(credential.config).pipe(
          Effect.mapError(
            () =>
              new GraphqlInvocationError({
                message: `Invalid GraphQL integration config for "${integration}"`,
                statusCode: Option.none(),
              }),
          ),
        );

        // Operation bindings are produced lazily for integrations registered
        // without an add-time schema (no network at catalog registration). On a
        // cache miss, introspect with this connection's credential, persist the
        // bindings, then resolve the requested tool — discovery/persistence are
        // deferred to first use, mirroring MCP.
        let op = yield* ctx.storage.getOperation(integration, toolName);
        if (!op) {
          op = yield* materializeOperations(
            ctx,
            integration,
            config,
            credential,
            httpClientLayer,
          ).pipe(Effect.map((ops) => ops.find((o) => o.toolName === toolName) ?? null));
        }
        if (!op) {
          return yield* new GraphqlInvocationError({
            message: `No GraphQL operation found for tool "${integration}.${toolName}"`,
            statusCode: Option.none(),
          });
        }

        const headers: Record<string, string> = { ...(config.headers ?? {}) };
        const queryParams: Record<string, string> = {
          ...(config.queryParams ?? {}),
        };

        const template = config.authenticationTemplate.find(
          (t: AuthTemplate) => t.slug === String(credential.template),
        );
        if (template) {
          if (credential.value === null) {
            return yield* new GraphqlAuthRequiredError({
              code:
                template.kind === "oauth2"
                  ? "oauth_connection_missing"
                  : "connection_value_missing",
              message:
                template.kind === "oauth2"
                  ? `Missing OAuth connection value for GraphQL integration "${integration}" (connection "${credential.connection}")`
                  : `Missing credential value for GraphQL integration "${integration}" (connection "${credential.connection}")`,
              owner: credential.owner,
              integration,
              connection: String(credential.connection),
              credentialKind: template.kind === "oauth2" ? "oauth" : "secret",
              credentialLabel: template.kind === "oauth2" ? "OAuth sign-in" : "API key",
              template: String(credential.template),
            });
          }
          const rendered = renderAuthTemplate(template, credential.value);
          Object.assign(headers, rendered.headers);
          Object.assign(queryParams, rendered.queryParams);
        }

        const result = yield* invokeWithLayer(
          op.binding,
          (args ?? {}) as Record<string, unknown>,
          config.endpoint,
          headers,
          queryParams,
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
              message: `Upstream rejected credentials for GraphQL integration "${integration}" with HTTP ${result.status}. Re-authenticate or update the connection before retrying this tool.`,
              source: { id: integration, scope: credential.owner },
              credential: { kind: "upstream", label: "Upstream authorization" },
              upstream: {
                status: result.status,
                details: {
                  data: result.data,
                  errors: result.errors,
                },
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
        Effect.catchTag("GraphqlAuthRequiredError", (error) =>
          Effect.succeed(graphqlAuthToolFailure(error)),
        ),
      ),

    // Per-connection cleanup. Operation bindings are catalog-level (shared
    // across an integration's connections), so removing a single connection
    // leaves them in place; the executor drops the connection's tool rows.
    removeConnection: () => Effect.void,

    detect: ({ ctx, url }: { readonly ctx: PluginCtx<GraphqlStore>; readonly url: string }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const trimmed = url.trim();
        if (!trimmed) return null;
        const parsed = yield* Effect.try({
          try: () => new URL(trimmed),
          catch: (cause) => cause,
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) return null;

        const ok = yield* introspect(trimmed).pipe(
          Effect.provide(httpClientLayer),
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );

        const slug = slugFromEndpoint(trimmed);

        if (ok) {
          return IntegrationDetectionResult.make({
            kind: "graphql",
            confidence: "high",
            endpoint: trimmed,
            name: slug,
            slug,
          });
        }

        // Low-confidence URL-token fallback. Introspection can fail for many
        // reasons (auth, CORS, the endpoint disabled introspection, transport
        // errors). When the URL itself strongly implies GraphQL, surface a
        // candidate so the user can still pick it.
        if (urlMatchesToken(parsed.value, "graphql")) {
          return IntegrationDetectionResult.make({
            kind: "graphql",
            confidence: "low",
            endpoint: trimmed,
            name: slug,
            slug,
          });
        }

        return null;
      }),
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by the
  // api-aware factory in `@executor-js/plugin-graphql/api`.
});

// The fallback HTTP layer for `resolveTools`. The hook input carries no `ctx`,
// so when no explicit layer is passed to the plugin we use the same default the
// executor wires into `ctx.httpClientLayer` (`FetchHttpClient.layer`). Hosts/
// tests that need a custom transport pass `options.httpClientLayer`.
const httpClientLayerFallback: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer;
