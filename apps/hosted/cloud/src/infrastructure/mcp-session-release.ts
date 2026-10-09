/**
 * Release order for moving MCP session objects from the API Worker's `McpSessions` class to the
 * MCP server Worker's `McpSession`: add the MCP server Worker, forward to it, then delete the old
 * class. Deploys of a stage run one at a time, but a newer push replaces a pending one, so two of
 * these releases can arrive in one deploy, or one can follow a deploy that failed. The gate reads
 * the stage's live Workers before Alchemy plans anything and stops the deploy, with nothing
 * changed, when the step before is not live. A new stage, or one past the step, passes unchecked.
 */
import { listNamespaces } from "@distilled.cloud/cloudflare/durable-objects";
import {
  listScriptDeployments,
  getScriptVersion,
  listScripts,
} from "@distilled.cloud/cloudflare/workers";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, DateTime, Duration, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  McpSessionReleaseBlocked,
  ReleaseRefusal,
  releaseRefusalReport,
} from "../contracts/release-guard.ts";
import { telemetryDatasets } from "./telemetry.ts";

const Bindings = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    name: Schema.String,
    className: Schema.optional(Schema.String),
    scriptName: Schema.optional(Schema.String),
  }),
);
type Bindings = typeof Bindings.Type;

/** This stage's Workers by Alchemy logical id, from the ownership tags Alchemy writes. */
const stageWorkers = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const stage = yield* Stage;
  const owned = ["alchemy:stack:executor-next-hosted", `alchemy:stage:${stage}`];
  const scripts = yield* listScripts.items({ accountId }).pipe(Stream.runCollect);
  const workers = new Map<string, string>();
  for (const script of scripts) {
    const tags = script.tags ?? [];
    const id = tags.find((tag) => tag.startsWith("alchemy:id:"));
    if (script.id && id && owned.every((tag) => tags.includes(tag)))
      workers.set(id.slice("alchemy:id:".length), script.id);
  }
  return { accountId, workers };
});

/** When the script's active deployment was created and the bindings of every version it serves. */
const liveDeployment = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const { deployments } = yield* listScriptDeployments({ accountId, scriptName });
    // Cloudflare lists the deployment serving traffic first.
    const [active] = deployments;
    if (active === undefined) return undefined;
    const versions = yield* Effect.forEach(active.versions, ({ versionId }) =>
      getScriptVersion({ accountId, scriptName, versionId }).pipe(
        Effect.flatMap((version) =>
          Schema.decodeUnknownEffect(Bindings)(version.resources.bindings),
        ),
      ),
    );
    return { createdAt: DateTime.makeUnsafe(active.createdOn), versions };
  });

const hostsSessions = (bindings: Bindings) =>
  bindings.some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      binding.className === "McpSession" &&
      binding.scriptName === undefined,
  );

/**
 * Alchemy uploads a placeholder for a Worker in a binding cycle that binds only its object
 * classes. The real MCP server also binds the API's app workflow.
 */
const runsMcpServer = (bindings: Bindings) =>
  hostsSessions(bindings) &&
  bindings.some((binding) => binding.type === "workflow" && binding.name === "AppWorkflows");

const forwardsTo = (server: string) => (bindings: Bindings) =>
  bindings.some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      binding.className === "McpSession" &&
      binding.scriptName === server,
  );

/** Time for old API isolates to finish and for their invocations to reach telemetry. */
const propagation = Duration.minutes(10);

const Evidence = Schema.Struct({
  status: Schema.Struct({
    isPartial: Schema.Boolean,
    isEstimate: Schema.optional(Schema.Boolean),
  }),
  tables: Schema.Tuple([
    Schema.Struct({
      fields: Schema.Array(Schema.Struct({ name: Schema.String })),
      columns: Schema.Array(Schema.Array(Schema.Unknown)),
    }),
  ]),
});

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

class IncompleteSessionEvidence extends Schema.TaggedError<IncompleteSessionEvidence>()(
  "IncompleteSessionEvidence",
  { reason: Schema.String },
) {}

/**
 * The four counts from the query's single result row. A partial or estimated scan, or a missing,
 * repeated or malformed count, is not evidence of zero: the deploy refuses rather than guess.
 */
const sessionEvidence = (body: unknown) =>
  Effect.gen(function* () {
    const incomplete = (reason: string) => Effect.fail(new IncompleteSessionEvidence({ reason }));
    const decoded = yield* Schema.decodeUnknownEffect(Evidence)(body).pipe(
      Effect.mapError(
        () =>
          new IncompleteSessionEvidence({
            reason: "the response lacks a scan status or a single result table",
          }),
      ),
    );
    if (decoded.status.isPartial) return yield* incomplete("Axiom scanned the window partially");
    if (decoded.status.isEstimate === true) return yield* incomplete("Axiom estimated the counts");
    const [{ fields, columns }] = decoded.tables;
    if (fields.length !== columns.length)
      return yield* incomplete(`${fields.length} fields but ${columns.length} columns`);
    const count = (name: string) =>
      Effect.gen(function* () {
        const matches = columns.filter((_, index) => fields[index]?.name === name);
        if (matches.length !== 1)
          return yield* incomplete(`${matches.length} \`${name}\` columns instead of 1`);
        const column = matches[0] ?? [];
        if (column.length !== 1)
          return yield* incomplete(`${column.length} \`${name}\` rows instead of 1`);
        return yield* Schema.decodeUnknownEffect(Count)(column[0]).pipe(
          Effect.mapError(
            () => new IncompleteSessionEvidence({ reason: `\`${name}\` is not a count` }),
          ),
        );
      });
    return {
      legacy: yield* count("legacy"),
      sessions: yield* count("sessions"),
      initialize: yield* count("initialize"),
      toolCalls: yield* count("toolCalls"),
    };
  });

/**
 * MCP traffic on the stage since `since`: invocations of each session class, and protocol
 * `initialize` and `tools/call` spans that did not fail. Only session objects run the protocol
 * servers, so with no `McpSessions` invocations every one of them was served by `McpSession`.
 */
const sessionTraffic = (since: DateTime.Utc) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("AXIOM_TOKEN");
    const org = yield* Config.NonEmptyString("AXIOM_ORG_ID");
    const { names } = yield* telemetryDatasets;
    const stage = yield* Stage;
    const apl = [
      `['${names.traces}']`,
      `where _time > datetime(${DateTime.formatIso(since)}) and ['resource.deployment.environment.name'] == '${stage}'`,
      "extend entrypoint = tostring(['attributes.custom']['cloudflare.entrypoint'])",
      "summarize " +
        [
          "legacy = countif(name == 'cloudflare.invocation' and entrypoint == 'McpSessions')",
          "sessions = countif(name == 'cloudflare.invocation' and entrypoint == 'McpSession')",
          "initialize = countif(name endswith '/initialize' and ['status.code'] != 'ERROR')",
          "toolCalls = countif(name endswith '/tools/call' and ['status.code'] != 'ERROR')",
        ].join(", "),
    ].join(" | ");
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* http.execute(
      HttpClientRequest.post("https://api.axiom.co/v1/datasets/_apl?format=tabular").pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("X-Axiom-Org-Id", org),
        HttpClientRequest.bodyJsonUnsafe({ apl }),
      ),
    );
    return yield* sessionEvidence(yield* response.json);
  });

/**
 * Delete `McpSessions` only after every API version serving the stage forwards to a running MCP
 * server, long enough that old API isolates are gone, and MCP traffic since then shows sessions
 * initializing and calling tools through `McpSession` with none reaching `McpSessions`. Deleting
 * the class earlier fails requests from API isolates that still forward to it.
 */
/** Lets the test-stage command that started this deploy tell the refusal from a failure. */
const reportRefusal = (refusal: McpSessionReleaseBlocked) =>
  Effect.gen(function* () {
    const report = yield* Config.String(releaseRefusalReport).pipe(Config.option);
    if (Option.isNone(report)) return;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(report.value, yield* Schema.encodeEffect(ReleaseRefusal)(refusal));
  });

export const mcpSessionRetirementGate = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) return;
  const { accountId, workers } = yield* stageWorkers;
  const api = workers.get("Api");
  if (api === undefined) return;
  const legacy = yield* listNamespaces.items({ accountId }).pipe(
    Stream.filter((namespace) => namespace.script === api && namespace.class === "McpSessions"),
    Stream.runCollect,
  );
  if (legacy.length === 0) return;
  const blocked = (reason: string) =>
    new McpSessionReleaseBlocked({
      message: `Not deleting McpSessions from ${api}: ${reason} Nothing was changed. Deploy again once the release that forwards to McpSession is live and serving MCP traffic.`,
    });
  const server = workers.get("McpServer");
  const serving = server === undefined ? undefined : yield* liveDeployment(accountId, server);
  if (
    server === undefined ||
    serving === undefined ||
    serving.versions.length === 0 ||
    !serving.versions.every(runsMcpServer)
  )
    return yield* blocked("the stage's MCP server Worker is missing or not serving its code.");
  const gateway = yield* liveDeployment(accountId, api);
  if (gateway === undefined || !gateway.versions.every(forwardsTo(server)))
    return yield* blocked("the live API version still forwards MCP sessions to it.");
  const since = DateTime.addDuration(gateway.createdAt, propagation);
  if (DateTime.isLessThan(yield* DateTime.now, since))
    return yield* blocked(
      `the API version that forwards to McpSession went live at ${DateTime.formatIso(gateway.createdAt)}; wait until ${DateTime.formatIso(since)}.`,
    );
  const traffic = yield* sessionTraffic(since).pipe(
    Effect.catchTag("IncompleteSessionEvidence", ({ reason }) =>
      Effect.fail(
        new McpSessionReleaseBlocked({
          message: `Not deleting McpSessions from ${api}: the MCP traffic evidence since ${DateTime.formatIso(since)} is incomplete (${reason}). Nothing was changed. Deploy again to re-run the check.`,
        }),
      ),
    ),
  );
  if (traffic.legacy > 0)
    return yield* blocked(
      `${traffic.legacy} McpSessions invocations since ${DateTime.formatIso(since)}.`,
    );
  if (traffic.sessions === 0 || traffic.initialize === 0 || traffic.toolCalls === 0)
    return yield* blocked(
      `MCP traffic since ${DateTime.formatIso(since)} does not yet show McpSession serving initialize and tools/call (${traffic.sessions} McpSession invocations, ${traffic.initialize} initialize, ${traffic.toolCalls} tools/call).`,
    );
}).pipe(Effect.tapErrorTag("McpSessionReleaseBlocked", reportRefusal));
