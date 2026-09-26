/** Catalog traces retain stable failure codes, never source documents, URLs, or authored names. */
import { Effect, Schema } from "effect";
import { CatalogImportFailed, CatalogUnavailable } from "../contracts/catalog.ts";

/** Keep the failure stage and safe reason on the span before product error translation. */
export const catalogStage =
  (stage: "prepare" | "lookup" | "mcp" | "custom") =>
  <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(
      Effect.tapError((error) => {
        if (Schema.is(CatalogImportFailed)(error))
          return Effect.annotateCurrentSpan("catalog.error.reason", error.code);
        if (Schema.is(CatalogUnavailable)(error))
          return Effect.annotateCurrentSpan("catalog.error.reason", "catalog_unavailable");
        return Effect.void;
      }),
      Effect.withSpan(`catalog.${stage}`, { attributes: { "catalog.stage": stage } }),
    );
