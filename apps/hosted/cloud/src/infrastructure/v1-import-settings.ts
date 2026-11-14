/**
 * The v1 import's production switches (`notes/v1-import.md`), shared by the CI stack that stores
 * them for production and the Worker that reads them. Only production reaches v1, so any other
 * deployed stage refuses `on`; emulated Cloud ignores both.
 *
 * - `CLOUD_V1_IMPORT`: `on` lets production read v1's WorkOS, database, Autumn and blob bucket,
 *   and lets an operator holding `V1_IMPORT_OPERATOR_TOKEN` start dry runs. `off`, the default,
 *   binds none of it and answers every operator request 404.
 * - `CLOUD_V1_IMPORT_WRITES`: `on` also lets the operator start imports that write v2. `off`, the
 *   default, refuses them, and requires `CLOUD_V1_IMPORT=on` to mean anything.
 * - Which v1 organizations may be imported is no setting: with writes on, an import names its
 *   organizations and each needs a row in the database table `private_v1_import_allowed`, which
 *   only direct SQL writes (`writes.ts`). With no rows, none is imported.
 * - `CLOUD_V1_IMPORT_SOURCE`: `live` points local Cloud dev at v1's production data, read-only,
 *   for an operator's dry run from their own machine. It runs only dry runs; `emulated`, the
 *   default, keeps the emulated v1.
 */
import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";
import { cloudOrigin, productionStage, stageName, testStage } from "./stage.ts";

export const V1ImportSwitch = Schema.Literals(["off", "on"]);
export type V1ImportSwitch = typeof V1ImportSwitch.Type;

/** GitHub Actions passes an unset variable as an empty string; the deploy maps that to `off`. */
export const v1ImportSetting = Config.Literals(V1ImportSwitch.literals, "CLOUD_V1_IMPORT").pipe(
  Config.withDefault<V1ImportSwitch>("off"),
);

/** The switch for imports that write v2; unset is `off`. */
export const v1ImportWritesSetting = Config.Literals(
  V1ImportSwitch.literals,
  "CLOUD_V1_IMPORT_WRITES",
).pipe(Config.withDefault<V1ImportSwitch>("off"));

/**
 * The secret holding the URL of v1's `v1_import_writer` role, which may only insert and update
 * `org_moved_to_v2` (and read the columns its upsert compares). Imports that write need it: they
 * freeze the organization in v1 with it before copying, and cut it over after verifying.
 */
export const v1ImportWriterName = "V1_IMPORT_WRITER_DATABASE_URL";
export const missingV1ImportWriter = `v1 imports that write need ${v1ImportWriterName}, the URL of v1's v1_import_writer database role, to freeze and cut over each organization`;

/** The secret v1 signs forwarded MCP requests with, shared with v1's `V2_MCP_FORWARD_SECRET`. */
export const v1McpForwardSecretName = "V1_MCP_FORWARD_SECRET";
export const missingV1McpForwardSecret = `v1 imports that write need ${v1McpForwardSecretName}, the secret v1 signs forwarded MCP requests with (v1's V2_MCP_FORWARD_SECRET): without it a moved workspace's MCP URLs stop working`;

/**
 * The secret v1 signs session handoffs with, shared with v1's `V2_SESSION_HANDOFF_SECRET`: v1's
 * dashboard sends a signed-in member of a moved organization to `/api/v1-handoff` with a token
 * signed with it, so they need not sign in again (`v1-session-handoff.ts`).
 */
export const v1SessionHandoffSecretName = "V1_SESSION_HANDOFF_SECRET";

/**
 * Where a non-production Cloud reads v1. `live` is v1's production WorkOS, database, blob bucket
 * and Autumn account, read-only, from local Cloud dev on a loopback origin only. It never writes:
 * such a Cloud refuses every import that writes, whatever `CLOUD_V1_IMPORT_WRITES` says.
 */
export const V1ImportSource = Schema.Literals(["emulated", "live"]);
export type V1ImportSource = typeof V1ImportSource.Type;
export const v1ImportSourceSetting = Config.Literals(
  V1ImportSource.literals,
  "CLOUD_V1_IMPORT_SOURCE",
).pipe(Config.withDefault<V1ImportSource>("emulated"));

/**
 * The credentials of the live source, named apart from production's so they never reach the
 * emulated v1 source, which reads `V1_DATABASE_URL`.
 */
export const v1LiveSettings = {
  workosKey: "V1_LIVE_WORKOS_API_KEY",
  database: "V1_LIVE_DATABASE_URL",
  autumnKey: "V1_LIVE_AUTUMN_SECRET_KEY",
  blobsAccount: "V1_LIVE_CLOUDFLARE_ACCOUNT_ID",
  blobsToken: "V1_LIVE_CLOUDFLARE_API_TOKEN",
} as const;

/** What to change when the live source is asked for anywhere but local Cloud dev. */
export const v1LiveSourceOnlyLocal =
  "CLOUD_V1_IMPORT_SOURCE=live reads v1's production data for a local dry run; only Cloud dev on " +
  "a loopback origin may set it";
/** What to unset when the live source is combined with imports that write. */
export const v1LiveSourceDryRunOnly =
  "CLOUD_V1_IMPORT_SOURCE=live runs only dry runs; unset CLOUD_V1_IMPORT and CLOUD_V1_IMPORT_WRITES";
/** What to set for the live source. */
export const missingV1LiveSetting = (name: string) => `CLOUD_V1_IMPORT_SOURCE=live needs ${name}`;

/** v1's production WorkOS API key in the Agents vault ("Work OS API Key Prod"). A reference only. */
export const v1WorkosKeyReference = "op://Agents/svyzpaqa3tfi27ckajfyjwp66a/credential";

const storedBy =
  "and run `bun run ci:deploy`, which stores it in the GitHub production environment that " +
  "`.github/workflows/deploy.yml` passes to the Worker";

/**
 * What to set when production has no v1 WorkOS key, which the import and the WorkOS API key check
 * read (`v1-api-key-settings.ts`).
 */
export const missingV1WorkosKey =
  "V1_WORKOS_API_KEY is required on the production stage (v2): add " +
  `\`V1_WORKOS_API_KEY=${v1WorkosKeyReference}\` to .env.ci.op ${storedBy}.`;

/** What to set when production does not name v1's database, which the import reads. */
export const missingV1PlanetscaleDatabase =
  "V1_PLANETSCALE_DATABASE_NAME is required on the production stage (v2): set it in .env.ci.op " +
  "to v1's PlanetScale database (`V1_PLANETSCALE_DATABASE_NAME=executor`), on which the deploy " +
  `creates a role that inherits only \`pg_read_all_data\`, ${storedBy}.`;

/** The shortest operator token accepted: a guess must be out of reach. */
export const v1ImportOperatorTokenMinLength = 32;

/** What to set when the import is on without a way for the operator to start it. */
export const missingV1ImportOperatorToken = `CLOUD_V1_IMPORT=on needs V1_IMPORT_OPERATOR_TOKEN, the bearer token operators start v1 import runs with, of at least ${v1ImportOperatorTokenMinLength} characters (such as \`openssl rand -hex 32\`)`;

/**
 * v1's plugin blob bucket (v1's `apps/cloud/wrangler.jsonc`, binding `BLOBS`). v1 owns it in the
 * same Cloudflare account as v2; this stack only binds it, as `V1_BLOBS`, and never declares it.
 */
export const v1BlobBucket = "executor-cloud-blobs";

/** What to unset when a stage other than production turns the import on. */
export const v1ImportOnlyProduction =
  "CLOUD_V1_IMPORT=on reads v1's production data, which only the production stage (v2) " +
  "reaches; unset it on this stage";
export const v1ImportWritesNeedImport =
  "CLOUD_V1_IMPORT_WRITES=on needs CLOUD_V1_IMPORT=on on production, and no other stage writes";

/**
 * v1's first-party OAuth client IDs, as JSON keyed by the name of the v2 client each must be
 * (decision 2), such as `{"github":"Iv1.…","google":"….apps.googleusercontent.com","slack":"…"}`.
 * They are public: v1 sends them in every authorization URL. v1 configures them as its Worker's
 * `FIRST_PARTY_<NAME>_CLIENT_ID`. The import moves a first-party grant only to a v2 client whose
 * client ID equals v1's, and its dry run reports every other one.
 */
export const v1FirstPartyClientsName = "V1_FIRST_PARTY_CLIENT_IDS";
export const V1FirstPartyClients = Schema.Record(Schema.String, Schema.NonEmptyString);
export const invalidV1FirstPartyClients = `${v1FirstPartyClientsName} must be a JSON object of v2 client names to v1's client IDs`;

/** The configured IDs; unset or empty is none, and a value that is not such JSON is refused. */
export const v1FirstPartyClientsSetting = Config.String(v1FirstPartyClientsName).pipe(
  Config.option,
  Effect.flatMap((value) =>
    Option.isNone(value) || value.value === ""
      ? Effect.succeed({})
      : Schema.decodeUnknownEffect(Schema.fromJsonString(V1FirstPartyClients))(value.value).pipe(
          Effect.mapError(() => new Error(invalidV1FirstPartyClients)),
          Effect.orDie,
        ),
  ),
);

/** What to set when the import is on without v1's ID for a first-party client v2 offers. */
export const missingV1FirstPartyClient = (client: string) =>
  `CLOUD_V1_IMPORT=on needs v1's ${client} client ID in ${v1FirstPartyClientsName}, from v1's FIRST_PARTY_${client.toUpperCase()}_CLIENT_ID; without it every ${client} connection is reported as a mismatch`;

/**
 * Which v1 this deployment's importer reads, and whether it may write v2. Dies on a combination
 * of switches that must not run.
 *
 * - `production`: v1's real data on production, with `CLOUD_V1_IMPORT=on`.
 * - `live`: v1's real data from local Cloud dev on a loopback origin (`CLOUD_V1_IMPORT_SOURCE`).
 * - `emulated`: emulated Cloud's v1, which may write.
 * - `none`: no importer.
 *
 * `realV1` is true for both real sources. The live source never writes; production writes only
 * for the organizations with a row in `private_v1_import_allowed`, each named by the operator.
 * `scripts/check-v1-import-access.ts` checks these rules over every combination.
 */
export const v1ImportAccess = (emulated: boolean) =>
  Effect.gen(function* () {
    const production = Option.getOrUndefined(yield* stageName) === productionStage;
    const enabled = (yield* v1ImportSetting) === "on";
    const writes = (yield* v1ImportWritesSetting) === "on";
    const live = (yield* v1ImportSourceSetting) === "live";
    if (live) {
      const local =
        !production &&
        Option.isNone(yield* testStage) &&
        isLoopbackHostname(new URL(yield* cloudOrigin).hostname);
      if (!local) return yield* Effect.die(new Error(v1LiveSourceOnlyLocal));
      if (enabled || writes) return yield* Effect.die(new Error(v1LiveSourceDryRunOnly));
      return { source: "live", realV1: true, writes: false } as const;
    }
    if ((enabled || writes) && !production && !emulated)
      return yield* Effect.die(
        new Error(enabled ? v1ImportOnlyProduction : v1ImportWritesNeedImport),
      );
    if (production) {
      if (writes && !enabled) return yield* Effect.die(new Error(v1ImportWritesNeedImport));
      return enabled
        ? ({ source: "production", realV1: true, writes } as const)
        : ({ source: "none", realV1: true, writes: false } as const);
    }
    return emulated
      ? ({ source: "emulated", realV1: false, writes: true } as const)
      : ({ source: "none", realV1: false, writes: false } as const);
  });
