import { Effect, Option, Predicate, Schema } from "effect";

import {
  ScopeId,
  SourceDetectionResult,
  ToolResult,
  Usage,
  defaultSourceInstallScopeId,
  definePlugin,
  tool,
  resolveSecretBackedMap,
  type PluginCtx,
  type StaticToolSchema,
  type StorageFailure,
  type ToolAnnotations,
} from "@executor-js/sdk/core";

import {
  googleDiscoverySchema,
  makeGoogleDiscoveryStore,
  type GoogleDiscoveryStore,
} from "./binding-store";
import { googleDiscoveryPresets } from "./presets";
import { extractGoogleDiscoveryManifest } from "./document";
import { annotationsForOperation, invokeGoogleDiscoveryTool } from "./invoke";
import { GoogleDiscoveryParseError, GoogleDiscoverySourceError } from "./errors";
import {
  GoogleDiscoveryAuth,
  GoogleDiscoveryFetchCredentials,
  GoogleDiscoveryStoredSourceData as GoogleDiscoveryStoredSourceDataSchema,
  type GoogleDiscoveryManifest,
  type GoogleDiscoveryManifestMethod,
  type GoogleDiscoveryMethodBinding,
} from "./types";
import type { GoogleDiscoveryStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Upstream-error message extraction
// ---------------------------------------------------------------------------

const GOOGLE_BODY_CAP = 1024;
const UpstreamMessageBody = Schema.Struct({ message: Schema.String });
const UpstreamErrorMessageBody = Schema.Struct({ errorMessage: Schema.String });
const UpstreamNestedErrorBody = Schema.Struct({ error: UpstreamMessageBody });
const UpstreamErrorsArrayBody = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      detail: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
});

const decodeUpstreamMessageBody = Schema.decodeUnknownOption(UpstreamMessageBody);
const decodeUpstreamErrorMessageBody = Schema.decodeUnknownOption(UpstreamErrorMessageBody);
const decodeUpstreamNestedErrorBody = Schema.decodeUnknownOption(UpstreamNestedErrorBody);
const decodeUpstreamErrorsArrayBody = Schema.decodeUnknownOption(UpstreamErrorsArrayBody);

const googleClampedStringify = (value: unknown): string => {
  let s: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.stringify may throw on cycles; fall back to String() so the upstream body can still be surfaced as ToolError.details fallback text
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > GOOGLE_BODY_CAP ? `${s.slice(0, GOOGLE_BODY_CAP)}…` : s;
};

const firstNonEmpty = (...values: readonly (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value.length > 0);

const googleExtractUpstreamMessage = (body: unknown, status: number): string => {
  if (typeof body === "string") {
    return body.length > 0 ? body : `Upstream returned HTTP ${status}`;
  }
  const nested = Option.getOrUndefined(decodeUpstreamNestedErrorBody(body));
  const messageBody = Option.getOrUndefined(decodeUpstreamMessageBody(body));
  const errorMessageBody = Option.getOrUndefined(decodeUpstreamErrorMessageBody(body));
  const errorsBody = Option.getOrUndefined(decodeUpstreamErrorsArrayBody(body));
  const arrayMessage = errorsBody?.errors
    .map(({ detail, message: upstreamMessage, title }) =>
      firstNonEmpty(detail, upstreamMessage, title),
    )
    .find((message) => message !== undefined);
  const message = firstNonEmpty(
    nested?.error.message,
    messageBody?.message,
    errorMessageBody?.errorMessage,
    arrayMessage,
  );
  if (message !== undefined) return message;
  if (body !== null && typeof body === "object") {
    return googleClampedStringify(body);
  }
  return `Upstream returned HTTP ${status}`;
};

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

export interface GoogleDiscoveryProbeOperation {
  readonly toolPath: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly description: string | null;
}

export interface GoogleDiscoveryProbeResult {
  readonly name: string;
  readonly title: string | null;
  readonly service: string;
  readonly version: string;
  readonly toolCount: number;
  readonly scopes: readonly string[];
  readonly operations: readonly GoogleDiscoveryProbeOperation[];
}

export interface GoogleDiscoveryUpdateSourceInput {
  readonly name?: string;
  /** Rewrite the source's auth — typically after a successful
   *  re-authenticate, to point at a freshly minted Connection. */
  readonly auth?: GoogleDiscoveryAuth;
}

const GoogleDiscoveryProbeInputSchema = Schema.Struct({
  discoveryUrl: Schema.String,
  credentials: Schema.optional(GoogleDiscoveryFetchCredentials),
});

const GoogleDiscoveryProbeOutputSchema = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  service: Schema.String,
  version: Schema.String,
  toolCount: Schema.Number,
  scopes: Schema.Array(Schema.String),
  operations: Schema.Array(
    Schema.Struct({
      toolPath: Schema.String,
      method: Schema.String,
      pathTemplate: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
});

const GoogleDiscoveryAddSourceInputSchema = Schema.Struct({
  name: Schema.String,
  scope: Schema.String,
  discoveryUrl: Schema.String,
  credentials: Schema.optional(GoogleDiscoveryFetchCredentials),
  namespace: Schema.optional(Schema.String),
  auth: GoogleDiscoveryAuth,
});
const GoogleDiscoveryStaticAddSourceInputSchema = Schema.Struct({
  name: Schema.String,
  discoveryUrl: Schema.String,
  credentials: Schema.optional(GoogleDiscoveryFetchCredentials),
  namespace: Schema.optional(Schema.String),
  auth: GoogleDiscoveryAuth,
});
export type GoogleDiscoveryProbeInput = typeof GoogleDiscoveryProbeInputSchema.Type;
export type GoogleDiscoveryAddSourceInput = typeof GoogleDiscoveryAddSourceInputSchema.Type;

const GoogleDiscoveryAddSourceOutputSchema = Schema.Struct({
  namespace: Schema.String,
  source: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
  }),
  toolCount: Schema.Number,
});

const GoogleDiscoveryGetSourceInputSchema = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
});

const GoogleDiscoveryGetSourceOutputSchema = Schema.Struct({
  source: Schema.NullOr(Schema.Unknown),
});

const GoogleDiscoveryConfigureInputSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  auth: Schema.optional(GoogleDiscoveryAuth),
});
const GoogleDiscoveryConfigureSourceInputSchema = Schema.Struct({
  source: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
  }),
  ...GoogleDiscoveryConfigureInputSchema.fields,
});
const GoogleDiscoveryConfigureSourceOutputSchema = Schema.Struct({
  configured: Schema.Boolean,
});

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const GoogleDiscoveryProbeInputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryProbeInputSchema,
);
const GoogleDiscoveryProbeOutputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryProbeOutputSchema,
);
const GoogleDiscoveryAddSourceInputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryStaticAddSourceInputSchema,
);
const GoogleDiscoveryAddSourceOutputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryAddSourceOutputSchema,
);
const GoogleDiscoveryGetSourceInputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryGetSourceInputSchema,
);
const GoogleDiscoveryGetSourceOutputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryGetSourceOutputSchema,
);
const GoogleDiscoveryConfigureSourceInputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryConfigureSourceInputSchema,
);
const GoogleDiscoveryConfigureSourceOutputStandardSchema = schemaToStaticToolSchema(
  GoogleDiscoveryConfigureSourceOutputSchema,
);

const resolveStaticScopeInput = (
  ctx: { readonly scopes: readonly { readonly id: ScopeId; readonly name: string }[] },
  value: string,
): string =>
  String(
    ctx.scopes.find((scope) => scope.name === value || String(scope.id) === value)?.id ?? value,
  );

/**
 * Errors any Google Discovery extension method may surface.
 */
export type GoogleDiscoveryExtensionFailure =
  | GoogleDiscoveryParseError
  | GoogleDiscoverySourceError
  | StorageFailure;

// ---------------------------------------------------------------------------
// URL normalization + slug helpers (unchanged)
// ---------------------------------------------------------------------------

const DISCOVERY_SERVICE_HOST = "https://www.googleapis.com/discovery/v1/apis";
const decodeString = Schema.decodeUnknownSync(Schema.String);
const isGoogleDiscoverySourceError = (error: unknown): error is GoogleDiscoverySourceError =>
  Predicate.isTagged("GoogleDiscoverySourceError")(error);

const normalizeDiscoveryUrl = (discoveryUrl: string): string => {
  const trimmed = discoveryUrl.trim();
  if (trimmed.length === 0) return trimmed;
  if (!URL.canParse(trimmed)) return trimmed;
  const parsed = new URL(trimmed);
  if (parsed.pathname !== "/$discovery/rest") return trimmed;
  const version = parsed.searchParams.get("version")?.trim();
  if (!version) return trimmed;
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".googleapis.com")) return trimmed;
  const rawService = host.slice(0, -".googleapis.com".length);
  const service =
    rawService === "calendar-json"
      ? "calendar"
      : rawService.endsWith("-json")
        ? rawService.slice(0, -5)
        : rawService;
  if (!service) return trimmed;
  return `${DISCOVERY_SERVICE_HOST}/${service}/${version}/rest`;
};

const resolveGoogleDiscoveryCredentials = (
  credentials: GoogleDiscoveryFetchCredentials | undefined,
  ctx: PluginCtx<GoogleDiscoveryStore>,
): Effect.Effect<
  { headers?: Record<string, string>; queryParams?: Record<string, string> } | undefined,
  GoogleDiscoverySourceError
> =>
  Effect.gen(function* () {
    if (!credentials) return undefined;
    const headers = yield* resolveSecretBackedMap({
      values: credentials.headers,
      getSecret: ctx.secrets.get,
      onMissing: (name) =>
        new GoogleDiscoverySourceError({
          message: `Secret not found for header "${name}"`,
        }),
      onError: (_error, name) =>
        new GoogleDiscoverySourceError({
          message: `Secret not found for header "${name}"`,
        }),
    }).pipe(
      Effect.mapError((err) =>
        isGoogleDiscoverySourceError(err)
          ? err
          : new GoogleDiscoverySourceError({ message: "Secret resolution failed" }),
      ),
    );
    const queryParams = yield* resolveSecretBackedMap({
      values: credentials.queryParams,
      getSecret: ctx.secrets.get,
      onMissing: (name) =>
        new GoogleDiscoverySourceError({
          message: `Secret not found for query parameter "${name}"`,
        }),
      onError: (_error, name) =>
        new GoogleDiscoverySourceError({
          message: `Secret not found for query parameter "${name}"`,
        }),
    }).pipe(
      Effect.mapError((err) =>
        isGoogleDiscoverySourceError(err)
          ? err
          : new GoogleDiscoverySourceError({ message: "Secret resolution failed" }),
      ),
    );
    return {
      ...(headers ? { headers } : {}),
      ...(queryParams ? { queryParams } : {}),
    };
  });

const fetchDiscoveryDocument = (
  discoveryUrl: string,
  credentials?: {
    readonly headers?: Record<string, string>;
    readonly queryParams?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => {
        const url = new URL(normalizeDiscoveryUrl(discoveryUrl));
        for (const [key, value] of Object.entries(credentials?.queryParams ?? {})) {
          url.searchParams.set(key, value);
        }
        return fetch(url.toString(), {
          headers: credentials?.headers,
          signal: AbortSignal.timeout(20_000),
        });
      },
      catch: () =>
        new GoogleDiscoverySourceError({
          message: "Google Discovery fetch failed",
        }),
    });
    if (!response.ok) {
      return yield* new GoogleDiscoverySourceError({
        message: `Google Discovery fetch failed with status ${response.status}`,
      });
    }
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () =>
        new GoogleDiscoverySourceError({
          message: "Google Discovery response body read failed",
        }),
    });
  });

const normalizeSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const deriveNamespace = (input: { name: string; service: string; version: string }): string =>
  normalizeSlug(
    input.name || `google_${input.service}_${input.version.replace(/[^a-zA-Z0-9]+/g, "_")}`,
  ) || `google_${input.service}`;

// Connection refresh state is owned by the canonical `"oauth2"`
// ConnectionProvider registered by core. `ctx.oauth.start` stamps the
// Google-specific token endpoint + scopes onto the connection's
// providerState at mint time — no plugin-owned schema needed.

// ---------------------------------------------------------------------------
// Register a parsed manifest against the executor core + plugin storage.
// Runs inside a transaction.
// ---------------------------------------------------------------------------

const registerManifest = (
  ctx: PluginCtx<GoogleDiscoveryStore>,
  namespace: string,
  scope: string,
  manifest: GoogleDiscoveryManifest,
  sourceData: GoogleDiscoveryStoredSourceData,
) =>
  Effect.gen(function* () {
    yield* ctx.storage.removeBindingsBySource(namespace, scope);
    yield* ctx.core.sources.unregister({ id: namespace, targetScope: scope }).pipe(Effect.ignore);

    yield* ctx.core.sources.register({
      id: namespace,
      scope,
      kind: "googleDiscovery",
      name: sourceData.name,
      url: sourceData.rootUrl,
      canRemove: true,
      canRefresh: true,
      canEdit: true,
      tools: manifest.methods.map((method: GoogleDiscoveryManifestMethod) => ({
        name: method.toolPath,
        description: Option.getOrElse(
          method.description,
          () => `${method.binding.method.toUpperCase()} ${method.binding.pathTemplate}`,
        ),
        inputSchema: Option.getOrUndefined(method.inputSchema),
        outputSchema: Option.getOrUndefined(method.outputSchema),
      })),
    });

    if (Object.keys(manifest.schemaDefinitions).length > 0) {
      yield* ctx.core.definitions.register({
        sourceId: namespace,
        scope,
        definitions: manifest.schemaDefinitions,
      });
    }

    yield* Effect.forEach(
      manifest.methods,
      (method) =>
        ctx.storage.putBinding(`${namespace}.${method.toolPath}`, namespace, scope, method.binding),
      { discard: true },
    );

    yield* ctx.storage.putSource({
      namespace,
      scope,
      name: sourceData.name,
      config: sourceData,
    });

    return manifest.methods.length;
  });

const makeGoogleDiscoveryPluginExtension = (ctx: PluginCtx<GoogleDiscoveryStore>) => ({
  probeDiscovery: (input: string | GoogleDiscoveryProbeInput) =>
    Effect.gen(function* () {
      const discoveryUrl = typeof input === "string" ? input : input.discoveryUrl;
      const credentials =
        typeof input === "string"
          ? undefined
          : yield* resolveGoogleDiscoveryCredentials(input.credentials, ctx);
      const text = yield* fetchDiscoveryDocument(discoveryUrl, credentials);
      const manifest = yield* extractGoogleDiscoveryManifest(text);
      const scopes = Object.keys(
        Option.isSome(manifest.oauthScopes) ? manifest.oauthScopes.value : {},
      ).sort();
      const operations = manifest.methods.map((method) => ({
        toolPath: method.toolPath,
        method: method.binding.method,
        pathTemplate: method.binding.pathTemplate,
        description: Option.isSome(method.description) ? method.description.value : null,
      }));
      return {
        name: Option.isSome(manifest.title)
          ? manifest.title.value
          : `${manifest.service} ${manifest.version}`,
        title: Option.isSome(manifest.title) ? manifest.title.value : null,
        service: manifest.service,
        version: manifest.version,
        toolCount: manifest.methods.length,
        scopes,
        operations,
      };
    }),

  addSource: (input: GoogleDiscoveryAddSourceInput) =>
    ctx.transaction(
      Effect.gen(function* () {
        const credentials = yield* resolveGoogleDiscoveryCredentials(input.credentials, ctx);
        const text = yield* fetchDiscoveryDocument(input.discoveryUrl, credentials);
        const manifest = yield* extractGoogleDiscoveryManifest(text);
        const namespace =
          input.namespace ??
          deriveNamespace({
            name: input.name,
            service: manifest.service,
            version: manifest.version,
          });
        const sourceData = GoogleDiscoveryStoredSourceDataSchema.make({
          name: input.name,
          discoveryUrl: normalizeDiscoveryUrl(input.discoveryUrl),
          credentials: input.credentials,
          service: manifest.service,
          version: manifest.version,
          rootUrl: manifest.rootUrl,
          servicePath: manifest.servicePath,
          auth: input.auth,
        });
        const toolCount = yield* registerManifest(
          ctx,
          namespace,
          input.scope,
          manifest,
          sourceData,
        );
        return { toolCount, namespace };
      }),
    ),

  removeSource: (namespace: string, scope: string) =>
    ctx.transaction(
      Effect.gen(function* () {
        yield* ctx.storage.removeBindingsBySource(namespace, scope);
        yield* ctx.storage.removeSource(namespace, scope);
        yield* ctx.core.sources
          .unregister({ id: namespace, targetScope: scope })
          .pipe(Effect.ignore);
      }),
    ),

  // OAuth start/complete live on `ctx.oauth` now — the UI calls
  // the shared `/scopes/:scopeId/oauth/*` endpoints directly with a
  // Google-specific `authorization-code` strategy and writes the
  // resulting connection back via `updateSource`.

  getSource: (namespace: string, scope: string) => ctx.storage.getSource(namespace, scope),

  updateSource: (namespace: string, scope: string, input: GoogleDiscoveryUpdateSourceInput) =>
    ctx.storage.updateSourceMeta(namespace, scope, {
      name: input.name?.trim() || undefined,
      auth: input.auth,
    }),
});

export type GoogleDiscoveryPluginExtension = ReturnType<typeof makeGoogleDiscoveryPluginExtension>;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const googleDiscoveryPlugin = definePlugin(() => ({
  id: "googleDiscovery" as const,
  packageName: "@executor-js/plugin-google-discovery",
  sourcePresets: googleDiscoveryPresets,
  schema: googleDiscoverySchema,
  storage: (deps) => makeGoogleDiscoveryStore(deps),

  extension: makeGoogleDiscoveryPluginExtension,

  staticSources: (self) => [
    {
      id: "googleDiscovery",
      kind: "executor",
      name: "Google Discovery",
      tools: [
        tool({
          name: "probeDiscovery",
          description:
            "Preview a Google Discovery document before adding it as a source. Use this to inspect available operations and OAuth scopes. Do not collect Google OAuth client secrets in chat; create them with `executor.coreTools.secrets.create`, then start sign-in with `executor.coreTools.oauth.start`.",
          inputSchema: GoogleDiscoveryProbeInputStandardSchema,
          outputSchema: GoogleDiscoveryProbeOutputStandardSchema,
          execute: (input) => Effect.map(self.probeDiscovery(input), ToolResult.ok),
        }),
        tool({
          name: "addSource",
          description:
            'Add a Google Discovery source and register its operations as tools. Executor chooses the source install scope (local scope locally, organization scope in cloud) and returns it as `source`. Recommended flow: call `probeDiscovery`, create any OAuth client id/client secret values through `secrets.create` at the user\'s chosen credential scope, call `oauth.start` with `credentialScope` set to the user\'s chosen personal or organization credential scope for OAuth sources, then pass `{kind:"oauth2", connectionId, clientIdSecretId, clientSecretSecretId, scopes}` or `{kind:"none"}` here.',
          annotations: {
            requiresApproval: true,
            approvalDescription: "Add a Google Discovery source",
          },
          inputSchema: GoogleDiscoveryAddSourceInputStandardSchema,
          outputSchema: GoogleDiscoveryAddSourceOutputStandardSchema,
          execute: (input, { ctx }) => {
            const args = input as typeof GoogleDiscoveryStaticAddSourceInputSchema.Type;
            const sourceScope = defaultSourceInstallScopeId(ctx.scopes);
            if (sourceScope === null) {
              return Effect.succeed(
                ToolResult.fail({
                  code: "source_scope_unavailable",
                  message:
                    "Cannot add a Google Discovery source because this executor has no source install scope.",
                }),
              );
            }
            return Effect.map(self.addSource({ ...args, scope: sourceScope }), (result) =>
              ToolResult.ok({
                ...result,
                source: { id: result.namespace, scope: sourceScope },
              }),
            );
          },
        }),
        tool({
          name: "getSource",
          description:
            "Inspect an existing Google Discovery source, including discovery URL, service metadata, auth mode, OAuth scopes, connection id, and credential slots. Use this before repairing an existing source with `googleDiscovery.configureSource`, `secrets.create`, or `oauth.start`.",
          inputSchema: GoogleDiscoveryGetSourceInputStandardSchema,
          outputSchema: GoogleDiscoveryGetSourceOutputStandardSchema,
          execute: (input, { ctx }) => {
            const args = input as typeof GoogleDiscoveryGetSourceInputSchema.Type;
            return Effect.map(
              self.getSource(args.namespace, resolveStaticScopeInput(ctx, args.scope)),
              (source) => ToolResult.ok({ source }),
            );
          },
        }),
        tool({
          name: "configureSource",
          description:
            "Configure an existing Google Discovery source with concrete fields. Use `source` returned by `googleDiscovery.addSource` or `sources.list`. For OAuth, call `oauth.start` with the target `credentialScope` first, then pass the returned connection id and client secret ids through `auth`.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Configure a Google Discovery source",
          },
          inputSchema: GoogleDiscoveryConfigureSourceInputStandardSchema,
          outputSchema: GoogleDiscoveryConfigureSourceOutputStandardSchema,
          execute: (input, { ctx }) => {
            const { source, ...config } =
              input as typeof GoogleDiscoveryConfigureSourceInputSchema.Type;
            const sourceScope = resolveStaticScopeInput(ctx, source.scope);
            return Effect.as(
              self.updateSource(source.id, sourceScope, config),
              ToolResult.ok({ configured: true }),
            );
          },
        }),
      ],
    },
  ],

  sourceConfigure: {
    type: "googleDiscovery",
    schema: GoogleDiscoveryConfigureInputSchema,
    configure: ({ ctx, sourceId, sourceScope, config }) =>
      makeGoogleDiscoveryPluginExtension(ctx as PluginCtx<GoogleDiscoveryStore>).updateSource(
        sourceId,
        sourceScope,
        config as typeof GoogleDiscoveryConfigureInputSchema.Type,
      ),
  },

  invokeTool: ({ ctx, toolRow, args }) =>
    Effect.gen(function* () {
      const result = yield* invokeGoogleDiscoveryTool({
        ctx: ctx as PluginCtx<GoogleDiscoveryStore>,
        toolId: toolRow.id,
        toolScope: decodeString(toolRow.scope_id),
        args,
      });
      const ok = result.status >= 200 && result.status < 300;
      if (!ok) {
        return ToolResult.fail({
          code: "upstream_http_error",
          status: result.status,
          message: googleExtractUpstreamMessage(result.error, result.status),
          details: result.error,
        });
      }
      return ToolResult.ok({
        status: result.status,
        headers: result.headers,
        data: result.data,
      });
    }),

  resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const scopes = new Set<string>();
      for (const row of toolRows) scopes.add(decodeString(row.scope_id));
      const byScope = new Map<string, ReadonlyMap<string, GoogleDiscoveryMethodBinding>>();
      for (const scope of scopes) {
        const bindings = yield* typedCtx.storage.getBindingsForSource(sourceId, scope);
        byScope.set(scope, bindings);
      }
      const out: Record<string, ToolAnnotations> = {};
      for (const row of toolRows) {
        const binding = byScope.get(decodeString(row.scope_id))?.get(row.id);
        if (binding) {
          out[row.id] = annotationsForOperation(binding.method, binding.pathTemplate);
        }
      }
      return out;
    }),

  removeSource: ({ ctx, sourceId, scope }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      yield* typedCtx.storage.removeBindingsBySource(sourceId, scope);
      yield* typedCtx.storage.removeSource(sourceId, scope);
    }),

  // Aggregate usages across the auth columns and the credential child
  // tables. Each is one indexed SELECT in the store; the merge plus a
  // single source-name JOIN happens here.
  usagesForSecret: ({ ctx, args }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const sources = yield* typedCtx.storage.findSourcesBySecret(args.secretId);
      const childRows = yield* typedCtx.storage.findCredentialRowsBySecret(args.secretId);
      const sourceKeys = new Set<string>();
      for (const s of sources) sourceKeys.add(`${s.scope_id}:${s.namespace}`);
      for (const r of childRows) sourceKeys.add(`${r.scope_id}:${r.source_id}`);
      const names = yield* typedCtx.storage.lookupSourceNames([...sourceKeys]);

      const out: Usage[] = [];
      for (const s of sources) {
        out.push(
          Usage.make({
            pluginId: "google-discovery",
            scopeId: ScopeId.make(s.scope_id),
            ownerKind: "google-discovery-source",
            ownerId: s.namespace,
            ownerName: names.get(`${s.scope_id}:${s.namespace}`) ?? s.name,
            slot: s.slot,
          }),
        );
      }
      for (const r of childRows) {
        out.push(
          Usage.make({
            pluginId: "google-discovery",
            scopeId: ScopeId.make(r.scope_id),
            ownerKind: `google-discovery-source-${r.kind.replace(/_/g, "-")}`,
            ownerId: r.source_id,
            ownerName: names.get(`${r.scope_id}:${r.source_id}`) ?? null,
            slot: `${r.kind}:${r.name}`,
          }),
        );
      }
      return out;
    }),

  usagesForConnection: ({ ctx, args }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const sources = yield* typedCtx.storage.findSourcesByConnection(args.connectionId);
      return sources.map((s) =>
        Usage.make({
          pluginId: "google-discovery",
          scopeId: ScopeId.make(s.scope_id),
          ownerKind: "google-discovery-source",
          ownerId: s.namespace,
          ownerName: s.name,
          slot: s.slot,
        }),
      );
    }),

  detect: ({ url }) =>
    Effect.gen(function* () {
      const trimmed = url.trim();
      if (!trimmed) return null;
      const parsed = yield* Effect.try({
        try: () => new URL(trimmed),
        catch: (error) => error,
      }).pipe(Effect.option);
      if (Option.isNone(parsed)) return null;

      const isGoogleUrl = trimmed.includes("googleapis.com");
      const isDiscoveryPath = trimmed.includes("/discovery/") || trimmed.includes("$discovery");
      if (!isGoogleUrl && !isDiscoveryPath) return null;

      const discoveryText = yield* fetchDiscoveryDocument(trimmed).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!discoveryText) return null;

      const manifest = yield* extractGoogleDiscoveryManifest(discoveryText).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!manifest) return null;

      const name = Option.getOrElse(
        manifest.title,
        () => `${manifest.service} ${manifest.version}`,
      );

      return SourceDetectionResult.make({
        kind: "googleDiscovery",
        confidence: "high",
        endpoint: trimmed,
        name,
        namespace: deriveNamespace({
          name,
          service: manifest.service,
          version: manifest.version,
        }),
      });
    }),

  refreshSource: ({ ctx, sourceId, scope }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const existing = yield* typedCtx.storage.getSource(sourceId, scope);
      if (!existing) return;
      const credentials = yield* resolveGoogleDiscoveryCredentials(
        existing.config.credentials,
        typedCtx,
      );
      const text = yield* fetchDiscoveryDocument(existing.config.discoveryUrl, credentials);
      const manifest = yield* extractGoogleDiscoveryManifest(text);
      const next = GoogleDiscoveryStoredSourceDataSchema.make({
        ...existing.config,
        service: manifest.service,
        version: manifest.version,
        rootUrl: manifest.rootUrl,
        servicePath: manifest.servicePath,
      });
      yield* registerManifest(typedCtx, sourceId, scope, manifest, next);
    }),

  // Connection refresh is owned by the canonical `"oauth2"`
  // ConnectionProvider registered by core — no plugin-specific handler
  // needed. The Google-specific `GOOGLE_TOKEN_URL` lives on the
  // connection's providerState (stamped at `ctx.oauth.start` time with
  // the `authorization-code` strategy's tokenEndpoint), so refresh
  // reaches Google through the unified code path.

  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-google-discovery/api`.
  // Hosts that want the HTTP surface import the plugin from there;
  // SDK-only consumers stay on this entry and avoid the server-only deps.
}));
