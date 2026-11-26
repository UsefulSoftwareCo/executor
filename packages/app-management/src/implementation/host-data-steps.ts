import { Clock, Config, Effect, Option } from "effect";
import type { DataStepJournal } from "../contracts/data-steps.ts";
import { runDataSteps } from "./data-steps.ts";
import { frameworkPinCatchUpRelease, frameworkPinRelease } from "../contracts/framework-pin.ts";
import { frameworkPinStep, type FrameworkPinHost } from "./framework-pin.ts";
import { buildFrameworkOnceStep, type BuildFrameworkHost } from "./build-framework-once.ts";
import {
  idleAgentGrantsStep,
  idleAgentGrantsStepName,
  type AgentGrantHost,
} from "./idle-agent-grants.ts";
import { executorAppRedeployStep, type ExecutorAppRedeployHost } from "./executor-app-redeploy.ts";
import { executorAppRedeployStepName } from "../contracts/executor-app-redeploy.ts";
import {
  storedOAuthClientsStep,
  storedOAuthClientsStepName,
  type StoredOAuthClientsHost,
} from "./stored-oauth-clients.ts";
import { localOwnersStep, localOwnersStepName, type LocalOwnersHost } from "./local-owners.ts";
import {
  oauthClientsByIssuerStep,
  oauthClientsByIssuerStepName,
  savedOAuthClientsByIssuerStep,
  savedOAuthClientsByIssuerStepName,
  type OAuthClientsByIssuerHost,
} from "./oauth-clients-by-issuer.ts";
import {
  profileAppCopiesStep,
  profileAppCopiesStepName,
  type ProfileAppCopiesHost,
} from "./profile-app-copies.ts";
import {
  unremovableWebhooksStep,
  unremovableWebhooksStepName,
  type UnremovableWebhooksHostServices,
} from "./unremovable-webhooks.ts";
import { agentGrantModesStep, agentGrantModesStepName } from "./agent-grant-modes.ts";
import {
  catalogCopyRebuildScope,
  catalogCopyRebuildStep,
  type CatalogCopyRebuildHost,
} from "./catalog-copy-rebuild.ts";
import { catalogCopyRebuildStepName } from "../contracts/catalog-copy-rebuild.ts";
import {
  providerIdentitiesStep,
  providerIdentitiesStepName,
  type ProviderIdentitiesStepHost,
} from "./provider-identities.ts";
import type { SqlClient } from "effect/sql";
import type { DataStep } from "../contracts/data-steps.ts";

export type DataStepHost = FrameworkPinHost &
  BuildFrameworkHost &
  AgentGrantHost &
  ExecutorAppRedeployHost &
  StoredOAuthClientsHost &
  LocalOwnersHost &
  OAuthClientsByIssuerHost &
  ProfileAppCopiesHost &
  UnremovableWebhooksHostServices &
  CatalogCopyRebuildHost &
  ProviderIdentitiesStepHost;

type ListedStep =
  | {
      readonly name: string;
      readonly step: (host: DataStepHost, name: string) => DataStep<SqlClient.SqlClient>;
      readonly listed?: (host: Pick<DataStepHost, "catalogCopyRebuild">) => boolean;
    }
  | {
      readonly name: string;
      readonly local: (
        host: DataStepHost,
        owners: NonNullable<LocalOwnersHost["localOwners"]>,
      ) => DataStep<SqlClient.SqlClient>;
    };

const listedSteps: ReadonlyArray<ListedStep> = [
  {
    name: "1_app_framework_pin",
    step: (host, name) => frameworkPinStep(host, name, frameworkPinRelease),
  },
  {
    name: "2_app_framework_pin_catch_up",
    step: (host, name) => frameworkPinStep(host, name, frameworkPinCatchUpRelease),
  },
  { name: "3_build_framework_once", step: buildFrameworkOnceStep },
  { name: idleAgentGrantsStepName, step: idleAgentGrantsStep },
  { name: executorAppRedeployStepName, step: executorAppRedeployStep },
  { name: storedOAuthClientsStepName, step: storedOAuthClientsStep },
  { name: localOwnersStepName, local: (host, owners) => localOwnersStep(host.executor, owners) },
  { name: oauthClientsByIssuerStepName, step: oauthClientsByIssuerStep },
  { name: savedOAuthClientsByIssuerStepName, step: savedOAuthClientsByIssuerStep },
  { name: profileAppCopiesStepName, step: profileAppCopiesStep },
  { name: unremovableWebhooksStepName, step: unremovableWebhooksStep },
  { name: agentGrantModesStepName, step: agentGrantModesStep },
  {
    name: catalogCopyRebuildStepName,
    step: catalogCopyRebuildStep,
    listed: (host) => host.catalogCopyRebuild !== undefined,
  },
  // One-off: record the identity of providers stored before SDK storage 4.0.18.
  { name: providerIdentitiesStepName, step: providerIdentitiesStep },
];

export const hostDataSteps = (host: DataStepHost): ReadonlyArray<DataStep<SqlClient.SqlClient>> =>
  listedSteps.flatMap((listed) =>
    "step" in listed
      ? listed.listed === undefined || listed.listed(host)
        ? [listed.step(host, listed.name)]
        : []
      : host.localOwners === undefined
        ? []
        : [listed.local(host, host.localOwners)],
  );

export const hostDataStepNames = (host: Pick<DataStepHost, "localOwners" | "catalogCopyRebuild">) =>
  listedSteps.flatMap((listed) =>
    "step" in listed
      ? listed.listed === undefined || listed.listed(host)
        ? [listed.name]
        : []
      : host.localOwners !== undefined
        ? [listed.name]
        : [],
  );

export const startupCatalogCopyRebuild = Effect.gen(function* () {
  const listed = yield* Config.Literals(["off", "on"], "EXECUTOR_CATALOG_COPY_REBUILD").pipe(
    Config.withDefault("off" as const),
  );
  if (listed === "off") return undefined;
  const scope = yield* Config.String("EXECUTOR_CATALOG_COPY_REBUILD_SCOPE").pipe(
    Config.withDefault("all"),
  );
  const environment = yield* Config.String("EXECUTOR_ENVIRONMENT").pipe(Config.withDefault(""));
  const pace =
    environment === "e2e"
      ? yield* Config.Int("EXECUTOR_TEST_CATALOG_COPY_REBUILD_PACE").pipe(Config.option)
      : Option.none();
  return {
    scope: yield* catalogCopyRebuildScope(scope),
    passes: 3,
    ...(Option.isSome(pace) ? { pace: pace.value } : {}),
  };
});

export const startupDataStepMode = Config.Literals(["report", "apply"], "EXECUTOR_DATA_STEPS").pipe(
  Config.withDefault("apply" as const),
);

export const runStartupDataSteps = <Journal extends DataStepJournal>(
  host: DataStepHost & (Journal extends "private_local" ? Required<LocalOwnersHost> : unknown),
  journal: Journal,
) =>
  Effect.gen(function* () {
    const mode = yield* startupDataStepMode;
    const { status } = yield* runDataSteps(hostDataSteps(host), {
      journal,
      mode,
      report: `startup-${yield* Clock.currentTimeMillis}`,
      exclusive: true,
    });
    if (mode === "apply" && status === "pending")
      yield* Effect.logWarning("Data steps left items to retry; the next start retries them");
  });
