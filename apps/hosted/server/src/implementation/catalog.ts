import type { HostedApiDocument } from "../contracts/api.ts";
/** Supply shared catalog reads and source preparation to hosted handlers. */
import { CatalogImportFailed, createCatalog } from "@executor-js/catalog";
import type { SourceFile } from "@executor-js/sdk/core";
import { Effect, Layer } from "effect";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HostedCatalog } from "../contracts/catalog.ts";
import { Authentication } from "../contracts/auth.ts";
import { executorCatalogEntry } from "./executor-catalog-entry.ts";

/**
 * Fetch the public integrations.sh feed on request. Layer construction performs no network I/O.
 * The API document and the OpenAPI source generator are only needed to prepare the Executor
 * app, so both load on that request instead of during server startup.
 */
export const catalogLive = (
  skills: readonly SourceFile[],
  document: Effect.Effect<HostedApiDocument>,
  egress: HostEgress,
) =>
  Layer.effect(
    HostedCatalog,
    Effect.gen(function* () {
      const { origin } = yield* Authentication;
      const published = createCatalog(egress);
      const executor = executorCatalogEntry(origin);
      return HostedCatalog.of({
        list: published.list.pipe(
          Effect.map((entries) => [
            executor,
            ...entries.filter((entry) => entry.id !== executor.id),
          ]),
        ),
        custom: published.custom,
        prepare: (input) =>
          input.entry === executor.id
            ? Effect.all([Effect.promise(() => import("./executor-app.ts")), document]).pipe(
                Effect.flatMap(([{ executorAppSource }, document]) =>
                  executorAppSource(origin, skills, document),
                ),
                Effect.map(({ files, skippedOperations }) => ({ files, skippedOperations })),
                Effect.mapError(
                  (error) => new CatalogImportFailed({ code: error.code, reason: error.reason }),
                ),
                Effect.tapError((error) =>
                  Effect.annotateCurrentSpan("catalog.error.reason", error.code),
                ),
                Effect.withSpan("catalog.generate", {
                  attributes: {
                    "catalog.stage": "generate",
                    "catalog.entry.id": executor.id,
                    "catalog.entry.kind": executor.kind,
                  },
                }),
              )
            : published.prepare(input),
      });
    }),
  );
