import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

export const ScopeHandlers = HttpApiBuilder.group(ExecutorApi, "scope", (handlers) =>
  handlers.handle(
    "info",
    Effect.fn("scope.info")(function* () {
      return yield* capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // `id` / `name` / `dir` continue to point at the outermost scope so
          // existing clients keep their source writes org/workspace-scoped.
          // `stack` exposes the full innermost-first scope stack so the UI can
          // deliberately target per-user secret writes when binding credentials.
          const scope = executor.scopes.at(-1)!;
          return {
            id: scope.id,
            name: scope.name,
            dir: scope.name,
            stack: executor.scopes.map((entry) => ({
              id: entry.id,
              name: entry.name,
              dir: entry.name,
            })),
          };
        }),
      );
    }),
  ),
);
