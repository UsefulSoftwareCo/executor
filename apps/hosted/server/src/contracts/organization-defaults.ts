import { Context, Schema, type Effect } from "effect";
import {
  AccountNotFound,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  ProviderNotFound,
  CredentialsError,
  AccountSelectionInvalid,
  AppNotFound,
  AppNotDeployed,
  AppVersionChanged,
  VersionBuildFailed,
  BuildMemoryExceeded,
  MarkdownUnavailable,
  VersionNotFound,
  AppNameTaken,
  AppSlugTaken,
  SkillDefinitionInvalid,
  StorageError,
  SourceError,
  SourcePathConflict,
  SourcePathNotUnicode,
} from "@executor-js/sdk/core";
import { TemplateError } from "@executor-js/app-templates/contracts";
import type { OrganizationId } from "./organization.ts";
import type { ScheduleWakeup } from "./schedules.ts";

export class OrganizationDefaultsPending extends Schema.TaggedError<OrganizationDefaultsPending>()(
  "OrganizationDefaultsPending",
  {},
) {}

export const OrganizationDefaultsError = Schema.Union([
  OrganizationDefaultsPending,
  StorageError,
  SourceError,
  SourcePathConflict,
  SourcePathNotUnicode,
  TemplateError.annotate({ httpApiStatus: 422 }),
  VersionBuildFailed,
  BuildMemoryExceeded,
  MarkdownUnavailable,
  VersionNotFound,
  AppNameTaken,
  AppSlugTaken,
  SkillDefinitionInvalid,
  AppNotFound,
  AppNotDeployed,
  AppVersionChanged,
  AccountNotFound,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  ProviderNotFound,
  CredentialsError,
  AccountSelectionInvalid,
]);
export interface ExecutorUserAccount {
  readonly userId: string;
  readonly name: string;
}

export class OrganizationDefaults extends Context.Service<
  OrganizationDefaults,
  (
    organization: OrganizationId,
    user?: ExecutorUserAccount,
  ) => Effect.Effect<void, typeof OrganizationDefaultsError.Type, ScheduleWakeup>
>()("hosted/OrganizationDefaults") {}
