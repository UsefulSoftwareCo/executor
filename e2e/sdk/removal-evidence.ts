/**
 * Save what Cloudflare knows about an organization removal that a scenario's clean-up waited for
 * in vain, before the stage that holds it is destroyed.
 *
 * The fixture server (`apps/hosted/testing/scenario-server.ts`) appends one line to
 * `removal-stalls.jsonl` when a removal is still not done at the end of its wait: the
 * organization, its Workflow instance id and the status the stage's database gave. The fixture
 * server holds no Cloudflare credentials, so the deployed runner, which owns the stage, reads
 * that file just before it destroys the stage and writes `removal-stalls.json` beside it:
 *
 * - the `OrganizationRemoval` Workflow instance of each stalled removal, as Cloudflare reports it
 *   (status, every step with its attempts and errors). Destroying the stage deletes the Workflow
 *   and its instances, so nothing else keeps this;
 * - the stage API Worker's own Workers Logs events that name the organization, from shortly
 *   before the stall until now.
 *
 * For test stages only: it runs in the deployed runner, against the stage that runner owns. What
 * it saves goes into the run's evidence artifact, so every string in it is masked first
 * (`mask` in `failure-text.ts`): the secrets the runner holds, such as the emulator instance
 * URLs and keys, URL queries and fragments, and long opaque values. Step causes and log events
 * can carry any of these.
 *
 * It changes nothing: no retry, no longer wait. A removal that stalled still fails its scenario
 * as before. A failed read is recorded with its HTTP status and the capture carries on; it never
 * fails or delays the teardown beyond its own deadline.
 */
import { Clock, Config, Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { mask } from "../support/failure-text.ts";

export const removalStallsFile = "removal-stalls.jsonl";
export const removalEvidenceFile = "removal-stalls.json";

/** One removal the fixture server stopped waiting for. */
export const RemovalStall = Schema.Struct({
  organization: Schema.String,
  instance: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  phase: Schema.String,
  at: Schema.String,
});
export type RemovalStall = typeof RemovalStall.Type;

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  result_info: Schema.optional(
    Schema.NullOr(Schema.Struct({ total_pages: Schema.optional(Schema.Number) })),
  ),
});
const Script = Schema.Struct({
  id: Schema.String,
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const Workflow = Schema.Struct({
  name: Schema.String,
  class_name: Schema.optional(Schema.NullOr(Schema.String)),
  script_name: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Workers Logs events kept per organization, and how far before the stall they start. */
const logLimit = 100;
const logLead = 2 * 60_000;
/** One record is cut beyond this, so a large step output cannot grow the artifact unbounded. */
const recordLimit = 256 * 1024;

/** Every string in a value masked; keys are code-defined and kept. */
const masked = (value: unknown): unknown =>
  typeof value === "string"
    ? mask(value)
    : Array.isArray(value)
      ? value.map(masked)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, masked(item)]))
        : value;

const bounded = (value: unknown) => {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= recordLimit
    ? value
    : { truncated: true, characters: text.length, start: text.slice(0, recordLimit) };
};

/**
 * Read the stalls the fixture server recorded for this stage and save Cloudflare's records of
 * them. Does nothing when there are none.
 */
export const captureRemovalStalls = (
  slug: string,
  directory: string,
  /** Cloudflare's API. Only the spec passes another, its local stand-in. */
  api = "https://api.cloudflare.com/client/v4",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const source = path.join(directory, removalStallsFile);
    if (!(yield* fs.exists(source))) return;
    const stalls = (yield* fs.readFileString(source))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) =>
        Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(RemovalStall))(line)),
      );
    if (stalls.length === 0) return;

    const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const http = yield* HttpClient.HttpClient;
    const base = `${api}/accounts/${account}`;
    /** One Cloudflare call; a refusal becomes `{ error: "HTTP <status>" }`, never a failure. */
    const call = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(HttpClientRequest.bearerToken(request, Redacted.value(token))).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Envelope)),
            Effect.map((body) =>
              response.status === 200 && body.success
                ? ({ ok: true, body } as const)
                : ({ ok: false, error: `HTTP ${response.status}` } as const),
            ),
          ),
        ),
        Effect.timeout("20 seconds"),
        Effect.catchCause(() => Effect.succeed({ ok: false, error: "no answer" } as const)),
      );
    /** Every page of an account listing. */
    const listAll = <A>(listing: string, item: Schema.Codec<A, unknown>) =>
      Effect.gen(function* () {
        const items: A[] = [];
        for (let page = 1; page <= 50; page += 1) {
          const answer = yield* call(
            HttpClientRequest.get(
              `${base}${listing}${listing.includes("?") ? "&" : "?"}page=${page}`,
            ),
          );
          if (!answer.ok) return { error: answer.error } as const;
          items.push(...Schema.decodeUnknownSync(Schema.Array(item))(answer.body.result ?? []));
          const pages = answer.body.result_info?.total_pages;
          if (pages === undefined || page >= pages) break;
        }
        return { items } as const;
      });

    const stage = `alchemy:stage:test-${slug}`;
    const scripts = yield* listAll("/workers/scripts?per_page=100", Script);
    const apiScript =
      "items" in scripts
        ? scripts.items.find(
            (script) =>
              script.tags?.includes(stage) === true && script.tags.includes("alchemy:id:Api"),
          )?.id
        : undefined;
    const workflows =
      apiScript === undefined ? undefined : yield* listAll("/workflows?per_page=100", Workflow);
    const workflow =
      workflows !== undefined && "items" in workflows
        ? workflows.items.find(
            (flow) => flow.class_name === "OrganizationRemoval" && flow.script_name === apiScript,
          )?.name
        : undefined;
    const now = yield* Clock.currentTimeMillis;

    const records = yield* Effect.forEach(
      stalls,
      (stall) =>
        Effect.gen(function* () {
          const instance =
            workflow === undefined || stall.instance === null
              ? { error: workflow === undefined ? "removal Workflow not found" : "no instance id" }
              : yield* call(
                  HttpClientRequest.get(
                    `${base}/workflows/${encodeURIComponent(workflow)}/instances/${encodeURIComponent(stall.instance)}`,
                  ),
                ).pipe(
                  Effect.map((answer) =>
                    answer.ok ? bounded(answer.body.result) : { error: answer.error },
                  ),
                );
          const from = Date.parse(stall.at) - logLead;
          const logs =
            apiScript === undefined
              ? { error: "API Worker not found" }
              : yield* call(
                  HttpClientRequest.post(`${base}/workers/observability/telemetry/query`).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      queryId: "removal-stall",
                      view: "events",
                      limit: logLimit,
                      timeframe: {
                        from: Number.isFinite(from) ? from : now - 10 * 60_000,
                        to: now,
                      },
                      parameters: {
                        needle: { value: stall.organization },
                        filters: [
                          {
                            key: "$workers.scriptName",
                            operation: "eq",
                            type: "string",
                            value: apiScript,
                          },
                        ],
                      },
                    }),
                  ),
                ).pipe(
                  Effect.map((answer) =>
                    answer.ok ? bounded(answer.body.result) : { error: answer.error },
                  ),
                );
          return { stall, workflow: workflow ?? null, instance, logs };
        }),
      { concurrency: 2 },
    );
    yield* fs.writeFileString(
      path.join(directory, removalEvidenceFile),
      JSON.stringify(masked({ slug, apiScript: apiScript ?? null, removals: records }), null, 2),
      { mode: 0o600 },
    );
    for (const record of records) {
      const state = record.instance as { status?: unknown; error?: unknown };
      yield* Console.log(
        `Organization removal not finished within its clean-up's wait (database: ${
          record.stall.status ?? "no record"
        }; Workflow instance: ${
          typeof state.status === "string" ? state.status : `unread, ${String(state.error)}`
        }); saved to ${removalEvidenceFile}`,
      );
    }
  });
