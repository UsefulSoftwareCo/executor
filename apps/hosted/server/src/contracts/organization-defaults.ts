import { Context, Schema, type Effect } from "effect";
import {
  ProfileNotFound,
  ProfileConflict,
  AccountNotFound,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  ProviderNotFound,
  CredentialsError,
  AccountSelectionInvalid,
  AppNotFound,
  AppNotDeployed,
  AppDeploymentChanged,
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  DeploymentNotFound,
  AppNameTaken,
  AppSlugTaken,
  SkillDefinitionInvalid,
  StorageError,
  SourceError,
} from "@executor-js/sdk/core";
import { TemplateError } from "@executor-js/app-templates/contracts";
import type { OrganizationId } from "./organization.ts";
import type { ScheduleWakeup } from "./schedules.ts";

/** A member job waits for the separate team installation to commit. */
export class OrganizationDefaultsPending extends Schema.TaggedError<OrganizationDefaultsPending>()(
  "OrganizationDefaultsPending",
  {},
) {}

/** Setup preserves safe generation and deployment failures alongside storage failures. */
export const OrganizationDefaultsError = Schema.Union([
  OrganizationDefaultsPending,
  StorageError,
  SourceError,
  TemplateError.annotate({ httpApiStatus: 422 }),
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  DeploymentNotFound,
  AppNameTaken,
  AppSlugTaken,
  SkillDefinitionInvalid,
  AppNotFound,
  AppNotDeployed,
  AppDeploymentChanged,
  ProfileNotFound,
  ProfileConflict,
  AccountNotFound,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  ProviderNotFound,
  CredentialsError,
  AccountSelectionInvalid,
]);
/** Trusted background identity; membership is rechecked before committing a managed key. */
export interface ExecutorUserAccount {
  readonly userId: string;
  readonly name: string;
}

/**
 * One-time product setup; installed apps retain their ordinary lifecycle afterward. Setup that
 * saves profile intent wakes profile setup through the caller's {@link ScheduleWakeup}.
 */
export class OrganizationDefaults extends Context.Service<
  OrganizationDefaults,
  (
    organization: OrganizationId,
    user?: ExecutorUserAccount,
  ) => Effect.Effect<void, typeof OrganizationDefaultsError.Type, ScheduleWakeup>
>()("hosted/OrganizationDefaults") {}
