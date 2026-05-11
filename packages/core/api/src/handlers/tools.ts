import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { ToolId, ToolNotFoundError } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

export const ToolsHandlers = HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // Keep the all-tools view bounded to metadata already available
          // from discovery. Per-source detail loads annotations for the
          // smaller source-local management view.
          const tools = yield* executor.tools.list({
            includeAnnotations: false,
            includeBlocked: true,
          });
          return tools.map((t) => ({
            id: ToolId.make(t.id),
            pluginId: t.pluginId,
            sourceId: t.sourceId,
            name: t.name,
            description: t.description,
            mayElicit: t.annotations?.mayElicit,
            requiresApproval: t.annotations?.requiresApproval,
          }));
        }),
      ),
    )
    .handle("schema", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const schema = yield* executor.tools.schema(path.toolId);
          if (schema === null) {
            return yield* new ToolNotFoundError({ toolId: path.toolId });
          }
          return schema;
        }),
      ),
    ),
);
