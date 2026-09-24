import type { HostedApiDocument } from "../contracts/api.ts";
/** Supply shared catalog reads and source preparation to hosted handlers. */
import { CatalogImportFailed, createCatalog } from "@executor-js/catalog";
import type { SourceFile } from "@executor-js/sdk/core";
import { Effect, Layer } from "effect";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HostedCatalog } from "../contracts/catalog.ts";
import { Authentication } from "../contracts/auth.ts";
import { executorAppSource, executorCatalogEntry } from "./executor-app.ts";

/** Fetch the public integrations.sh feed on request. Layer construction performs no network I/O. */
export const catalogLive = (
  skills: readonly SourceFile[],
  document: HostedApiDocument,
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
            ? executorAppSource(origin, skills, document).pipe(
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
