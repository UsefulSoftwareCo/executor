/** Test stages are named `test-<slug>`. Each one derives its origin and owns generated secrets. */
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Schema } from "effect";

export const testStagePrefix = "test-";

/** The stage every push to `main` deploys. It serves real customers. */
export const productionStage = "v2";

/** Slugs map one-to-one to the stage's logical database name. */
export const TestStageSlug = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(value), {
    message: "A test stage slug is 1-42 lowercase letters, digits and hyphens",
  }),
);

export interface TestStage {
  readonly name: string;
  readonly slug: string;
  readonly origin: string;
}

/**
 * Provisioning receives the stage as a service and the deployed Worker reads Alchemy's plain
 * binding. Jobs and tests outside Alchemy have neither and use explicit configuration.
 */
export const stageName = Effect.serviceOption(Stage).pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(Option.some(stage)),
      onNone: () => Config.String("ALCHEMY_STAGE").pipe(Config.option),
    }),
  ),
);

/** Only stages with the prefix are test stages. Every other stage keeps its explicit configuration. */
export const testStage = Effect.gen(function* () {
  const name = yield* stageName;
  if (Option.isNone(name) || !name.value.startsWith(testStagePrefix))
    return Option.none<TestStage>();
  const slug = yield* Schema.decodeUnknownEffect(TestStageSlug)(
    name.value.slice(testStagePrefix.length),
  );
  const domain = yield* Config.String("TEST_STAGE_DOMAIN").pipe(
    Config.withDefault("executor.engineering"),
  );
  return Option.some<TestStage>({ name: name.value, slug, origin: `https://${slug}.${domain}` });
});

/** Automated stages isolate product scenarios from shared-IP throttling; all other stages enforce it. */
export const cloudAuthRateLimit = Effect.gen(function* () {
  const stage = yield* testStage;
  if (Option.isNone(stage) || !stage.value.slug.startsWith("e2e-")) return true;
  return yield* Config.Boolean("TEST_STAGE_AUTH_RATE_LIMIT").pipe(Config.withDefault(false));
});

const Origin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
      } catch {
        return false;
      }
    },
    { message: "BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash" },
  ),
);

/** The public origin: derived from the stage name for test stages, configured everywhere else. */
export const cloudOrigin = testStage.pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(stage.origin),
      onNone: () =>
        Config.String("BETTER_AUTH_URL").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Origin))),
    }),
  ),
);
