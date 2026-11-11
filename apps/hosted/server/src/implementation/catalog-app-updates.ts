/**
 * Installed catalog apps roll forward to the feed's current source. Each sweep builds the catalog
 * source first, saving nothing. Only an untouched copy whose linked accounts all keep working is
 * deployed; anything else becomes an offer a manager applies. Results live in organization
 * metadata. A daily job queues member setup for every organization with a copy, and member setup
 * sweeps, as the Executor app's upgrades did.
 */
import { createCatalog } from "@executor-js/catalog";
import {
  StorageError,
  sourceFilesEqual,
  type App,
  type Executor,
  type OwnerId,
  type SourceFiles,
} from "@executor-js/sdk/core";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { type OrganizationId, organizationOwner } from "../contracts/organization.ts";
import { OrganizationDefaults } from "../contracts/organization-defaults.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import {
  breakingChanges,
  catalogEntryId,
  decideCatalogOffer,
  decideCatalogUpdate,
} from "./catalog-app-changes.ts";
import {
  activeSource,
  appLinks,
  commitCatalogSource,
  deployCatalogSource,
  digestOf,
  recordOf,
  sameRecord,
  saveCatalogRecord,
  savedRecords,
  sourceDigest,
  type ActiveSource,
  type CatalogOutcome,
  type Saved,
} from "./catalog-app-records.ts";
import { pinnedOnly } from "@executor-js/app-management/data-steps";

/** The official app feed installs read, through the same egress. */
export interface CatalogAppFeed {
  readonly egress: HostEgress;
  readonly url: string;
}

/** How one app's sweep ended, for its one log line, and what to record. */
interface Decision {
  readonly result:
    | "current"
    | "recorded"
    | "edited"
    | "offered"
    | "offer-kept"
    | "deployed"
    | "superseded"
    | "moved";
  readonly outcome?: CatalogOutcome;
}

/**
 * Decide one catalog copy against the catalog's `files`. Only an untouched copy no linked account
 * breaks on is deployed, and only a deploy that became active over the version it was decided
 * against is recorded as the catalog's own.
 */
const decideCatalogApp = (
  executor: Executor,
  input: {
    readonly owner: OwnerId;
    readonly app: App;
    readonly files: SourceFiles;
    readonly recorded: Saved | undefined;
    readonly current: ActiveSource;
  },
) =>
  Effect.gen(function* () {
    const { owner, app, files, recorded, current } = input;
    const { active, commit, clean } = current;
    const digest = yield* sourceDigest(files);
    // The digest recorded at apply stands in for the files, which retain binary ones by
    // reference; without one, comparing files can only miss, costing one redeploy.
    const unchanged =
      (recorded?.applied === digest && recorded.version === active) ||
      sourceFilesEqual(current.files, files);
    const step = decideCatalogUpdate({ unchanged, clean });
    if (step === "skip") return { result: "edited" } satisfies Decision;
    if (step === "record") {
      // A workspace is recorded only beside the version whose source it holds.
      const workspace = clean
        ? commit
        : recorded?.version === active
          ? recorded.workspace
          : undefined;
      const record = {
        version: active,
        applied: digest,
        ...(workspace === undefined ? {} : { workspace }),
      };
      return {
        result: sameRecord(record, recorded) ? "current" : "recorded",
        outcome: { record, active, deployed: false },
      } satisfies Decision;
    }
    // The same source was already offered against this version, workspace and links: keep it.
    const links = yield* appLinks(app.id);
    const linked = yield* digestOf(
      links.map((link) => [link.requirement, link.subject, link.account, link.provider]).sort(),
    );
    const offer = recorded?.offer;
    if (
      offer?.source === digest &&
      offer.active === active &&
      offer.links === linked &&
      offer.workspace === commit
    )
      return { result: "offer-kept" } satisfies Decision;
    // Compile without saving: requirements decide before anything, migrations included, runs.
    const built = yield* executor.apps.build({ owner, name: app.name, files });
    const breaks = breakingChanges(links, app.requirements.accounts, built.requirements.accounts);
    const versions = (yield* executor.apps.versions({ owner, app: app.id, versionOwner: owner }))
      .length;
    const { untouched, decision } = decideCatalogOffer({
      versions,
      active,
      recorded: recorded?.version,
      breaking: breaks.reconnect > 0 || breaks.reasons.length > 0,
    });
    if (decision === "apply") {
      const outcome = yield* deployCatalogSource(executor, {
        owner,
        app: app.id,
        files,
        digest,
        active,
        commit,
        workspace: current.workspace,
      });
      return outcome === undefined
        ? ({ result: "superseded" } satisfies Decision)
        : ({ result: "deployed", outcome } satisfies Decision);
    }
    // The record keeps the catalog's version and its workspace; the offer names what it read.
    return {
      result: "offered",
      outcome: {
        record: {
          ...(recorded?.version === undefined ? {} : { version: recorded.version }),
          ...(recorded?.applied === undefined ? {} : { applied: recorded.applied }),
          ...(recorded?.workspace === undefined ? {} : { workspace: recorded.workspace }),
          offer: {
            ...breaks,
            source: digest,
            active,
            links: linked,
            workspace: commit,
            touched: !untouched,
          },
        },
        active,
        deployed: false,
      },
    } satisfies Decision;
  });

/**
 * The catalog's own version is active and its workspace is still on the commit recorded beside it,
 * yet holds other source, as after an update whose commit failed: commit the active source there,
 * keeping a framework pin, so the workspace shows what runs. Undefined when the app is no heal
 * candidate. Never heals a version this feature did not record.
 */
const healWorkspace = (
  executor: Executor,
  owner: OwnerId,
  app: App,
  current: ActiveSource,
  recorded: Saved | undefined,
) =>
  recorded?.version !== current.active ||
  recorded.workspace !== current.commit ||
  pinnedOnly(current.workspace, current.files)
    ? Effect.succeed(undefined)
    : commitCatalogSource(executor, {
        owner,
        app: app.id,
        files: current.files,
        commit: current.commit,
        workspace: current.workspace,
        message: "Show the running catalog source",
      });

/**
 * Heal the workspace if needed, then decide the copy. A healed workspace is recorded even when
 * nothing else changes; a heal that failed leaves the app for the next pass.
 */
const updateCatalogApp = (
  executor: Executor,
  input: {
    readonly owner: OwnerId;
    readonly app: App;
    readonly files: SourceFiles;
    readonly recorded: Saved | undefined;
  },
) =>
  Effect.gen(function* () {
    const { owner, app, recorded } = input;
    const read = yield* activeSource(executor, owner, app, recorded);
    const moved: Decision = { result: "moved" };
    if (read === undefined) return { decision: moved };
    const healed = yield* healWorkspace(executor, owner, app, read, recorded);
    if (healed !== undefined && healed._tag !== "committed") return { healed, decision: moved };
    const current =
      healed === undefined
        ? read
        : { ...read, commit: healed.commit, workspace: healed.files, clean: true };
    const decision: Decision = yield* decideCatalogApp(executor, { ...input, current });
    if (healed === undefined || decision.outcome !== undefined) return { healed, decision };
    return {
      healed,
      decision: {
        ...decision,
        outcome: {
          record: { ...recorded, workspace: current.commit },
          active: current.active,
          deployed: false,
        },
      },
    };
  });

/** What a log may say about a failure: its tag or name, never its content. */
const failureKind = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : "unknown";

/**
 * Sweep one organization's copies of `feed`'s apps. Each app's failure is logged and the rest
 * continue; an unreachable feed stops the sweep. An entry whose source the feed no longer serves,
 * or whose source does not build, is left as is. The next pass tries again.
 */
export const catalogAppUpdates = (
  executor: Executor,
  feed: CatalogAppFeed,
  organization: OrganizationId,
) =>
  Effect.suspend(() => {
    let intent = false;
    return Effect.gen(function* () {
      const owner = organizationOwner(organization);
      const saved = yield* savedRecords(organization);
      if (saved === undefined) return;
      const catalog = createCatalog({ egress: feed.egress, feedUrl: feed.url });
      for (const app of yield* executor.apps.list({ owner })) {
        const entry = catalogEntryId(app.copiedFrom?.reference, feed.url);
        if (entry === undefined || app.activeVersion === null) continue;
        const recorded = recordOf(saved, app.id);
        // Every app gets exactly one log line per sweep, whatever happened to it.
        const line = yield* Effect.gen(function* () {
          const prepared = yield* catalog.prepare({ entry });
          if (prepared.origin?.reference !== app.copiedFrom?.reference)
            return { result: "unlisted" };
          const { healed, decision } = yield* updateCatalogApp(executor, {
            owner,
            app,
            files: prepared.files,
            recorded,
          });
          const heal = healed === undefined ? {} : { healed: healed._tag };
          const outcome = decision.outcome;
          if (outcome === undefined) return { result: decision.result, ...heal };
          // A deploy leaves the app's webhook sources pending.
          if (outcome.deployed) intent = true;
          const workspace = outcome.workspace === undefined ? {} : { workspace: outcome.workspace };
          // A pass that changes nothing writes nothing.
          if (!outcome.deployed && sameRecord(outcome.record, recorded))
            return { result: decision.result, ...heal, ...workspace };
          const wrote = yield* saveCatalogRecord(executor, organization, app.id, recorded, outcome);
          return {
            result: wrote ? decision.result : `${decision.result}-unrecorded`,
            ...heal,
            ...workspace,
          };
        }).pipe(
          Effect.catchTags({
            CatalogImportFailed: () => Effect.succeed({ result: "unlisted" }),
            AppNotFound: () => Effect.succeed({ result: "removed" }),
            VersionBuildFailed: () => Effect.succeed({ result: "unbuildable" }),
            BuildMemoryExceeded: () => Effect.succeed({ result: "unbuildable" }),
          }),
          // Every other entry reads the same feed.
          Effect.catchIf(
            (error) => error._tag !== "CatalogUnavailable",
            (error) => Effect.succeed({ result: "failed", failure: failureKind(error) }),
          ),
          Effect.tapError(() =>
            Effect.logWarning("Catalog app update", { entry, result: "feed-unavailable" }),
          ),
        );
        yield* line.result === "failed" || line.result.endsWith("-unrecorded")
          ? Effect.logWarning("Catalog app update", { entry, ...line })
          : Effect.logInfo("Catalog app update", { entry, ...line });
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => (intent ? Effect.flatten(ScheduleWakeup) : Effect.void)),
      ),
    );
  });

/**
 * Member setup, then a sweep of the organization's catalog apps when a feed is configured. The
 * sweep never fails member setup: its failures are logged, and the next daily pass retries.
 */
export const withCatalogAppUpdates = (
  executor: Executor,
  feed: CatalogAppFeed | undefined,
  initialize: OrganizationDefaults["Service"],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationDefaults.of((organization, user) =>
      Effect.gen(function* () {
        yield* initialize(organization, user);
        if (user !== undefined && feed !== undefined)
          yield* catalogAppUpdates(executor, feed, organization).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            // An unreachable feed was logged with the app that met it.
            Effect.catch((error) =>
              failureKind(error) === "CatalogUnavailable"
                ? Effect.void
                : Effect.logWarning("Catalog app updates stopped", { failure: failureKind(error) }),
            ),
          );
      }),
    );
  });

/**
 * Queue member setup for every organization holding a copy of the feed's apps, run as a member
 * who can manage apps, unless member setup is already queued there. A job still running may have
 * been cut short, so it does not count; overlapping sweeps are safe. Hosts run this daily.
 */
export const queueCatalogAppUpdates = (feedUrl: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const apps = new URL("apps/", feedUrl).href;
    yield* sql`insert into hosted_provisioning (kind, organization_id, user_id)
      select distinct on (organization.id) 'member', organization.id, member."userId"
      from organization
      join member on member."organizationId" = organization.id and member.role in ('owner', 'admin')
      join "user" on "user".id = member."userId"
      where exists (select 1 from executor_apps app
          where app.owner = 'organization:' || organization.id
            and left(app.copied_from::jsonb ->> 'reference', length(${apps})) = ${apps})
        and not exists (select 1 from hosted_provisioning job
          where job.kind = 'member' and job.organization_id = organization.id
            and job.status = 'queued')
      order by organization.id, "user"."emailVerified" desc, member.role = 'owner' desc, member."createdAt"`;
  }).pipe(Effect.mapError(() => new StorageError()));
