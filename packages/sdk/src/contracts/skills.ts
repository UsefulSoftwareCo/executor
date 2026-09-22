/** Read-only skill access through a configured app and one retained deployment. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AppId, DeploymentId, OwnerId, RequestInvalid, StorageError } from "./shared.ts";
import { AppNotFound, AppNotDeployed } from "./apps.ts";
import { AppSlug } from "./app-slug.ts";
import { DeploymentNotFound, SourceFilePath } from "./deployment.ts";
import {
  AppSkillMetadata,
  AppSkillName,
  AppSkillSource,
  SkillDefinitionInvalid,
} from "./skill-source.ts";

/** A configured installation supplies the namespace; skill source never hardcodes it. */
export const SkillApp = Schema.Struct({ id: AppId, name: Schema.String, slug: AppSlug });
/** Metadata is loaded without evaluating the app or connecting its accounts. */
export const AppSkillCatalog = Schema.Struct({
  app: SkillApp,
  deployment: DeploymentId,
  skills: Schema.Array(AppSkillMetadata),
});
export type AppSkillCatalog = typeof AppSkillCatalog.Type;
/** All skill documents and reference files from one retained source snapshot. */
export const AppSkillBundle = Schema.Struct({
  app: SkillApp,
  deployment: DeploymentId,
  skills: Schema.Array(AppSkillSource),
});
export type AppSkillBundle = typeof AppSkillBundle.Type;
/** A document or text reference, with its exact version and the available relative resource paths. */
export const AppSkillDocument = Schema.Struct({
  ...AppSkillMetadata.fields,
  app: SkillApp,
  deployment: DeploymentId,
  file: SourceFilePath,
  content: Schema.String,
  files: Schema.Array(SourceFilePath),
});
export type AppSkillDocument = typeof AppSkillDocument.Type;
/** Missing skills and files share one failure without exposing other source paths. */
export class AppSkillNotFound extends Schema.TaggedError<AppSkillNotFound>()(
  "AppSkillNotFound",
  { app: AppId, name: AppSkillName, file: SourceFilePath },
  { httpApiStatus: 404 },
) {}

const selection = { owner: Schema.optional(OwnerId), deployment: Schema.optional(DeploymentId) };
/** Omit deployment for the active version; use the returned ID to pin follow-up resource reads. */
export const AppSkillInputs = {
  list: Schema.Struct({ app: AppId, ...selection }),
  read: Schema.Struct({
    app: AppId,
    ...selection,
    name: AppSkillName,
    file: Schema.optional(SourceFilePath),
  }),
};
/** Typed source and lookup failures shared by SDK and product adapters. */
export const AppSkillErrors = [
  AppNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  StorageError,
  RequestInvalid,
  SkillDefinitionInvalid,
] as const;

/** Programmatic static-resource routes; serving products authorize the configured app. */
export const AppSkillsGroup = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("bundle", "/v1/apps/:app/skill-bundle", {
      params: { app: AppId },
      query: selection,
      success: AppSkillBundle,
      error: AppSkillErrors,
    }).annotate(
      OpenApi.Description,
      "Read every skill and its text references from one deployment without evaluating the app or resolving accounts.",
    ),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/skills", {
      params: { app: AppId },
      query: selection,
      success: AppSkillCatalog,
      error: AppSkillErrors,
    }).annotate(
      OpenApi.Description,
      "List this app's skill metadata without connecting accounts. The response identifies its deployment.",
    ),
  )
  .add(
    HttpApiEndpoint.get("read", "/v1/apps/:app/skills/:name", {
      params: { app: AppId, name: AppSkillName },
      query: { ...selection, file: Schema.optional(SourceFilePath) },
      success: AppSkillDocument,
      error: [...AppSkillErrors, AppSkillNotFound],
    }).annotate(
      OpenApi.Description,
      "Read SKILL.md or a listed file within the skill. Pass the returned deployment when reading references to keep the same version. Files are text; they are never executed.",
    ),
  );
