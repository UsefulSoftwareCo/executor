import { Schema } from "effect";

export const catalogCopyRebuildStepName = "13_rebuild_catalog_copies_on_current_apps";

export const catalogCopyRebuildTargetRelease = "0.0.1-beta.140";

export const catalogPackageScope = "@executor.sh/";

export const catalogCopyHeldPackages: ReadonlyArray<string> = [
  "@executor.sh/appcircle",
  "@executor.sh/aweber",
  "@executor.sh/checkcherry",
  "@executor.sh/netsapiens",
];

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

export const catalogCopyRebuildMessage = (from: string, to: string) =>
  `Update the apps framework from ${from} to ${to}\n\nExecutor rebuilt this catalog app from its own installed source on a current framework release. Only the framework version and, for releases before 0.0.1-beta.90, the account declaration's scope changed.`;

export interface CatalogCopyRebuildScope {
  readonly run: string;
  readonly all: boolean;
  readonly owners: ReadonlySet<string>;
  readonly apps: ReadonlySet<string>;
  readonly max: number | undefined;
}

export class CatalogCopyRebuildScopeInvalid extends Schema.TaggedError<CatalogCopyRebuildScopeInvalid>()(
  "CatalogCopyRebuildScopeInvalid",
  { token: Schema.String },
) {}

export const catalogCopyRebuildChanged: ReadonlyArray<CatalogCopyRebuildOutcome> = [
  "rebuilding",
  "rebuilt",
  "rebuilt-adds-tools",
  "rolled-back",
  "unfinished",
];
