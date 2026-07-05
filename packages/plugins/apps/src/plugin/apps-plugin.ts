import { Effect } from "effect";

import {
  definePlugin,
  ToolName,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type InvokeToolInput,
  type ToolDef,
} from "@executor-js/sdk";

import type { AppsRuntime } from "./runtime";
import { makeAppsStore } from "./store";
import type { Bindings } from "./bindings";

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

    // Declare the plugin's storage collection so the host provisions it.
    pluginStorage: {
      published_descriptor: {
        name: "published_descriptor",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
    },

    extension: () => ({ runtime }),

    // Per-connection tool production: project the published descriptor into
    // ToolDefs. Called at connection create/refresh; the SDK stamps addresses
    // and persists per connection.
    resolveTools: ({ connection }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        // The scope is the connection owner's tenant; for self-host single
        // tenant we key the descriptor by the connection's integration-scoped
        // name. We read the published descriptor for the scope encoded in the
        // connection name (`apps/<scope>`), falling back to the connection name.
        const scope = scopeFromConnection(connection.name);
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

    invokeTool: ({ toolRow, args }: InvokeToolInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const scope = scopeFromConnection(toolRow.connection);
        const descriptor = yield* runtime.getDescriptor(scope);
        const toolDesc = descriptor?.tools.find((t) => t.name === toolRow.name);
        const declared = toolDesc?.connections ?? {};
        const bindings = resolveBindings
          ? resolveBindings({ scope, tool: toolRow.name, declared })
          : defaultBindings(declared);
        return yield* runtime
          .invokeTool({ scope, tool: toolRow.name, args, bindings })
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

// Connection names encode the scope as `apps/<scope>` (or are the scope itself).
const scopeFromConnection = (connectionName: string): string => {
  const slash = connectionName.indexOf("/");
  return slash === -1 ? connectionName : connectionName.slice(slash + 1);
};
