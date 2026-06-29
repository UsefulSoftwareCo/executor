import { Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
} from "@executor-js/api/server";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import executorConfig from "../executor.config";
import { SelfHostDb, SelfHostDbProvider } from "./db/self-host-db";
import { loadConfig } from "./config";

// ---------------------------------------------------------------------------
// Self-host execution-stack seams.
//
// The shared `makeExecutionStack` (@executor-js/api/server) owns the body:
//   makeScopedExecutor -> createExecutionEngine -> EngineDecorator.decorate.
// Self-host just supplies the five seam Layers it reads from. Differences from
// cloud: the QuickJS in-process code substrate (vs the Cloudflare dynamic
// worker) and a NO-OP engine decorator (no usage metering).
//
//   - DbProvider          -> SelfHostDbProvider: projects the long-lived
//                            libSQL handle (built once at boot, see db/). The
//                            shared factory reads `db` per request without
//                            caching, so the long-lived lifetime is preserved.
//   - PluginsProvider      -> fresh `executor.config.ts#plugins()` per call,
//                            matching per-request plugin instances (avoids
//                            cross-request plugin state).
//   - HostConfig           -> `{ allowLocalNetwork, webBaseUrl }` from
//                            `loadConfig()`.
//   - CodeExecutorProvider -> `makeQuickJsExecutor()`.
//   - EngineDecorator      -> no-op (self-host does not meter executions).
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";

export const SelfHostPluginsProvider: Layer.Layer<PluginsProvider> = Layer.succeed(PluginsProvider)(
  {
    plugins: (context) =>
      executorConfig.plugins({
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
      }),
  },
);

export const SelfHostHostConfig: Layer.Layer<HostConfig> = Layer.sync(HostConfig, () => {
  const config = loadConfig();
  return {
    allowLocalNetwork: config.allowLocalNetwork,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
  };
});

export const SelfHostCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => makeQuickJsExecutor(),
);

/**
 * The `makeScopedExecutor` seams (`DbProvider` + `PluginsProvider` +
 * `HostConfig`) over the long-lived `SelfHostDb`. Shared between the production
 * `SelfHostExecutionStackLayer` and the `makeScopedExecutor` test entrypoint.
 */
export const SelfHostScopedExecutorSeams: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig,
  never,
  SelfHostDb
> = Layer.mergeAll(SelfHostDbProvider, SelfHostPluginsProvider, SelfHostHostConfig);

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer. Requires the long-lived `SelfHostDb` (provided once at
 * boot); the per-request executor only varies the scope stack.
 */
export const SelfHostExecutionStackLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
  never,
  SelfHostDb
> = Layer.mergeAll(SelfHostScopedExecutorSeams, SelfHostCodeExecutorProvider, EngineDecoratorNoop);
