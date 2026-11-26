import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { testStageLifetimeMilliseconds } from "../contracts/test-stage-lifetime.ts";

const e2eBranch = /^test-(e2e-[a-z0-9]{1,13})$/u;

const Branch = Schema.Struct({ name: Schema.String, created_at: Schema.String });
const BranchPage = Schema.Struct({
  data: Schema.Array(Branch),
  next_page: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type TestBranch = typeof Branch.Type;

export class OrphanBranchesUnreadable extends Schema.TaggedError<OrphanBranchesUnreadable>()(
  "OrphanBranchesUnreadable",
  { message: Schema.String },
) {}

export const orphanBranches = (
  branches: ReadonlyArray<TestBranch>,
  leases: ReadonlySet<string>,
  now: number,
) =>
  branches
    .flatMap((branch) => {
      const slug = e2eBranch.exec(branch.name)?.[1];
      return slug === undefined ? [] : [{ ...branch, slug }];
    })
    .filter((branch) => !leases.has(branch.slug))
    .filter((branch) => {
      const created = Date.parse(branch.created_at);
      return Number.isFinite(created) && now - created > testStageLifetimeMilliseconds;
    })
    .map((branch) => branch.name)
    .toSorted();

const maxPages = 50;

export const planetScaleApi = Effect.gen(function* () {
  const configured = yield* Config.option(Config.NonEmptyString("TEST_STAGE_PLANETSCALE_API"));
  if (Option.isNone(configured)) return "https://api.planetscale.com";
  const url = yield* Effect.try({
    try: () => new URL(configured.value),
    catch: () =>
      new OrphanBranchesUnreadable({ message: "TEST_STAGE_PLANETSCALE_API is not a URL." }),
  });
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname))
    return yield* new OrphanBranchesUnreadable({
      message: "TEST_STAGE_PLANETSCALE_API may only name a local stand-in.",
    });
  return url.origin;
});

export const findOrphanBranches = (leases: ReadonlySet<string>, now: number) =>
  Effect.gen(function* () {
    const database = yield* Config.option(Config.NonEmptyString("TEST_STAGE_DATABASE"));
    if (Option.isNone(database)) return Option.none<ReadonlyArray<string>>();
    const organization = yield* Config.NonEmptyString("PLANETSCALE_ORGANIZATION");
    const id = yield* Config.Redacted("PLANETSCALE_API_TOKEN_ID");
    const token = yield* Config.Redacted("PLANETSCALE_API_TOKEN");
    const api = yield* planetScaleApi;
    const http = yield* HttpClient.HttpClient;
    const base = `${api}/v1/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database.value)}/branches`;
    const branches: TestBranch[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = yield* http.execute(
        HttpClientRequest.get(`${base}?per_page=100&page=${page}`).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `${Redacted.value(id)}:${Redacted.value(token)}`,
          ),
        ),
      );
      if (response.status !== 200)
        return yield* new OrphanBranchesUnreadable({
          message: `PlanetScale answered ${response.status} when listing the test database's branches.`,
        });
      const listed = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(BranchPage)),
      );
      branches.push(...listed.data);
      if (listed.next_page === undefined || listed.next_page === null) break;
    }
    return Option.some(orphanBranches(branches, leases, now));
  }).pipe(
    Effect.timeout("60 seconds"),
    Effect.catch((cause) =>
      Effect.fail(
        cause instanceof OrphanBranchesUnreadable
          ? cause
          : new OrphanBranchesUnreadable({
              message: "Listing the test database's PlanetScale branches failed.",
            }),
      ),
    ),
  );
