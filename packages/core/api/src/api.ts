import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import type { HttpApiGroup } from "effect/unstable/httpapi";

import { ToolsApi } from "./tools/api";
import { IntegrationsApi } from "./integrations/api";
import { ConnectionsApi } from "./connections/api";
import { ProvidersApi } from "./providers/api";
import { ExecutionsApi } from "./executions/api";
import { OAuthApi } from "./oauth/api";
import { PoliciesApi } from "./policies/api";

export const CoreExecutorApi = HttpApi.make("executor")
  .add(ToolsApi)
  .add(IntegrationsApi)
  .add(ConnectionsApi)
  .add(ProvidersApi)
  .add(ExecutionsApi)
  .add(OAuthApi)
  .add(PoliciesApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "Executor API",
      description: "Tool execution platform API",
    }),
  );

/**
 * Compose the core API with a plugin group.
 */
export const addGroup = <G extends HttpApiGroup.Any>(group: G) => CoreExecutorApi.add(group);

/** Default API with no plugin groups */
export const ExecutorApi = CoreExecutorApi;
