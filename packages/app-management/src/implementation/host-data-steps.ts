/** The data steps every host runs, in order. Local, self-host and Cloud share this one list. */
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
import type { SqlClient } from "effect/sql";
import type { DataStep } from "../contracts/data-steps.ts";

/** The host services every step together reads and writes through. */
export type DataStepHost = FrameworkPinHost &
  BuildFrameworkHost &
  AgentGrantHost &
  ExecutorAppRedeployHost &
  StoredOAuthClientsHost &
  LocalOwnersHost &
  OAuthClientsByIssuerHost &
  ProfileAppCopiesHost &
  UnremovableWebhooksHostServices &
  CatalogCopyRebuildHost;

/**
 * A step by its journal name. A `local` step is listed only by a host that passes local owners:
 * local, whose journal requires them. Self-host and Cloud never list one. A step with `listed` is
 * listed only by a host it accepts.
 */
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

/** Append new steps; never rename, reorder or change one that has shipped. */
const listedSteps: ReadonlyArray<ListedStep> = [
  {
    name: "1_app_framework_pin",
    step: (host, name) => frameworkPinStep(host, name, frameworkPinRelease),
  },
  // Builds now require a declaration. Pin apps created without one after the first pass ran. The
  // hosts that created them built undeclared source with their own protocol-1 framework.
  {
    name: "2_app_framework_pin_catch_up",
    step: (host, name) => frameworkPinStep(host, name, frameworkPinCatchUpRelease),
  },
  // Store each retained build's framework once, beside the inlined copy, which stays.
  { name: "3_build_framework_once", step: buildFrameworkOnceStep },
  // Revoke OAuth grants that can never be used again and have been idle for 30 days.
  { name: idleAgentGrantsStepName, step: idleAgentGrantsStep },
  // One-off: redeploy Executor apps built on an apps release before beta.10, whose background
  // cache refreshes aborted with the invocation, with only their apps pin moved to beta.84, a
  // protocol 12 release that still builds their source.
  { name: executorAppRedeployStepName, step: executorAppRedeployStep },
  // One-off: move saved OAuth clients into stored clients, under the owner whose accounts used them.
  { name: storedOAuthClientsStepName, step: storedOAuthClientsStep },
  // Local only, one-off: give `local` the records of owners agents named before local assigned
  // them.
  { name: localOwnersStepName, local: (host, owners) => localOwnersStep(host.executor, owners) },
  // One-off: record the authorization server of clients stored by provider before SDK 4.0.12, and
  // merge an owner's clients that hold the same credentials for one server.
  { name: oauthClientsByIssuerStepName, step: oauthClientsByIssuerStep },
  // One-off: move the saved clients step 6 left, and collapse the rest, by owner and server.
  { name: savedOAuthClientsByIssuerStepName, step: savedOAuthClientsByIssuerStep },
  // One-off: make the app copies SDK storage 4.0.13 planned for profiles with other accounts.
  { name: profileAppCopiesStepName, step: profileAppCopiesStep },
  // One-off: hand webhook registrations saved without their source, which no removal can finish,
  // to a person to remove at the provider.
  { name: unremovableWebhooksStepName, step: unremovableWebhooksStep },
  // One-off: store on each MCP grant the approval mode its consent's resource named, now that the
  // grant record, not the URL, holds it.
  { name: agentGrantModesStepName, step: agentGrantModesStep },
  // One-off: rebuild untouched copies of official catalog apps from their own installed source on
  // apps 0.0.1-beta.140, where the account merge fix is (E-042). Listed only by a host that passes
  // `catalogCopyRebuild`: Cloud, and self-host when its operator turns it on
  // (`EXECUTOR_CATALOG_COPY_REBUILD=on`). See notes/catalog-copy-rebuild.md.
  {
    name: catalogCopyRebuildStepName,
    step: catalogCopyRebuildStep,
    listed: (host) => host.catalogCopyRebuild !== undefined,
  },
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

/**
 * The journal names of the steps `hostDataSteps` lists for a host, in order, without building
 * them. `bun run check` holds local's to SDK storage (`scripts/check-local-data-steps.ts`).
 */
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

/**
 * Local and self-host apply pending steps at startup. `report` holds them: each start then reports
 * what applying would do, writes nothing and records no step as applied.
 */
/**
 * Self-host lists the catalog-copy rebuild only when its operator sets `on`: it applies at
 * startup, without the report Cloud reviews first. Local never lists it. With `on`, every copy is
 * in scope unless `EXECUTOR_CATALOG_COPY_REBUILD_SCOPE` names a narrower one (see
 * `CatalogCopyRebuildScope`); turning the step on is the operator's choice for the whole host.
 * An app still failing after three starts is recorded `gave-up`, since each start waits for the
 * step before it serves.
 *
 * Self-host is not paced. E2E runs only, `EXECUTOR_TEST_CATALOG_COPY_REBUILD_PACE` with
 * `EXECUTOR_ENVIRONMENT=e2e` paces each start as Cloud paces each tick, so a scenario can see
 * where a pace stops the step; the next start resumes it.
 */
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

/**
 * Run pending steps once the schema is current and before the host serves or builds anything.
 * The caller holds the host's exclusive directory lock. Items left to retry, such as a conflict,
 * are retried at the next start; other items are not handled again.
 */
export const runStartupDataSteps = <Journal extends DataStepJournal>(
  // Local's journal lists step 7, so a local host passes the owners it assigns.
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
