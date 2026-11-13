/**
 * Read a running test stage's fixture authority from the shared Alchemy state, without redeploying.
 * Only `test-` stages are addressable, and each must own a database branch named after the stage,
 * so production (stage `v2`, branch `main`) can never be selected.
 */
import { layer } from "alchemy/Alchemist/Runtime";
import { store } from "alchemy/Alchemist/routes/state";
import { Config, Effect, Redacted, Schema } from "effect";
import { TestStageSlug } from "../src/contracts/test-stage-lifetime.ts";
import { testStagePrefix } from "../src/infrastructure/stage.ts";

/** The stack name declared in `alchemy.run.ts`. */
const stack = "executor-next-hosted";

/** Sanitized: state records and connection strings never appear in the failure. */
export class TestStageUnavailable extends Schema.TaggedError<TestStageUnavailable>()(
  "TestStageUnavailable",
  { reason: Schema.String },
) {}

const Secret = Schema.Struct({
  attr: Schema.Struct({ text: Schema.Redacted(Schema.String.check(Schema.isMinLength(32))) }),
});
const Origin = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Number,
  database: Schema.NonEmptyString,
  user: Schema.NonEmptyString,
  password: Schema.Redacted(Schema.NonEmptyString),
});
const Branch = Schema.Struct({
  resourceType: Schema.Literals(["Neon.Branch", "Planetscale.PostgresBranch"]),
  attr: Schema.Struct({
    branchName: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    origin: Schema.optionalKey(Origin),
  }),
});
const Role = Schema.Struct({ attr: Schema.Struct({ origin: Origin }) });

export interface TestStageAuthority {
  readonly stage: string;
  readonly origin: string;
  readonly secret: Redacted.Redacted<string>;
  /** The schema owner's direct connection, as used by deploy-time migrations and fixtures. */
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly databaseName: string;
}

const ownerUrl = (origin: typeof Origin.Type, planetscale: boolean) => {
  const url = new URL(
    `postgresql://${origin.host}:${origin.port}/${encodeURIComponent(origin.database)}`,
  );
  url.username = origin.user;
  url.password = Redacted.value(origin.password);
  url.searchParams.set("sslmode", "verify-full");
  // PlanetScale's migration login creates objects as the stable owner, as deployment does.
  if (planetscale) url.searchParams.set("options", "-c role=postgres");
  return Redacted.make(url.toString());
};

/** Requires the shared state store's Cloudflare credentials, as `test-stage` commands do. */
export const testStageAuthority = (slug: string) =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(TestStageSlug)(slug).pipe(
      Effect.mapError(() => new TestStageUnavailable({ reason: "Invalid test stage slug" })),
    );
    const stage = `${testStagePrefix}${valid}`;
    const domain = yield* Config.String("TEST_STAGE_DOMAIN").pipe(
      Config.withDefault("executor.engineering"),
    );
    const state = yield* store({ backend: "cloudflare" }).pipe(
      Effect.mapError(() => new TestStageUnavailable({ reason: "Shared state is unavailable" })),
    );
    const record = (fqn: string) =>
      state.get({ stack, stage, fqn }).pipe(
        Effect.mapError(() => new TestStageUnavailable({ reason: "Shared state is unavailable" })),
        Effect.filterOrFail(
          (value) => value !== undefined,
          () => new TestStageUnavailable({ reason: `${stage} has no ${fqn} in shared state` }),
        ),
      );
    const unexpected = (fqn: string) => () =>
      new TestStageUnavailable({ reason: `${stage} has an unexpected ${fqn} record` });
    const secret = yield* record("AuthSecret").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Secret)),
      Effect.mapError(unexpected("AuthSecret")),
    );
    const branch = yield* record("PreviewDatabase").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Branch)),
      Effect.mapError(unexpected("PreviewDatabase")),
    );
    const planetscale = branch.resourceType === "Planetscale.PostgresBranch";
    if ((planetscale ? branch.attr.name : branch.attr.branchName) !== stage)
      return yield* new TestStageUnavailable({
        reason: `${stage} does not own a database branch named after the stage`,
      });
    const owner = planetscale
      ? (yield* record("MigrationRole").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Role)),
          Effect.mapError(unexpected("MigrationRole")),
        )).attr.origin
      : branch.attr.origin;
    if (owner === undefined)
      return yield* new TestStageUnavailable({ reason: `${stage} has no database owner` });
    return {
      stage,
      origin: `https://${valid}.${domain}`,
      secret: secret.attr.text,
      databaseUrl: ownerUrl(owner, planetscale),
      databaseName: owner.database,
    } satisfies TestStageAuthority;
  }).pipe(Effect.provide(layer()), Effect.scoped);
