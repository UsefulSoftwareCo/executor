import { Effect } from "effect";

import {
  definePlugin,
  tool,
  ToolName,
  ConnectionName,
  IntegrationSlug,
  AuthTemplateSlug,
  connectionIdentifier,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type InvokeToolInput,
  type ToolDef,
} from "@executor-js/sdk";

import type { AppsRuntime } from "./runtime";
import { makeAppsStore } from "./store";
import type { Bindings, ClientResolver } from "./bindings";

export const APPS_INTEGRATION_SLUG = "apps";
export const APPS_PLUGIN_ID = "apps";

const DEFAULT_CATALOG_SCOPE = "default";

export interface AppsPluginOptions {
  readonly runtime: AppsRuntime;
  readonly resolveBindings?: (input: {
    readonly scope: string;
    readonly tool: string;
    readonly declared: Readonly<Record<string, { kind: string; integration?: string }>>;
  }) => Bindings;
  readonly makeResolver?: (input: {
    readonly ctx: unknown;
    readonly scope: string;
    readonly tool: string;
  }) => ClientResolver;
}

const defaultBindings = (
  declared: Readonly<Record<string, { kind: string; integration?: string }>>,
): Bindings => {
  const out: Record<string, Bindings[string]> = {};
  for (const [role, decl] of Object.entries(declared)) {
    if (decl.kind === "array") {
      out[role] = { kind: "array", connections: [decl.integration ?? role] };
    } else if (decl.kind !== "catalog") {
      out[role] = { kind: "single", connection: decl.integration ?? role };
    }
  }
  return out;
};

interface AppsStoreShape {
  readonly runtime: AppsRuntime;
}

export const appsPlugin = definePlugin((options?: AppsPluginOptions) => {
  if (!options?.runtime) {
    throw new Error("appsPlugin requires a runtime");
  }
  const runtime = options.runtime;
  const resolveBindings = options.resolveBindings;
  const makeResolver = options.makeResolver;

  const scopeFor = (connectionName: string): Effect.Effect<string> =>
    runtime.deps.store.getScopeForConnection(connectionName).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((mapped) => mapped ?? scopeFromConnection(connectionName)),
    );

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
                const connName = ConnectionName.make(connectionNameForScope(scope));
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
                  .putScopeForConnection(String(connName), scope)
                  .pipe(Effect.orElseSucceed(() => undefined));
                const normalized = connectionIdentifier(String(connName));
                if (normalized !== String(connName)) {
                  yield* runtime.deps.store
                    .putScopeForConnection(normalized, scope)
                    .pipe(Effect.orElseSucceed(() => undefined));
                }
                return { scope, connection: String(connName) };
              }),
          }),
        ],
      },
    ],

    resolveTools: ({ connection }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const scope = yield* scopeFor(String(connection.name));
        const descriptor = yield* runtime.getDescriptor(scope);
        if (!descriptor) return { tools: [] } satisfies ResolveToolsResult;
        const tools: ToolDef[] = descriptor.tools.map((t) => ({
          name: ToolName.make(t.name),
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: {
            requiresApproval: t.annotations?.destructive === true,
          },
        }));
        return { tools } satisfies ResolveToolsResult;
      }),

    invokeTool: ({ ctx, toolRow, args }: InvokeToolInput<AppsStoreShape>) =>
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
        const declared = toolDesc.connections;
        const bindings = resolveBindings
          ? resolveBindings({ scope, tool: toolRow.name, declared })
          : defaultBindings(declared);
        const resolver = makeResolver
          ? makeResolver({ ctx, scope, tool: toolRow.name })
          : undefined;
        return yield* runtime
          .invokeTool({ scope, tool: toolRow.name, args, bindings, resolver })
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
