import { Effect, Schema } from "effect";
import {
  CatalogImportFailed,
  CatalogUnavailable,
  type CatalogRecovery,
} from "../contracts/catalog.ts";

export const catalogStage =
  (stage: "prepare" | "lookup" | "custom") =>
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

export const setupRecovery =
  (recovery: CatalogRecovery) =>
  <A, E, R>(program: Effect.Effect<A, E | CatalogImportFailed, R>) =>
    program.pipe(
      Effect.mapError((error) =>
        Schema.is(CatalogImportFailed)(error) && error.code === "agent_setup_required"
          ? new CatalogImportFailed({
              code: error.code,
              reason: error.reason,
              ...(error.detection === undefined ? {} : { detection: error.detection }),
              recovery,
            })
          : error,
      ),
    );
