/** Skill access through an authorized app evaluation and retained deployment. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AppId, DeploymentId, OwnerId, RequestInvalid, StorageError } from "./shared.ts";
import { AccountNotFound } from "./account.ts";
import { CredentialsError } from "./shared.ts";
import { OAuthReconnectRequired } from "./oauth.ts";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
import { ProfileId } from "./shared.ts";
import { AppEvaluationFailed } from "./tools.ts";
import { AccountRequired, AccountSelectionInvalid, AppNotFound, AppNotDeployed } from "./apps.ts";
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
/** A content digest identifies the complete evaluated catalog, independently of its deployment. */
export const SkillRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export class SkillRevisionChanged extends Schema.TaggedError<SkillRevisionChanged>()(
  "SkillRevisionChanged",
  {
    app: AppId,
    expected: SkillRevision,
    current: SkillRevision,
  },
  { httpApiStatus: 409 },
) {}
const identity = {
  revision: SkillRevision,
  profile: Schema.optionalKey(ProfileId),
  profileRevision: Schema.optionalKey(ProfileRevision),
};
export const AppSkillCatalog = Schema.Struct({
  ...identity,
  app: SkillApp,
  deployment: DeploymentId,
  skills: Schema.Array(AppSkillMetadata),
});
export type AppSkillCatalog = typeof AppSkillCatalog.Type;
/** All skill documents and reference files from one evaluated catalog. */
export const AppSkillBundle = Schema.Struct({
  ...identity,
  app: SkillApp,
  deployment: DeploymentId,
  skills: Schema.Array(AppSkillSource),
});
export type AppSkillBundle = typeof AppSkillBundle.Type;
/** A document or text reference, with its exact version and the available relative resource paths. */
export const AppSkillDocument = Schema.Struct({
  ...AppSkillMetadata.fields,
  ...identity,
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

export const SkillSelection = {
  deployment: Schema.optional(DeploymentId),
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
  revision: Schema.optional(SkillRevision),
};
const selection = { owner: Schema.optional(OwnerId), ...SkillSelection };
/** Omit deployment for active code; pass revision to detect changed skill content. */
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
  SkillRevisionChanged,
  AccountRequired,
  AccountSelectionInvalid,
  AppEvaluationFailed,
  AccountNotFound,
  CredentialsError,
  OAuthReconnectRequired,
  ...ProfileErrors,
] as const;

/** Programmatic skill routes; serving products authorize the app and account profile. */
export const AppSkillsGroup = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("bundle", "/v1/apps/:app/skill-bundle", {
      params: { app: AppId },
      query: selection,
      success: AppSkillBundle,
      error: AppSkillErrors,
    }).annotate(
      OpenApi.Description,
      "Read every skill and its text references from one evaluation of the selected deployment.",
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
      "List this app's skill metadata using the selected account profile. The response identifies its deployment.",
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
      "Read SKILL.md or a listed file within the skill. Pass the returned deployment, profile and revision when reading references to reject changed content. Files are text; they are never executed.",
    ),
  );
