import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { DelegationForbiddenError, ToolNotFoundError, type Tool } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const toMetadata = (t: Tool) => ({
  address: t.address,
  owner: t.owner,
  integration: t.integration,
  connection: t.connection,
  name: t.name,
  pluginId: t.pluginId,
  description: t.description,
  mayElicit: t.annotations?.mayElicit,
  requiresApproval: t.annotations?.requiresApproval,
  approvalDescription: t.annotations?.approvalDescription,
  static: t.static,
});

export const ToolsHandlers = HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tools = yield* executor.tools
            .list({
              integration: query.integration,
              owner: query.owner,
              connection: query.connection,
              query: query.query,
              includeAnnotations: query.includeAnnotations === "true",
              includeBlocked: query.includeBlocked !== "false",
            })
            .pipe(
              Effect.catchTag("DelegationDeniedError", () =>
                Effect.fail(
                  new DelegationForbiddenError({
                    message: "Delegated credential is not authorized for this operation.",
                  }),
                ),
              ),
            );
          return tools.map(toMetadata);
        }),
      ),
    )
    .handle("schema", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const schema = yield* executor.tools.schema(query.address).pipe(
            Effect.catchTag("DelegationDeniedError", () =>
              Effect.fail(
                new DelegationForbiddenError({
                  message: "Delegated credential is not authorized for this operation.",
                }),
              ),
            ),
          );
          if (schema === null) {
            return yield* new ToolNotFoundError({ address: query.address });
          }
          return schema;
        }),
      ),
    ),
);
