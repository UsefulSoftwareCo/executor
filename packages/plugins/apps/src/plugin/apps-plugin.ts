import { Effect } from "effect";

import {
  definePlugin,
  tool,
  ToolName,
  IntegrationSlug,
  AuthTemplateSlug,
  connectionIdentifier,
  type ConnectionRef,
  type Owner,
  type PluginCtx,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type InvokeToolInput,
  type ToolDef,
} from "@executor-js/sdk";

import type { AppsRuntime } from "./runtime";
import { makeAppsStore } from "./store";
import type { ClientResolver, ConnectionCandidate } from "./bindings";
import type { IntegrationDecl, ToolDescriptor } from "../pipeline/descriptor";
import { syncGitHubSource, type GitHubSyncResult } from "../source/github-source";

export const APPS_INTEGRATION_SLUG = "apps";
export const APPS_PLUGIN_ID = "apps";

const DEFAULT_CATALOG_SCOPE = "default";

export interface AppsPluginOptions {
  readonly runtime: AppsRuntime;
  readonly makeResolver?: (input: {
    readonly ctx: unknown;
    readonly scope: string;
    readonly tool: string;
  }) => ClientResolver;
}

interface AppsStoreShape {
  readonly runtime: AppsRuntime;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const syncFailure = (message: string, path?: string): GitHubSyncResult => ({
  status: "failed",
  tools: [],
  skipped: [],
  errors: [
    {
      stage: "source",
      message,
      ...(path ? { diagnostics: [{ path, message }] } : {}),
    },
  ],
});

const sourceScopeFor = (input: { repo: string; connection: string }): string =>
  String(connectionIdentifier(`github ${input.connection} ${input.repo}`, "githubSource"));

const parseConnectionAddress = (address: string): ConnectionRef | null => {
  const parts = address.split(".");
  if (parts.length !== 4 || parts[0] !== "tools") return null;
  const [, integration, owner, name] = parts;
  if (!integration || !name) return null;
  if (owner !== "org" && owner !== "user") return null;
  return {
    owner: owner as Owner,
    integration: IntegrationSlug.make(integration),
    name: connectionIdentifier(name),
  };
};

const configBaseUrl = (config: unknown): string | undefined =>
  isRecord(config) && typeof config.baseUrl === "string" && config.baseUrl.length > 0
    ? config.baseUrl
    : undefined;

const projectInputSchema = (
  schema: unknown,
  integrations: Readonly<Record<string, IntegrationDecl>>,
  byRole: Readonly<Record<string, readonly ConnectionCandidate[]>>,
): unknown => {
  const base: Record<string, unknown> = isRecord(schema) ? { ...schema } : { type: "object" };
  const properties = isRecord(base.properties) ? { ...base.properties } : {};
  const required = new Set(
    Array.isArray(base.required)
      ? base.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  for (const [role, decl] of Object.entries(integrations)) {
    const addresses = unique((byRole[role] ?? []).map((c) => c.address));
    const roleSchema: Record<string, unknown> = {
      type: "string",
      enum: addresses,
      description: `Connection to use for ${role} (${decl.integration})`,
    };
    if (addresses.length === 1) {
      roleSchema.default = addresses[0];
      required.delete(role);
    } else {
      required.add(role);
    }
    properties[role] = roleSchema;
  }

  const projected: Record<string, unknown> = {
    ...base,
    type: typeof base.type === "string" ? base.type : "object",
    properties,
  };
  if (required.size > 0) projected.required = [...required];
  else delete projected.required;
  return projected;
};

export const appsPlugin = definePlugin((options?: AppsPluginOptions) => {
  if (!options?.runtime) {
    throw new Error("appsPlugin requires a runtime");
  }
  const runtime = options.runtime;
  const makeResolver = options.makeResolver;

  const scopeFor = (connectionName: string): Effect.Effect<string> =>
    runtime.deps.store.getScopeForConnection(connectionName).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((mapped) => mapped ?? scopeFromConnection(connectionName)),
    );

  const ensureCatalogConnection = (scope: string, ctx: PluginCtx<AppsStoreShape>) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(APPS_INTEGRATION_SLUG);
      const existing = yield* ctx.core.integrations
        .get(slug)
        .pipe(Effect.orElseSucceed(() => null));
      if (!existing) {
        yield* ctx.core.integrations.register({
          slug,
          name: "Apps",
          description: "User-authored, published custom tools.",
          config: {},
          canRemove: false,
          canRefresh: true,
        });
      }
      const rawName = connectionNameForScope(scope);
      const connName = connectionIdentifier(rawName);
      const conns = yield* ctx.connections
        .list({ integration: slug })
        .pipe(Effect.orElseSucceed(() => []));
      if (!conns.some((c) => String(c.name) === String(connName))) {
        yield* ctx.connections.create({
          owner: "user",
          name: connName,
          integration: slug,
          template: AuthTemplateSlug.make("none"),
          value: "",
        });
      }
      yield* runtime.deps.store
        .putScopeForConnection(String(rawName), scope)
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* runtime.deps.store
        .putScopeForConnection(String(connName), scope)
        .pipe(Effect.orElseSucceed(() => undefined));
      return {
        scope,
        connection: String(connName),
        ref: { owner: "user" as const, integration: slug, name: connName },
      };
    });

  return {
    id: APPS_PLUGIN_ID as "apps",
    packageName: "@executor-js/plugin-apps",

    storage: (deps): AppsStoreShape => {
      void makeAppsStore({
        pluginStorage: deps.pluginStorage,
      });
      return { runtime };
    },

    pluginStorage: {
      published_descriptor: {
        name: "published_descriptor",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
      apps_scope_connection: {
        name: "apps_scope_connection",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
    },

    extension: () => ({ runtime }),

    staticSources: () => [
      {
        id: APPS_PLUGIN_ID,
        kind: "executor",
        name: "Apps",
        tools: [
          tool<AppsStoreShape>({
            name: "connect_catalog",
            description:
              "Wire this scope's published custom tools into the tool catalog. " +
              "Idempotent; call once per scope after publishing.",
            execute: (args, { ctx }) =>
              Effect.gen(function* () {
                const scope =
                  (args as { scope?: string } | undefined)?.scope ?? DEFAULT_CATALOG_SCOPE;
                const connected = yield* ensureCatalogConnection(scope, ctx);
                return { scope, connection: connected.connection };
              }),
          }),
          tool<AppsStoreShape>({
            name: "sync_github_source",
            description: "Sync a GitHub repository containing custom tool source files.",
            execute: (args, { ctx }) =>
              Effect.gen(function* () {
                const payload = isRecord(args) ? args : {};
                const repo = typeof payload.repo === "string" ? payload.repo : "";
                const connection = typeof payload.connection === "string" ? payload.connection : "";
                const ref = typeof payload.ref === "string" ? payload.ref : undefined;
                const explicitScope = typeof payload.scope === "string" ? payload.scope : undefined;
                if (!repo) return syncFailure('sync_github_source requires "repo"');
                if (!connection) return syncFailure('sync_github_source requires "connection"');

                const sourceConnection = parseConnectionAddress(connection);
                if (!sourceConnection) {
                  return syncFailure(
                    `GitHub connection must be a connection address like tools.github.user.main; got "${connection}"`,
                    connection,
                  );
                }
                if (String(sourceConnection.integration) !== "github") {
                  return syncFailure(
                    `GitHub source sync requires a github connection; got "${sourceConnection.integration}"`,
                    connection,
                  );
                }
                const existing = yield* ctx.connections
                  .get(sourceConnection)
                  .pipe(Effect.orElseSucceed(() => null));
                if (!existing) return syncFailure(`GitHub connection not found: ${connection}`);
                const token = yield* ctx.connections
                  .resolveValue(sourceConnection)
                  .pipe(Effect.orElseSucceed(() => null));
                const integration = yield* ctx.core.integrations
                  .get(sourceConnection.integration)
                  .pipe(Effect.orElseSucceed(() => null));
                const scope = explicitScope ?? sourceScopeFor({ repo, connection });
                const result = yield* syncGitHubSource({
                  runtime,
                  scope,
                  repo,
                  ref,
                  token,
                  baseUrl: configBaseUrl(integration?.config),
                });
                if (result.status === "published") {
                  const catalog = yield* ensureCatalogConnection(scope, ctx);
                  yield* ctx.connections.refresh(catalog.ref).pipe(Effect.orElseSucceed(() => []));
                }
                return result;
              }),
          }),
        ],
      },
    ],

    resolveTools: ({ ctx, connection }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const scope = yield* scopeFor(String(connection.name));
        const descriptor = yield* runtime.getDescriptor(scope);
        if (!descriptor) return { tools: [] } satisfies ResolveToolsResult;
        const resolver =
          makeResolver && ctx ? makeResolver({ ctx, scope, tool: "*" }) : runtime.deps.resolver;
        const tools: ToolDef[] = [];
        for (const t of descriptor.tools) {
          const byRole: Record<string, readonly ConnectionCandidate[]> = {};
          for (const [role, decl] of Object.entries(t.integrations)) {
            byRole[role] = yield* resolver
              .listConnections({ integration: decl.integration })
              .pipe(Effect.orElseSucceed(() => []));
          }
          tools.push(projectTool(t, byRole));
        }
        return { tools } satisfies ResolveToolsResult;
      }),

    invokeTool: ({ ctx, toolRow, args, invokeOptions }: InvokeToolInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const scope = yield* scopeFor(String(toolRow.connection));
        const descriptor = yield* runtime.getDescriptor(scope);
        if (!descriptor) {
          return yield* Effect.fail(
            new Error(
              `apps scope "${scope}" has no published app (connection "${toolRow.connection}")`,
            ),
          );
        }
        const toolDesc = descriptor.tools.find((t) => t.name === toolRow.name);
        if (!toolDesc) {
          return yield* Effect.fail(
            new Error(`apps tool "${toolRow.name}" is not published in scope "${scope}"`),
          );
        }
        const resolver = makeResolver
          ? makeResolver({ ctx, scope, tool: toolRow.name })
          : undefined;
        return yield* runtime
          .invokeTool({ scope, tool: toolRow.name, args, resolver, invokeOptions })
          .pipe(
            Effect.mapError(
              (cause) =>
                new Error(
                  "message" in cause && typeof cause.message === "string"
                    ? cause.message
                    : "apps tool invocation failed",
                ),
            ),
          );
      }),
  };
});

const projectTool = (
  descriptor: ToolDescriptor,
  byRole: Readonly<Record<string, readonly ConnectionCandidate[]>>,
): ToolDef => ({
  name: ToolName.make(descriptor.name),
  description: descriptor.description,
  inputSchema: projectInputSchema(descriptor.inputSchema, descriptor.integrations, byRole),
  outputSchema: descriptor.outputSchema,
  annotations: {
    requiresApproval: descriptor.annotations?.destructive === true,
  },
});

export const APPS_CONNECTION_PREFIX = APPS_INTEGRATION_SLUG;

const pascal = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

export const connectionNameForScope = (scope: string): string =>
  `${APPS_CONNECTION_PREFIX}${pascal(scope)}`;

export const scopeFromConnection = (connectionName: string): string => {
  if (connectionName.startsWith(`${APPS_INTEGRATION_SLUG}/`)) {
    return connectionName.slice(APPS_INTEGRATION_SLUG.length + 1);
  }
  if (
    connectionName.startsWith(APPS_CONNECTION_PREFIX) &&
    connectionName.length > APPS_CONNECTION_PREFIX.length
  ) {
    const rest = connectionName.slice(APPS_CONNECTION_PREFIX.length);
    return `${rest[0]!.toLowerCase()}${rest.slice(1)}`;
  }
  const slash = connectionName.indexOf("/");
  return slash === -1 ? connectionName : connectionName.slice(slash + 1);
};
