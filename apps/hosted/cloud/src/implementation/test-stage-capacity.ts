import { Config, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";

const quotas = {
  classes: {
    counted: "Durable Object namespaces",
    limited: "Durable Object classes",
    documented: 500,
    variable: "TEST_STAGE_DURABLE_OBJECT_CLASS_LIMIT",
  },
  workers: {
    counted: "Workers",
    limited: "Workers",
    documented: 500,
    variable: "TEST_STAGE_WORKER_LIMIT",
  },
} as const;
type Quota = keyof typeof quotas;

const Namespaces = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Schema.Struct({ script: Schema.optional(Schema.NullOr(Schema.String)) })),
  result_info: Schema.Struct({ total_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
});
const Scripts = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({ id: Schema.String, tags: Schema.NullOr(Schema.Array(Schema.String)) }),
  ),
  result_info: Schema.optional(
    Schema.Struct({ total_pages: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))) }),
  ),
});

interface Count {
  readonly total: number;
  readonly byStage: ReadonlyMap<string, number>;
}
export type AccountUsage = Readonly<Record<Quota, Count>>;

export const accountUsage = Effect.gen(function* () {
  const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const api = yield* Config.String("TEST_STAGE_CLOUDFLARE_API").pipe(
    Config.withDefault("https://api.cloudflare.com"),
  );
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const get = <S extends typeof Namespaces | typeof Scripts>(path: string, schema: S) =>
    http
      .execute(
        HttpClientRequest.get(
          `${api}/client/v4/accounts/${encodeURIComponent(account)}${path}`,
        ).pipe(HttpClientRequest.bearerToken(token)),
      )
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)));
  const namespaces = Effect.gen(function* () {
    const items: Array<(typeof Namespaces.Type)["result"][number]> = [];
    for (let page = 1; ; page += 1) {
      const body = yield* get(
        `/workers/durable_objects/namespaces?page=${page}&per_page=1000`,
        Namespaces,
      );
      items.push(...body.result);
      if (items.length >= body.result_info.total_count || body.result.length === 0) {
        if (items.length < body.result_info.total_count)
          return yield* Effect.fail(new Error("The namespace listing ended before its total."));
        return items;
      }
    }
  });
  const scripts = Effect.gen(function* () {
    const items: Array<(typeof Scripts.Type)["result"][number]> = [];
    for (let page = 1, total = 1; page <= total; page += 1) {
      const body = yield* get(`/workers/scripts?page=${page}&per_page=100`, Scripts);
      items.push(...body.result);
      total = body.result_info?.total_pages ?? 1;
    }
    return items;
  });
  const [namespaceList, scriptList] = yield* Effect.all([namespaces, scripts], {
    concurrency: 2,
  });
  const stageOf = new Map<string, string>();
  for (const script of scriptList) {
    if (script.tags === null || !script.tags.includes("alchemy:stack:executor-next-hosted"))
      continue;
    const stage = script.tags.find((tag) => tag.startsWith("alchemy:stage:test-"));
    if (stage !== undefined) stageOf.set(script.id, stage.slice("alchemy:stage:test-".length));
  }
  const classes = new Map<string, number>();
  for (const namespace of namespaceList) {
    const slug =
      namespace.script === undefined || namespace.script === null
        ? undefined
        : stageOf.get(namespace.script);
    if (slug !== undefined) classes.set(slug, (classes.get(slug) ?? 0) + 1);
  }
  const workers = new Map<string, number>();
  for (const slug of stageOf.values()) workers.set(slug, (workers.get(slug) ?? 0) + 1);
  return {
    classes: { total: namespaceList.length, byStage: classes },
    workers: { total: scriptList.length, byStage: workers },
  } satisfies AccountUsage;
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.mapError(
    () =>
      new TestStageFailed({
        message:
          "Could not count the account's Workers and Durable Object namespaces, so a new test stage was not started. Check Cloudflare access.",
      }),
  ),
);

export const accountLimits = Effect.all({
  classes: Config.option(Config.Int(quotas.classes.variable)),
  workers: Config.option(Config.Int(quotas.workers.variable)),
});
export type AccountLimits = Readonly<Record<Quota, Option.Option<number>>>;

export const capacityCheck = (
  usage: AccountUsage,
  limits: AccountLimits,
  slug: string,
  evicting: ReadonlyArray<string>,
  afterFailedEviction = false,
) => {
  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const quota of ["classes", "workers"] as const) {
    const { counted, limited, documented, variable } = quotas[quota];
    const { total, byStage } = usage[quota];
    const perStage = Math.max(0, ...byStage.values());
    const freed = evicting.reduce((sum, stage) => sum + (byStage.get(stage) ?? 0), 0);
    const after = total - freed + perStage;
    const counts = `${total} now${freed > 0 ? `, ${freed} freed by ${evicting.length === 1 ? "the evicted stage" : `the ${evicting.length} evicted stages`}` : ""}, up to ${perStage} for a test stage`;
    const limit = limits[quota];
    if (Option.isSome(limit)) {
      if (after > limit.value)
        refusals.push(
          `about ${after} ${counted} (${counts}), over the ${variable} limit of ${limit.value} ${limited}`,
        );
    } else if (after > documented)
      warnings.push(
        `Deploying ${slug} brings the account to about ${after} ${counted} (${counts}), past Cloudflare's documented limit of ${documented} ${limited} per Workers Paid account. This account's real limit is unknown and may have been raised, so the deploy goes on; if it is lower, the deploy fails part way through. Set ${variable} to the account's limit to refuse such a deploy instead.`,
      );
  }
  return {
    refusal:
      refusals.length === 0
        ? undefined
        : `Deploying ${slug} would bring the account to ${refusals.join("; and to ")}. ${afterFailedEviction ? "An eviction failed, so this deploy stopped; nothing was reserved or deployed." : "Nothing was evicted, reserved, deployed or destroyed."} Destroy test stages you own, or redeploy one instead of a new slug.`,
    warning: warnings.length === 0 ? undefined : warnings.join("\n"),
  };
};
