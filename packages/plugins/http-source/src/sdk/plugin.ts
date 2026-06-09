import { Effect, type Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  IntegrationAlreadyExistsError,
  IntegrationSlug,
  ToolName,
  ToolResult,
  authToolFailure,
  definePlugin,
  type IntegrationConfig,
  type IntegrationDetectionResult,
  type InvokeToolInput,
  type PluginCtx,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type StorageFailure,
  type ToolDef,
} from "@executor-js/sdk";

import { HttpRequestError } from "./errors";
import { applyAuthTemplate, findAuthTemplate, requiredVariables } from "./template";
import { issueRequest } from "./request";
import {
  type Authentication,
  type HttpMethod,
  type HttpRequestArgs,
  type HttpSourceConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

export const HTTP_SOURCE_PLUGIN_ID = "http-source";
export const REQUEST_TOOL_NAME = ToolName.make("request");

// ---------------------------------------------------------------------------
// Config narrowing — core stores `IntegrationConfig` as an opaque blob; read it
// back into the http-source shape.
// ---------------------------------------------------------------------------

const asHttpConfig = (config: IntegrationConfig): HttpSourceConfig | null => {
  if (typeof config !== "object" || config === null) return null;
  const candidate = config as Partial<HttpSourceConfig>;
  if (typeof candidate.baseUrl !== "string") return null;
  if (!Array.isArray(candidate.authenticationTemplate)) return null;
  return {
    baseUrl: candidate.baseUrl,
    authenticationTemplate: candidate.authenticationTemplate as readonly Authentication[],
    defaultHeaders: candidate.defaultHeaders,
  };
};

// ---------------------------------------------------------------------------
// Auth-template merge — `configure` appends custom auth methods to the
// integration's existing `authenticationTemplate`. Mirrors the openapi plugin:
// a method whose slug matches an existing entry replaces it in place; a method
// with no usable slug is assigned a generated `custom_<id>` slug, collision-
// checked against the merged set.
// ---------------------------------------------------------------------------

const shortId = (): string => Math.random().toString(36).slice(2, 8);

const freshCustomSlug = (taken: ReadonlySet<string>): AuthTemplateSlug => {
  let candidate = `custom_${shortId()}`;
  while (taken.has(candidate)) candidate = `custom_${shortId()}`;
  return AuthTemplateSlug.make(candidate);
};

const mergeAuthenticationTemplate = (
  existing: readonly Authentication[],
  incoming: readonly Authentication[],
): readonly Authentication[] => {
  const result: Authentication[] = existing.map((entry: Authentication) => entry);
  const taken = new Set<string>(result.map((entry: Authentication) => String(entry.slug)));
  for (const entry of incoming) {
    // `slug` is branded as required, but JSON callers may omit it; read defensively.
    const rawSlug = (entry as { readonly slug?: unknown }).slug;
    const requested = typeof rawSlug === "string" ? rawSlug.trim() : "";
    const existingIndex = result.findIndex(
      (current: Authentication) => String(current.slug) === requested,
    );
    if (requested.length > 0 && existingIndex >= 0) {
      result[existingIndex] = entry;
      continue;
    }
    const slug =
      requested.length > 0 && !taken.has(requested)
        ? AuthTemplateSlug.make(requested)
        : freshCustomSlug(taken);
    taken.add(String(slug));
    result.push({ ...entry, slug } as Authentication);
  }
  return result;
};

// ---------------------------------------------------------------------------
// Argument coercion — the executor passes through `args: unknown`. Decode into
// the request envelope, tolerating loose shapes.
// ---------------------------------------------------------------------------

const decodeRequestArgs = (args: unknown): HttpRequestArgs | null => {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  if (typeof record.path !== "string") return null;
  const method =
    typeof record.method === "string" ? (record.method.toUpperCase() as HttpMethod) : undefined;
  return {
    method,
    path: record.path,
    query:
      typeof record.query === "object" && record.query !== null
        ? (record.query as Record<string, unknown>)
        : undefined,
    headers:
      typeof record.headers === "object" && record.headers !== null
        ? (record.headers as Record<string, string>)
        : undefined,
    body: record.body,
  };
};

// ---------------------------------------------------------------------------
// The generic `request` tool — identical per connection (raw HTTP has no spec),
// so `resolveTools` never needs `getValue`. The JSON schema is a literal so the
// plugin doesn't depend on a Schema→JSON-Schema conversion at runtime.
// ---------------------------------------------------------------------------

const REQUEST_INPUT_SCHEMA = {
  type: "object",
  properties: {
    method: {
      type: "string",
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      description: "HTTP method. Defaults to GET.",
    },
    path: {
      type: "string",
      description: "Path appended to the integration's base URL, or an absolute http(s) URL.",
    },
    query: {
      type: "object",
      additionalProperties: true,
      description: "Query string parameters.",
    },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Additional request headers.",
    },
    body: {
      description: "Request body. Objects are JSON-encoded; strings pass through.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const REQUEST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "number" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: {},
  },
  required: ["status", "headers", "body"],
} as const;

const requestToolDef = (baseUrl: string): ToolDef => ({
  name: REQUEST_TOOL_NAME,
  description: `Issue a raw HTTP request against ${baseUrl}.`,
  inputSchema: REQUEST_INPUT_SCHEMA,
  outputSchema: REQUEST_OUTPUT_SCHEMA,
  annotations: {
    // Raw HTTP can mutate; the executor's tool-policy layer can require approval
    // per address. We flag it conservatively.
    requiresApproval: true,
    approvalDescription: `Raw HTTP request to ${baseUrl}`,
  },
});

// ---------------------------------------------------------------------------
// Extension — the plugin's public API. `register` writes an http-source
// integration into the catalog with its opaque config.
// ---------------------------------------------------------------------------

export interface RegisterHttpIntegrationInput {
  readonly slug: IntegrationSlug;
  readonly description: string;
  readonly config: HttpSourceConfig;
  readonly canRemove?: boolean;
}

/** Add / merge custom auth methods onto an existing http-source integration's
 *  `authenticationTemplate`. Mirrors the openapi plugin's `configure`. */
export interface HttpSourceConfigureInput {
  readonly authenticationTemplate: readonly Authentication[];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const httpSourcePlugin = definePlugin(() => ({
  id: HTTP_SOURCE_PLUGIN_ID,
  packageName: "@executor-js/plugin-http-source",

  storage: () => ({}),

  // The extension's shape is inferred from this factory's return value;
  // `HttpSourceExtension` below is derived from it (no duplicated shape).
  extension: (ctx: PluginCtx) => ({
    register: (
      input: RegisterHttpIntegrationInput,
    ): Effect.Effect<void, IntegrationAlreadyExistsError | StorageFailure> =>
      Effect.gen(function* () {
        // Block re-adding an existing slug. The core `integrations.register`
        // primitive upserts (so boot re-registration is idempotent), but this
        // user-facing add must NOT silently clobber an existing integration's
        // tools, connections, and policies. To add more auth, update the
        // existing integration instead.
        const existing = yield* ctx.core.integrations.get(input.slug);
        if (existing) {
          return yield* new IntegrationAlreadyExistsError({ slug: input.slug });
        }
        yield* ctx.core.integrations.register({
          slug: input.slug,
          description: input.description,
          config: input.config,
          canRemove: input.canRemove ?? true,
          // Raw-HTTP tools are static per connection, but refresh is harmless
          // (re-stamps the same `request` tool), so allow it.
          canRefresh: true,
        });
      }),

    /** Read the integration's full opaque config (including its
     *  `authenticationTemplate`). Returns null when the integration is absent
     *  or its config isn't a valid http-source config. */
    getConfig: (slug: string): Effect.Effect<HttpSourceConfig | null, StorageFailure> =>
      ctx.core.integrations
        .get(IntegrationSlug.make(slug))
        .pipe(Effect.map((record) => (record ? asHttpConfig(record.config) : null))),

    /** Add / merge custom auth methods onto the integration's
     *  `authenticationTemplate`. Returns the resulting template array. */
    configure: (
      slug: string,
      input: HttpSourceConfigureInput,
    ): Effect.Effect<readonly Authentication[], StorageFailure> =>
      ctx.transaction(
        Effect.gen(function* () {
          const record = yield* ctx.core.integrations.get(IntegrationSlug.make(slug));
          if (!record) return [] as readonly Authentication[];
          const current = asHttpConfig(record.config);
          if (!current) return [] as readonly Authentication[];

          const merged = mergeAuthenticationTemplate(
            current.authenticationTemplate,
            input.authenticationTemplate,
          );

          const next: HttpSourceConfig = {
            ...current,
            authenticationTemplate: merged,
          };

          yield* ctx.core.integrations.update(IntegrationSlug.make(slug), {
            config: next satisfies HttpSourceConfig as IntegrationConfig,
          });

          return merged;
        }),
      ),
  }),

  // Per-connection tool production. Raw HTTP yields one generic `request` tool;
  // identical for every connection, so `getValue` is never called.
  resolveTools: (input: ResolveToolsInput): Effect.Effect<ResolveToolsResult, StorageFailure> =>
    Effect.sync(() => {
      const config = asHttpConfig(input.config);
      const baseUrl = config?.baseUrl ?? "the configured endpoint";
      return { tools: [requestToolDef(baseUrl)] };
    }),

  // Apply the resolved credential to the outbound request via the integration's
  // auth template (D11) and issue it.
  invokeTool: (input: InvokeToolInput): Effect.Effect<unknown, unknown> =>
    Effect.gen(function* () {
      const config = asHttpConfig(input.credential.config);
      if (config === null) {
        return ToolResult.fail({
          code: "http_config_invalid",
          message:
            "The http-source integration config is missing baseUrl / authenticationTemplate.",
          retryable: false,
        });
      }

      const args = decodeRequestArgs(input.args);
      if (args === null) {
        return ToolResult.fail({
          code: "invalid_arguments",
          message: "Expected a request with at least a `path` string.",
          retryable: false,
        });
      }

      // A selected auth template with any unresolved input means the credential
      // couldn't be resolved — surface a reauth-style failure keyed to the
      // connection (owner/integration/name), not a v1 slot. Checks every input the
      // template requires (e.g. both of Datadog's two keys), not just the primary.
      const selectedTemplate = findAuthTemplate(
        config.authenticationTemplate,
        input.credential.template,
      );
      if (selectedTemplate) {
        const missing = requiredVariables(selectedTemplate).filter((name) => {
          const value = input.credential.values[name];
          return value == null || value === "";
        });
        if (missing.length > 0) {
          return authToolFailure({
            code: "connection_value_missing",
            message: `No credential value resolved for connection "${input.credential.connection}" on integration "${input.credential.integration}".`,
            credential: {
              kind: "secret",
              label: String(input.credential.connection),
            },
          });
        }
      }

      const auth = applyAuthTemplate(
        config.authenticationTemplate,
        input.credential.template,
        input.credential.values,
      );

      const httpClientLayer: Layer.Layer<HttpClient.HttpClient> = input.ctx.httpClientLayer;

      const response = yield* issueRequest(
        {
          baseUrl: config.baseUrl,
          method: args.method ?? "GET",
          path: args.path,
          query: args.query,
          headers: args.headers,
          body: args.body,
          auth,
          defaultHeaders: config.defaultHeaders,
        },
        httpClientLayer,
      ).pipe(
        // `HttpRequestError` is a typed tagged error; reshape it into a
        // value-based `ToolResult` so transport failures surface as data.
        Effect.catchTag("HttpRequestError", (failure: HttpRequestError) =>
          Effect.succeed(
            ToolResult.fail({
              code: "http_request_failed",
              message: failure.message,
              retryable: true,
            }),
          ),
        ),
      );

      // `issueRequest` resolves to `HttpResponse`; on transport failure the
      // catch above replaced it with a `ToolResult`. Discriminate.
      return "ok" in response ? response : ToolResult.ok(response);
    }),

  // Raw HTTP claims any http(s) URL as a low-confidence fallback so onboarding
  // can offer it when no spec-derived plugin matches.
  detect: (input: {
    readonly ctx: PluginCtx;
    readonly url: string;
  }): Effect.Effect<IntegrationDetectionResult | null, never> =>
    Effect.sync(() => {
      if (!/^https?:\/\//i.test(input.url)) return null;
      let host: string;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL parsing of arbitrary onboarding input; fall back to the raw string
      try {
        host = new URL(input.url).host;
      } catch {
        host = input.url;
      }
      return {
        kind: HTTP_SOURCE_PLUGIN_ID,
        confidence: "low",
        endpoint: input.url,
        name: host,
        slug: host,
      };
    }),
}));

/** The plugin's extension API (`executor["http-source"]`) — derived from the
 *  inferred `extension` factory return so the shape isn't duplicated. */
export type HttpSourceExtension = ReturnType<
  NonNullable<ReturnType<typeof httpSourcePlugin>["extension"]>
>;
