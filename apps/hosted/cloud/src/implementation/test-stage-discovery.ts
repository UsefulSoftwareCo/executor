/** Find previews deployed by older checkouts so they cannot escape the current lifetime policy. */
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { TestStageSlug } from "../infrastructure/stage.ts";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";

const CreatedAt = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const Page = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({
      created_on: CreatedAt,
      tags: Schema.NullOr(Schema.Array(Schema.String)),
    }),
  ),
  result_info: Schema.optional(
    Schema.Struct({ total_pages: Schema.Int.check(Schema.isGreaterThan(0)) }),
  ),
});

/** Earliest live Worker creation time for each exact hosted test-stage tag. Production is excluded. */
export const discoverTestStages = Effect.gen(function* () {
  const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const stages = new Map<string, number>();
  let page = 1;
  let total = 1;
  do {
    const response = yield* http.execute(
      HttpClientRequest.get(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts?page=${page}&per_page=100`,
      ).pipe(HttpClientRequest.bearerToken(token)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(Page)(response);
    for (const worker of body.result) {
      if (worker.tags === null || !worker.tags.includes("alchemy:stack:executor-next-hosted"))
        continue;
      const stage = worker.tags.find((tag) => tag.startsWith("alchemy:stage:test-"));
      if (stage === undefined) continue;
      const slug = yield* Schema.decodeUnknownEffect(TestStageSlug)(
        stage.slice("alchemy:stage:test-".length),
      );
      const createdAt = Date.parse(worker.created_on);
      const previous = stages.get(slug);
      stages.set(slug, previous === undefined ? createdAt : Math.min(createdAt, previous));
    }
    total = body.result_info === undefined ? 1 : body.result_info.total_pages;
    page += 1;
  } while (page <= total);
  return Array.from(stages, ([slug, createdAt]) => ({ slug, createdAt }));
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.mapError(
    () =>
      new TestStageFailed({
        message: "Could not discover deployed previews. Check Cloudflare access.",
      }),
  ),
);
