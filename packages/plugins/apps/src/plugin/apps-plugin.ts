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

// ---------------------------------------------------------------------------
// The apps source plugin. Published custom tools become catalog citizens: the
// plugin registers one integration per scope (`apps`), and a connection to it
// makes the published tools resolvable + invocable like any catalog tool, so
// policy / approval / audit / toolkits / tools.list all apply unchanged.
//
// `resolveTools` projects the published descriptor into `ToolDef[]`.
// `invokeTool` bundles + runs the tool in the sandbox with connections bound.
// The plugin is thin: all logic lives in `AppsRuntime` (shared with the HTTP +
// MCP surfaces). The runtime is supplied via options because it owns the seam
// instances built at host boot.
// ---------------------------------------------------------------------------

export const APPS_INTEGRATION_SLUG = "apps";
export const APPS_PLUGIN_ID = "apps";

/** The scope a single-tenant self-host serves when the caller names none. */
const DEFAULT_CATALOG_SCOPE = "default";

export interface AppsPluginOptions {
  /** The shared runtime (seams + store). Built at host boot. */
  readonly runtime: AppsRuntime;
  /** How a tool's declared connection roles are bound to the caller's
   *  connections at invoke time. Self-host resolves these from the scope's
   *  configured connections; a default binds each role to a connection of the
   *  same name as the integration. */
  readonly resolveBindings?: (input: {
    readonly scope: string;
    readonly tool: string;
    readonly declared: Readonly<Record<string, { kind: string; integration?: string }>>;
  }) => Bindings;
  /** Build a per-request ClientResolver from the invoking executor context.
   *  This is how external integration calls route through the REAL per-request
   *  path (connections resolved by the invoking owner, credentials injected at
   *  the boundary), rather than the runtime's boot-time default resolver. The
   *  `ctx` is the plugin's per-request `PluginCtx`; the type is kept structural
   *  so this package does not depend on the host SDK's ctx shape. */
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
    } else if (decl.kind === "catalog") {
      // no binding
    } else {
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
    throw new Error("appsPlugin requires a `runtime` (built from the five seams at host boot)");
  }
  const runtime = options.runtime;
  const resolveBindings = options.resolveBindings;
  const makeResolver = options.makeResolver;

  // Resolve the scope a connection addresses (Fix 9). Prefer the EXPLICIT stored
  // mapping (recorded at connect time under the normalized name), which is exact
  // and collision-free. Only when no mapping was recorded (e.g. a legacy
  // connection created before the mapping existed) fall back to reverse-parsing
  // the name — the fragile path this replaces.
  const scopeFor = (connectionName: string): Effect.Effect<string> =>
    runtime.deps.store.getScopeForConnection(connectionName).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((mapped) => mapped ?? scopeFromConnection(connectionName)),
    );

  return {
    id: APPS_PLUGIN_ID as "apps",
    packageName: "@executor-js/plugin-apps",

    // The plugin's store facade is host-owned plugin storage + blobs; the apps
    // runtime already holds its own store, so this is a thin passthrough kept
    // for the ctx shape (extension methods read the runtime).
    storage: (deps): AppsStoreShape => {
      void makeAppsStore({
        pluginStorage: deps.pluginStorage,
        blobs: deps.blobs,
      });
      return { runtime };
    },

    // Declare the plugin's storage collections so the host provisions them.
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

    // A tiny built-in tool that wires the scope's published app into the
    // catalog: it registers the `apps` integration (idempotent) and creates the
    // `apps/<scope>` connection for the caller. After it runs, the scope's
    // published tools resolve as real catalog citizens (tools.list + execute
    // through the same policy/audit path). This runs with the REAL request-scoped
    // ctx (owner + core.integrations + connections), so it is the honest wiring
    // point rather than a boot-time singleton guess at the owner.
    staticSources: () => [
      {
        id: APPS_PLUGIN_ID,
        kind: "executor",
        name: "Apps",
        tools: [
          tool<AppsStoreShape>({
            name: "connect_catalog",
            description:
              "Wire this scope's published app into the tool catalog: registers the `apps` " +
              "integration and creates the apps/<scope> connection so published tools become " +
              "catalog citizens. Idempotent; call once per scope after publishing.",
            execute: (args, { ctx }) =>
              Effect.gen(function* () {
                // Single-tenant self-host serves one scope ("default"); a caller
                // may pass an explicit scope for other layouts.
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
                    description: "User-authored, published custom tools, workflows, ui and skills.",
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
                // Record the explicit connection-name -> scope mapping (Fix 9).
                // The executor normalizes connection names to identifiers, so we
                // record the mapping under BOTH the name we requested and its
                // normalized form (the name resolveTools/invokeTool actually
                // sees). This makes the scope lookup exact and collision-free:
                // "my-scope" and "my_scope" get DISTINCT stored mappings even if
                // a naive name-parse would collapse them.
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
          tool<AppsStoreShape>({
            name: "start_workflow",
            description:
              "Start a published workflow by name (manual start). Runs its durable body " +
              "with journal replay; `step.tool` external calls route through the caller's " +
              "connections. Returns the run view (status + output).",
            execute: (args, { ctx }) =>
              Effect.gen(function* () {
                const a = (args ?? {}) as {
                  workflow?: string;
                  scope?: string;
                  input?: unknown;
                  bindings?: Bindings;
                  runId?: string;
                };
                if (!a.workflow) {
                  return yield* Effect.fail(new Error("start_workflow requires a `workflow` name"));
                }
                const scope = a.scope ?? DEFAULT_CATALOG_SCOPE;
                // The per-request resolver (built from the invoking ctx) is what
                // lets the workflow's `step.tool` reach real integrations through
                // the caller's connections + credentials, rather than the runtime's
                // boot-time NotImplemented default.
                const resolver = makeResolver
                  ? makeResolver({ ctx, scope, tool: a.workflow })
                  : undefined;
                const run = yield* runtime
                  .startWorkflow({
                    scope,
                    workflow: a.workflow,
                    input: a.input ?? {},
                    bindings: a.bindings,
                    runId: a.runId,
                    resolver,
                  })
                  .pipe(Effect.mapError((cause) => new Error(cause.message)));
                return run;
              }),
          }),
        ],
      },
    ],

    // Per-connection tool production: project the published descriptor into
    // ToolDefs. Called at connection create/refresh; the SDK stamps addresses
    // and persists per connection.
    resolveTools: ({ connection }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        // The connection name encodes the scope via the formalized mapping
        // (`apps/<scope>`). A scope with no published app yet legitimately
        // resolves to ZERO tools (the connection exists before the first
        // publish), so an empty descriptor here is an intentional empty result,
        // not the silently-swallowed missing-tool case invokeTool guards against.
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
        // A missing descriptor / unknown tool is a typed error, NOT a silent
        // `?? {}` default: invoking a tool that is not published in the scope
        // must fail loudly rather than run with empty connections.
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
        // Build the per-request resolver from the invoking executor context so
        // external calls route through the real per-request path (connections +
        // credentials resolved at the boundary). Falls back to the runtime's
        // boot-time resolver when the host supplies no factory.
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

// ---------------------------------------------------------------------------
// Formalized scope <-> connection mapping.
//
// The executor normalizes every connection name to a JS identifier (camelCase,
// no slashes: `connectionIdentifier`). So an `apps/<scope>` form does NOT
// survive create -> the row is stored as `appsDefault`, and resolveTools would
// fail to recover the scope. The mapping is therefore identifier-native: the
// connection name is `apps` + PascalCase(scope), which round-trips through the
// normalizer unchanged. The inverse strips the `apps` prefix and lowercases the
// first character. Scopes are lowercase slugs (self-host single-tenant uses
// `default`), so `default <-> appsDefault` round-trips exactly. The legacy
// slash form (`apps/<scope>`) is still parsed for back-compat.
//
// This is the ONE place the mapping lives; resolveTools, invokeTool, and the
// host wiring all go through it.
// ---------------------------------------------------------------------------
export const APPS_CONNECTION_PREFIX = APPS_INTEGRATION_SLUG;

const pascal = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

/** The connection name that addresses a scope's published app. Identifier-safe,
 *  so it survives the executor's connection-name normalization unchanged. */
export const connectionNameForScope = (scope: string): string =>
  `${APPS_CONNECTION_PREFIX}${pascal(scope)}`;

/** The scope a connection name addresses (inverse of `connectionNameForScope`).
 *  Handles the identifier form (`appsDefault`), the legacy slash form
 *  (`apps/<scope>`), and a bare scope name. */
export const scopeFromConnection = (connectionName: string): string => {
  // Legacy slash form.
  if (connectionName.startsWith(`${APPS_INTEGRATION_SLUG}/`)) {
    return connectionName.slice(APPS_INTEGRATION_SLUG.length + 1);
  }
  // Identifier form: apps + PascalCase(scope).
  if (
    connectionName.startsWith(APPS_CONNECTION_PREFIX) &&
    connectionName.length > APPS_CONNECTION_PREFIX.length
  ) {
    const rest = connectionName.slice(APPS_CONNECTION_PREFIX.length);
    return `${rest[0]!.toLowerCase()}${rest.slice(1)}`;
  }
  // Bare name IS the scope.
  const slash = connectionName.indexOf("/");
  return slash === -1 ? connectionName : connectionName.slice(slash + 1);
};
