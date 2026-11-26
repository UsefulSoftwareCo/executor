import { Clock, Config, Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { mask } from "../support/failure-text.ts";

export const removalStallsFile = "removal-stalls.jsonl";
export const removalEvidenceFile = "removal-stalls.json";

export const RemovalStall = Schema.Struct({
  scenario: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  organization: Schema.String,
  instance: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  phase: Schema.String,
  since: Schema.optional(Schema.String),
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

const logLimit = 100;
const logLead = 2 * 60_000;
const recordLimit = 256 * 1024;

const maskedStrings = (value: unknown): unknown =>
  typeof value === "string"
    ? mask(value)
    : Array.isArray(value)
      ? value.map(maskedStrings)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskedStrings(item)]))
        : value;

const maskedJson = (value: unknown, indent?: number) => {
  const text = mask(JSON.stringify(maskedStrings(value), null, indent) ?? "null");
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    return { text, value: { unparsable: true, start: text.slice(0, recordLimit) } as unknown };
  }
};

const bounded = (value: unknown) => {
  const { text, value: masked } = maskedJson(value);
  return text.length <= recordLimit
    ? masked
    : { truncated: true, characters: text.length, start: text.slice(0, recordLimit) };
};

export const captureRemovalStalls = (
  slug: string,
  directory: string,
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
    const document = maskedJson({ slug, apiScript: apiScript ?? null, removals: records }, 2);
    yield* fs.writeFileString(
      path.join(directory, removalEvidenceFile),
      JSON.stringify(document.value, null, 2),
      { mode: 0o600 },
    );
    for (const record of records) {
      const state = record.instance as { status?: unknown; error?: unknown };
      yield* Console.log(
        mask(
          `Organization removal${record.stall.label === undefined ? "" : ` for "${record.stall.label}" (scenario ${record.stall.scenario ?? "unknown"})`} not finished at the end-of-run check: ${record.stall.phase}${record.stall.since === undefined ? "" : ` since ${record.stall.since}`} (database: ${
            record.stall.status ?? "no record"
          }; Workflow instance: ${
            typeof state.status === "string" ? state.status : `unread, ${String(state.error)}`
          }); saved to ${removalEvidenceFile}`,
        ),
      );
    }
  });
