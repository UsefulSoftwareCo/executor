/** Skill access through an authorized app evaluation and retained version. */
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AppId, VersionId, OwnerId, RequestInvalid, StorageError } from "./shared.ts";
import { AccountNotFound } from "./account.ts";
import { CredentialsError } from "./shared.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";
import { AppEvaluationFailed, AppProviderFailed } from "./tools.ts";
import {
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  AppAccounts,
  AppAccountsQuery,
  AppNotFound,
  AppNotDeployed,
} from "./apps.ts";
import { AppSlug } from "./app-slug.ts";
import { VersionNotFound, SourceFilePath } from "./version.ts";
import {
  AppSkillMetadata,
  AppSkillName,
  AppSkillSource,
  SkillDefinitionInvalid,
} from "./skill-source.ts";

/** A configured installation supplies the namespace; skill source never hardcodes it. */
export const SkillApp = Schema.Struct({ id: AppId, name: Schema.String, slug: AppSlug });
/** A content digest identifies the complete evaluated catalog, independently of its version. */
export const SkillRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const SkillRevisionChanged = ApiError.define({
  tag: "SkillRevisionChanged",
  status: 409,
  fields: { app: AppId, expected: SkillRevision, current: SkillRevision },
  message:
    "The app's skills changed since the requested revision. List the skills again and read the current revision.",
});
export type SkillRevisionChanged = typeof SkillRevisionChanged.Type;
const identity = { revision: SkillRevision };
const AppSkillCatalogFields = Schema.Struct({
  ...identity,
  app: SkillApp,
  version: VersionId,
  skills: Schema.Array(AppSkillMetadata),
});
export const AppSkillCatalog = AppSkillCatalogFields.pipe(
  withLegacyKeys({ version: "deployment" }),
);
export type AppSkillCatalog = typeof AppSkillCatalog.Type;
/** All skill documents and reference files from one evaluated catalog. */
const AppSkillBundleFields = Schema.Struct({
  ...identity,
  app: SkillApp,
  version: VersionId,
  skills: Schema.Array(AppSkillSource),
});
export const AppSkillBundle = AppSkillBundleFields.pipe(withLegacyKeys({ version: "deployment" }));
export type AppSkillBundle = typeof AppSkillBundle.Type;
/** A document or text reference, with its exact version and the available relative resource paths. */
const AppSkillDocumentFields = Schema.Struct({
  ...AppSkillMetadata.fields,
  ...identity,
  app: SkillApp,
  version: VersionId,
  file: SourceFilePath,
  content: Schema.String,
  files: Schema.Array(SourceFilePath),
});
export const AppSkillDocument = AppSkillDocumentFields.pipe(
  withLegacyKeys({ version: "deployment" }),
);
export type AppSkillDocument = typeof AppSkillDocument.Type;
/** Missing skills and files share one failure without exposing other source paths. */
export const AppSkillNotFound = ApiError.define({
  tag: "AppSkillNotFound",
  status: 404,
  fields: { app: AppId, name: AppSkillName, file: SourceFilePath },
  message: ({ name, file }) => `The app has no skill “${name}” with the file “${file}”.`,
  recorded: () => "The app has no skill with the requested name and file",
});
export type AppSkillNotFound = typeof AppSkillNotFound.Type;

export const SkillSelection = {
  version: Schema.optional(VersionId),
  accounts: Schema.optional(AppAccounts),
  revision: Schema.optional(SkillRevision),
};
const selection = { owner: Schema.optional(OwnerId), ...SkillSelection };
/** The same selection in a GET query. */
const selectionQuery = { ...selection, accounts: AppAccountsQuery };
/** Omit version for active code; pass revision to detect changed skill content. */
export const AppSkillInputs = {
  list: Schema.Struct({ app: AppId, ...selection }),
  read: Schema.Struct({
    app: AppId,
    ...selection,
    name: AppSkillName,
    file: Schema.optional(SourceFilePath),
  }),
};
/**
 * Typed source and lookup failures shared by SDK and product adapters. A product resolves the
 * accounts from the caller's links and reports a plain requirement with none as `AccountRequired`.
 */
export const AppSkillErrors = [
  AppNotFound,
  AppNotDeployed,
  VersionNotFound,
  StorageError,
  RequestInvalid,
  SkillDefinitionInvalid,
  SkillRevisionChanged,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  AppEvaluationFailed,
  AppProviderFailed,
  AccountNotFound,
  CredentialsError,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
] as const;

/** Programmatic skill routes; serving products authorize the app and its accounts. */
export const AppSkillsGroup = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("bundle", "/v1/apps/:app/skill-bundle", {
      params: { app: AppId },
      query: Schema.Struct(selectionQuery).pipe(withLegacyKeys({ version: "deployment" })),
      success: AppSkillBundle,
      error: AppSkillErrors,
    }).annotate(
      OpenApi.Description,
      "Read every skill and its text references from one evaluation of the selected version.",
    ),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/skills", {
      params: { app: AppId },
      query: Schema.Struct(selectionQuery).pipe(withLegacyKeys({ version: "deployment" })),
      success: AppSkillCatalog,
      error: AppSkillErrors,
    }).annotate(
      OpenApi.Description,
      "List this app's skill metadata using the chosen accounts. The response identifies its version.",
    ),
  )
  .add(
    HttpApiEndpoint.get("read", "/v1/apps/:app/skills/:name", {
      params: { app: AppId, name: AppSkillName },
      query: Schema.Struct({ ...selectionQuery, file: Schema.optional(SourceFilePath) }).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
      success: AppSkillDocument,
      error: [...AppSkillErrors, AppSkillNotFound],
    }).annotate(
      OpenApi.Description,
      "Read SKILL.md or a listed file within the skill. Pass the returned version and revision, and the same accounts, when reading references to reject changed content. Files are text; they are never executed.",
    ),
  );
