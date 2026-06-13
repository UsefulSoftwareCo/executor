import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { IntegrationNotFoundError, type Integration } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const toResponse = (i: Integration) => ({
  slug: i.slug,
  name: i.name,
  description: i.description,
  kind: i.kind,
  canRemove: i.canRemove,
  canRefresh: i.canRefresh,
  authMethods: i.authMethods,
  ...(i.displayUrl ? { displayUrl: i.displayUrl } : {}),
});

export const IntegrationsHandlers = HttpApiBuilder.group(ExecutorApi, "integrations", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const integrations = yield* executor.integrations.list();
          return integrations.map(toResponse);
        }),
      ),
    )
    .handle("get", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const integration = yield* executor.integrations.get(path.slug);
          if (integration === null) {
            return yield* new IntegrationNotFoundError({ slug: path.slug });
          }
          return toResponse(integration);
        }),
      ),
    )
    .handle("update", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.integrations.update(path.slug, {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.description !== undefined ? { description: payload.description } : {}),
          });
          const integration = yield* executor.integrations.get(path.slug);
          if (integration === null) {
            return yield* new IntegrationNotFoundError({ slug: path.slug });
          }
          return toResponse(integration);
        }),
      ),
    )
    .handle("remove", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.integrations.remove(path.slug);
          return { removed: true };
        }),
      ),
    )
    .handle("detect", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const results = yield* executor.integrations.detect(payload.url.trim());
          return results.map((r) => ({
            kind: r.kind,
            confidence: r.confidence,
            endpoint: r.endpoint,
            name: r.name,
            slug: r.slug,
          }));
        }),
      ),
    ),
);
