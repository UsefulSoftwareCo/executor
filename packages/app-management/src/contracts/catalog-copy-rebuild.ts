/**
 * One-off data step: rebuild untouched copies of official catalog apps from their own installed
 * source on a current `apps` release, so framework fixes reach them (E-042: the account merge's
 * CPU cost and too-large replies, fixed in `0.0.1-beta.140`).
 *
 * A catalog install copies the feed's files unchanged, and a version keeps the framework it was
 * built with; Executor never upgrades an app on its own. This step never reads the catalog: it
 * rebuilds each copy's own files with only the mechanical upgrade its release needs, and only when
 * the result is one of the reviewed targets listed in `catalog-copy-snapshots.ts`. See
 * notes/catalog-copy-rebuild.md for the invariants, failure states, stop switch and undo.
 */
import { Schema } from "effect";

/** The journal name. It never changes; each apply stage records its own run under it. */
export const catalogCopyRebuildStepName = "13_rebuild_catalog_copies_on_current_apps";

/** The release copies are rebuilt on: the first with the account merge fix (E-042). */
export const catalogCopyRebuildTargetRelease = "0.0.1-beta.140";

/**
 * The package scope of official catalog apps, as `copiedFrom.name` records it. Items are the apps
 * whose origin names a package in it; only a feed install's origin passes (`not-catalog`).
 */
export const catalogPackageScope = "@executor.sh/";

/**
 * Packages whose existing tool names change on the target release: an operation path that
 * collides is suffixed differently, and two netsapiens tools call another endpoint under the same
 * name. Saved approvals, grants and calls name tools, so their copies are held, not rebuilt, until
 * someone decides. Measured on the catalog's source at beta.100 against beta.140 (2026-11-17).
 */
export const catalogCopyHeldPackages: ReadonlyArray<string> = [
  "@executor.sh/appcircle",
  "@executor.sh/aweber",
  "@executor.sh/checkcherry",
  "@executor.sh/netsapiens",
];

/**
 * Packages that gain tools on the target release (operations an older release skipped now
 * compile) while every existing tool keeps its name. They are rebuilt; the report counts them
 * apart so the added tools are visible. Measured as for {@link catalogCopyHeldPackages}.
 */
export const catalogCopyToolsAddedPackages: ReadonlyArray<string> = [
  "0codekit",
  "apptivegrid",
  "autotask",
  "beatapi",
  "billsby",
  "box",
  "browserless",
  "btcpayserver",
  "cashfree",
  "chatbotkit",
  "clickup",
  "commercelayer",
  "crowdin",
  "crustdata",
  "customgpt",
  "datto-rmm",
  "deployhq",
  "didit",
  "document360",
  "drchrono",
  "dropboxsign",
  "exa",
  "finnhub",
  "fireworksai",
  "gettyimages",
  "honcho",
  "huntress",
  "imagerouter",
  "itmplatform",
  "jinko",
  "judgeme",
  "lemlist",
  "looker",
  "make",
  "microsoftpowerbi",
  "mindbody",
  "miro",
  "mistralai",
  "nango",
  "nocodb",
  "nozbeteams",
  "nutrient-dws",
  "nylas",
  "onesignal",
  "openlayer",
  "openrouter",
  "orgo",
  "pandadoc",
  "parallel",
  "perplexityai",
  "phrase",
  "predictleads",
  "render",
  "revolt",
  "rollbar",
  "salesmsg",
  "sellsy",
  "sequenzy",
  "shipengine",
  "shopware",
  "smartrecruiters-api-key",
  "snowflake",
  "spendesk",
  "tave",
  "telnyx",
  "tempo",
  "vectorshift",
  "xata",
  "xquik",
  "zoho",
  "zohodesk",
].map((name) => `${catalogPackageScope}${name}`);

/**
 * Items are apps whose `copiedFrom.name` is in the catalog's package scope. Report outcomes name
 * what `apply` would do; apply outcomes what it did. Every outcome but `rebuilt*`,
 * `rolled-back`, `rebuilding`, `conflict` and `failed` changes nothing.
 *
 * - `rebuild` / `rebuilt`: untouched, the upgraded source is a reviewed target, it builds on the
 *   target release and declares the same requirements. Rebuilt with only the reviewed upgrade.
 * - `rebuild-adds-tools` / `rebuilt-adds-tools`: the same, for a package in
 *   {@link catalogCopyToolsAddedPackages}.
 * - `not-catalog`: the origin is not an install from an official app feed (a copy of another app
 *   records its parent's display name, which anyone can set), or the running files' own package
 *   is not the one the origin names. Not rebuilt.
 * - `held-tool-names`: every copy of a package in {@link catalogCopyHeldPackages}, by the package
 *   its running files declare, whatever its state. Not rebuilt.
 * - `current`: the running source already pins the target release or a later one.
 * - `edited`: the running source is not the app's first version's, or `main` holds other work.
 * - `unmapped`: the running source declares no exact release, or it is the install's but its
 *   upgrade is not a reviewed target: no published catalog snapshot, or a shape the upgrade does
 *   not recognize.
 * - `background-work`: the app has schedules, webhook subscriptions, workflow runs or profiles. A
 *   new version would reconcile them, so the step leaves the app alone.
 * - `requirements-changed`: the upgraded source declares other requirements than the running
 *   version (names, scopes, cardinalities, provider IDs, SQL or events). Nothing
 *   changed.
 * - `rolled-back`: (apply) the deployed version's requirements differed after all, so the
 *   replaced version was activated again at once; or a rebuild left part way was undone before
 *   the next pass finished it. A new version is retained but not active.
 * - `build-failed`: the upgraded source does not build on the target release. Nothing changed.
 * - `undeployed`: nothing runs.
 * - `rebuilding`: (apply) recorded once the check build passed, before the deploy; it stays only
 *   when the app was left part way (deployed, but not yet checked, rolled back or committed to
 *   `main`), or when a failure while finishing it says nothing of what the app runs. Retried: the
 *   next pass finishes that app, deploying it without another check build if the deploy never
 *   activated. A paced run stops a copy before its deploy with this record and nothing else.
 * - `conflict`: the app was deployed or activated, or its `main` changed, while it was handled.
 *   Retried.
 * - `failed`: storage, Git or the build service failed for this app, or its build could not
 *   install a dependency (an npm registry out of reach). Nothing changed. Retried. An app being
 *   finished from a `rebuilding` or `unfinished` record stays `rebuilding` instead.
 * - `removed`: the app was deleted before it could be handled.
 * - `out-of-scope`: (apply) the app is not in this stage's scope, or the stage already changed its
 *   maximum count of copies. Nothing read or changed; a later, wider stage handles it afresh.
 * - `gave-up`: (apply) the app ended `failed` or `conflict` on every pass up to the host's bound.
 *   Nothing changed; a later stage tries it afresh.
 * - `unfinished`: (apply) the app stayed `rebuilding` up to the host's bound: its rebuild may be
 *   active with `main` not yet updated, or it may still run its install after a check build that
 *   passed and a deploy that kept failing. The next stage finishes it first, whatever its scope,
 *   deploying it in the second case.
 */
export const CatalogCopyRebuildOutcome = Schema.Literals([
  "rebuild",
  "rebuild-adds-tools",
  "rebuilt",
  "rebuilt-adds-tools",
  "not-catalog",
  "held-tool-names",
  "current",
  "edited",
  "unmapped",
  "background-work",
  "requirements-changed",
  "rolled-back",
  "build-failed",
  "undeployed",
  "rebuilding",
  "conflict",
  "failed",
  "removed",
  "out-of-scope",
  "gave-up",
  "unfinished",
]);
export type CatalogCopyRebuildOutcome = typeof CatalogCopyRebuildOutcome.Type;

/** The commit that records the rebuilt source on `main`. */
export const catalogCopyRebuildMessage = (from: string, to: string) =>
  `Update the apps framework from ${from} to ${to}\n\nExecutor rebuilt this catalog app from its own installed source on a current framework release. Only the framework version and, for releases before 0.0.1-beta.90, the account declaration's scope changed.`;

/**
 * Which copies one apply stage may change, from the host's configuration (Cloud
 * `CLOUD_CATALOG_COPY_REBUILD_SCOPE`, self-host `EXECUTOR_CATALOG_COPY_REBUILD_SCOPE`): tokens
 * separated by spaces or commas.
 *
 * - `all`: every copy; otherwise only copies named by the tokens below.
 * - `organization:<id>`: the copies an organization owns.
 * - `app:<id>`: one copy.
 * - `max:<n>`: change at most `n` copies in this stage (rebuilt, rolled back or left part way),
 *   with `all` or the tokens above.
 *
 * Empty selects nothing. Each distinct scope is its own stage, an apply run named by a digest of
 * the scope (`apply:scope-<digest>`): a finished stage completes its run, and a new scope starts
 * another run whose first pass walks every copy again. Copies outside it are recorded
 * `out-of-scope` and never read.
 */
export interface CatalogCopyRebuildScope {
  /** The stage's journal run. */
  readonly run: string;
  readonly all: boolean;
  /** Owner IDs, as items name them (`organization:<id>`). */
  readonly owners: ReadonlySet<string>;
  readonly apps: ReadonlySet<string>;
  readonly max: number | undefined;
}

/** The scope configuration could not be read; nothing is applied. */
export class CatalogCopyRebuildScopeInvalid extends Schema.TaggedError<CatalogCopyRebuildScopeInvalid>()(
  "CatalogCopyRebuildScopeInvalid",
  { token: Schema.String },
) {}

/**
 * The outcomes of copies a stage changed, which its `max` counts: deployed and active, put back
 * after its deploy, or left part way.
 */
export const catalogCopyRebuildChanged: ReadonlyArray<CatalogCopyRebuildOutcome> = [
  "rebuilding",
  "rebuilt",
  "rebuilt-adds-tools",
  "rolled-back",
  "unfinished",
];
