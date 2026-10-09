/** Publishing and catalog HTTP groups. Kept apart from the registry vocabulary, which the apps contract imports. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AppNotFound } from "./apps.ts";
import {
  PackageName,
  Publication,
  PublicationInputs,
  PublicationReadiness,
  PublicationSnapshot,
  RegistryError,
  RegistryInputs,
} from "./registry.ts";
import { StorageError } from "./shared.ts";
import { sourceErrors } from "./source.ts";

/** Publishing retains a reviewed revision and exposes it in this executor's catalog. */
export const PublicationsGroup = HttpApiGroup.make("publications")
  .add(
    HttpApiEndpoint.get("status", "/v1/publications/status", {
      success: Schema.Struct({ publishing: Schema.Boolean, origin: Schema.String }),
      error: [RegistryError],
    }).annotate(
      OpenApi.Description,
      "Whether this executor keeps its own catalog and can publish, and the registry origin it reads.",
    ),
  )
  .add(
    HttpApiEndpoint.post("preview", "/v1/apps/:app/publication-preview", {
      params: { app: PublicationInputs.preview.fields.app },
      payload: Schema.Struct({
        owner: PublicationInputs.preview.fields.owner,
        namespace: PublicationInputs.preview.fields.namespace,
        files: PublicationInputs.preview.fields.files,
      }),
      success: PublicationReadiness,
      error: [StorageError, ...sourceErrors, AppNotFound, RegistryError],
    }).annotate(
      OpenApi.Description,
      "Check the app's working source against the publishing rules without writing anything.",
    ),
  )
  .add(
    HttpApiEndpoint.post("publish", "/v1/apps/:app/publications", {
      params: { app: PublicationInputs.publish.fields.app },
      payload: Schema.Struct({
        owner: PublicationInputs.publish.fields.owner,
        namespace: PublicationInputs.publish.fields.namespace,
        commit: PublicationInputs.publish.fields.commit,
      }),
      success: Publication,
      error: [StorageError, ...sourceErrors, AppNotFound, RegistryError],
    }).annotate(
      OpenApi.Description,
      "Publish one selected Git revision. Republishing changes the listing; installed copies stay independent.",
    ),
  )
  .add(
    HttpApiEndpoint.get("owned", "/v1/publications", {
      query: { owner: PublicationInputs.owned.fields.owner },
      success: Schema.Array(Publication),
      error: [RegistryError],
    }).annotate(OpenApi.Description, "Current listings published by this owner."),
  )
  .add(
    HttpApiEndpoint.post("unpublish", "/v1/publications/removals", {
      payload: PublicationInputs.unpublish,
      success: Schema.Struct({ name: PackageName }),
      error: [RegistryError],
    }).annotate(OpenApi.Description, "Remove a listing. Installed copies keep their source."),
  );

/** Public registry reads expose selected release source, never private app Git history. */
export const RegistryGroup = HttpApiGroup.make("registry")
  .add(
    HttpApiEndpoint.get("list", "/v1/registry/apps", {
      query: { name: RegistryInputs.list.fields.name },
      success: Schema.Array(Publication),
      error: [RegistryError],
    }),
  )
  .add(
    HttpApiEndpoint.get("snapshot", "/v1/registry/source", {
      query: RegistryInputs.snapshot,
      success: PublicationSnapshot,
      error: [RegistryError],
    }),
  );
