/**
 * Finds PlanetScale branches of deployed E2E runs that nothing knows about any more.
 *
 * A PlanetScale stage's branch is created by its deploy. If the deploying process dies after
 * PlanetScale creates the branch but before Alchemy records it, the stage's destroy cannot see the
 * branch, the lease row is removed with the stage, and `test-stage destroy --by-name` refuses
 * PlanetScale stages. The branch then stays, billed, with nothing pointing at it.
 *
 * This only reports. It reads one database's branch list with a GET and never changes or deletes
 * anything. It considers only branches named `test-e2e-<slug>` (the deployed runner's slugs,
 * `e2e/sdk/deployment.ts`) on the test database the environment names, so production's database
 * and any other branch of the test database (a measurement branch, a retained preview) are never
 * candidates. A branch is reported only when the stage registry has no lease for its slug and it is
 * older than a temporary lease, so a stage that is being created or is still within its lease is
 * never reported.
 */
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { testStageLifetimeMilliseconds } from "../contracts/test-stage-lifetime.ts";

/** A deployed E2E run's branch: `test-` and the runner's `e2e-<base36>` slug. */
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

/**
 * The `test-e2e-*` branches with no lease that are older than a temporary lease, by name.
 * `leases` are the registry's slugs (`e2e-…`), read before anything in the same pass is destroyed.
 */
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
      // A branch whose age cannot be read is not reported: the detector must not fail on it.
      return Number.isFinite(created) && now - created > testStageLifetimeMilliseconds;
    })
    .map((branch) => branch.name)
    .toSorted();

/** At most this many pages of 100 branches; the database allows 100 development branches. */
const maxPages = 50;

/**
 * PlanetScale's API, or a stand-in on this machine (`test-stage-orphans.spec.ts`). The override
 * accepts only a loopback origin, so the job's PlanetScale credentials cannot be sent elsewhere.
 */
const planetScaleApi = Effect.gen(function* () {
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

/**
 * Read the test database's branches and report the orphaned E2E ones. `none` when the job does not
 * name a PlanetScale test database.
 */
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
