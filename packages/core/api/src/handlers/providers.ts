import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { capture } from "@executor-js/api";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

export const ProvidersHandlers = HttpApiBuilder.group(ExecutorApi, "providers", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.providers.list();
        }),
      ),
    )
    .handle("items", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const entries = yield* executor.providers.items(path.key);
          return entries.map((entry) => ({ id: entry.id, name: entry.name }));
        }),
      ),
    ),
);
