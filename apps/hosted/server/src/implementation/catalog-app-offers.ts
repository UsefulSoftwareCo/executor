/** A catalog update held back for a manager, read for the Versions tab and applied on request. */
import type { Catalog } from "@executor-js/catalog/contracts";
import { StorageError, type App, type AppId, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CatalogUpdateUnavailable } from "../contracts/apps.ts";
import { type OrganizationId, organizationOwner } from "../contracts/organization.ts";
import { breakingChanges } from "./catalog-app-changes.ts";
import {
  activeSource,
  appLinks,
  deployCatalogSource,
  recordOf,
  saveCatalogRecord,
  savedRecords,
  sourceDigest,
} from "./catalog-app-records.ts";

/** The catalog update held back for this app, unless its active version changed since. */
export const catalogAppOffer = (organization: OrganizationId, app: App) =>
  Effect.gen(function* () {
    const offer = recordOf(yield* savedRecords(organization), app.id)?.offer;
    if (offer === undefined || offer.active !== app.activeVersion) return null;
    return { reconnect: offer.reconnect, reasons: offer.reasons, touched: offer.touched };
  }).pipe(Effect.mapError(() => new StorageError()));

/**
 * Deploy the held-back update: read the catalog's current source and deploy it, only while the
 * app is still on the version the offer was decided against, its workspace is clean and the feed
 * still serves the offered source. A newer source waits for the next sweep.
 */
export const applyCatalogAppOffer = (
  executor: Executor,
  catalog: Catalog,
  organization: OrganizationId,
  id: AppId,
) =>
  Effect.gen(function* () {
    const owner = organizationOwner(organization);
    const app = yield* executor.apps.get({ owner, app: id });
    const reference = app.copiedFrom?.reference;
    const encoded = reference?.match(/\/apps\/([^/]+)\.json$/)?.[1];
    if (encoded === undefined) return yield* new CatalogUpdateUnavailable({ reason: "none" });
    const entry = yield* Effect.try({
      try: () => decodeURIComponent(encoded),
      catch: () => new CatalogUpdateUnavailable({ reason: "none" }),
    });
    const prepared = yield* catalog.prepare({ entry });
    if (prepared.origin?.reference !== reference)
      return yield* new CatalogUpdateUnavailable({ reason: "none" });
    // The record and the active source are read after the feed, right before deciding; a version
    // activated since `app` was read makes the source read differ from it.
    const recorded = recordOf(yield* savedRecords(organization), app.id);
    const offer = recorded?.offer;
    if (offer === undefined) return yield* new CatalogUpdateUnavailable({ reason: "none" });
    const current = yield* activeSource(executor, owner, app, recorded);
    if (current === undefined || current.active !== offer.active)
      return yield* new CatalogUpdateUnavailable({ reason: "changed" });
    if (!current.clean) return yield* new CatalogUpdateUnavailable({ reason: "edited" });
    const digest = yield* sourceDigest(prepared.files);
    if (digest !== offer.source) return yield* new CatalogUpdateUnavailable({ reason: "changed" });
    // Links may have changed since the sweep; refuse what would break more than the manager saw.
    const built = yield* executor.apps.build({ owner, name: app.name, files: prepared.files });
    const breaks = breakingChanges(
      yield* appLinks(app.id),
      app.requirements.accounts,
      built.requirements.accounts,
    );
    if (
      breaks.reconnect > offer.reconnect ||
      breaks.reasons.some((reason) => !offer.reasons.includes(reason))
    )
      return yield* new CatalogUpdateUnavailable({ reason: "changed" });
    const outcome = yield* deployCatalogSource(executor, {
      owner,
      app: app.id,
      files: prepared.files,
      digest,
      active: current.active,
      commit: current.commit,
      workspace: current.workspace,
    });
    if (outcome === undefined) return yield* new CatalogUpdateUnavailable({ reason: "changed" });
    yield* saveCatalogRecord(executor, organization, app.id, recorded, outcome);
    return yield* executor.apps.get({ owner, app: app.id });
  }).pipe(
    Effect.catchTags({
      SqlError: () => new StorageError(),
      SchemaError: () => new StorageError(),
      BuildUnanswered: () => new StorageError(),
    }),
  );
