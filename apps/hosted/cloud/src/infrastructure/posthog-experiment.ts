/** Code-managed native PostHog experiment. PostHog owns allocation and all result statistics. */
import { isDeepStrictEqual } from "node:util";
import { Credentials } from "@distilled.cloud/posthog/Credentials";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  heroExperiment,
  heroHeadlines,
  heroIntroduction,
  heroSteps,
  heroVariants,
} from "@executor-js/marketing/experiments";
import { PostHogProvisioningFailed } from "./posthog-provider.ts";

const ownership = (key: string) => `[executor-next:${key}]`;
const Source = Schema.Struct({ kind: Schema.Literal("EventsNode"), event: Schema.String });
const Metric = Schema.Struct({
  uuid: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("ExperimentMetric"),
  metric_type: Schema.Literal("funnel"),
  goal: Schema.Literal("increase"),
  conversion_window: Schema.Number,
  conversion_window_unit: Schema.Literal("day"),
  series: Schema.Array(Source),
});
const FlagConfig = Schema.Struct({
  ensure_experience_continuity: Schema.Boolean,
  filters: Schema.Struct({
    groups: Schema.Array(
      Schema.Struct({
        properties: Schema.Array(Schema.Unknown),
        rollout_percentage: Schema.Number,
      }),
    ),
    multivariate: Schema.Struct({
      variants: Schema.Array(
        Schema.Struct({ key: Schema.String, rollout_percentage: Schema.Number }),
      ),
    }),
  }),
});
const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  feature_flag_key: Schema.String,
  feature_flag: FlagConfig,
  parameters: Schema.optional(
    Schema.Struct({ variant_notes: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
  metrics: Schema.Array(Metric),
  metrics_secondary: Schema.Array(Metric),
  exposure_criteria: Schema.Struct({
    filterTestAccounts: Schema.Boolean,
    multiple_variant_handling: Schema.Literal("exclude"),
  }),
  only_count_matured_users: Schema.Boolean,
});

/** Declared native configuration carried in Alchemy resource props and state. */
export type PostHogExperimentDefinition = typeof Definition.Type;

/** Native funnel metrics include exposure automatically. The declared seven-day unit is explicit. */
export const heroExperimentDefinition: typeof Definition.Type = {
  name: "Homepage hero clarity",
  description: `Compare the product category with the benefit of building tools once and reusing them across agents. Cross each headline with the current introduction or build, deploy, and reuse steps.\n${ownership(heroExperiment.id)}`,
  feature_flag_key: heroExperiment.id,
  feature_flag: {
    ensure_experience_continuity: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100 }],
      multivariate: {
        variants: heroVariants.map((variant) => ({ key: variant.flag, rollout_percentage: 25 })),
      },
    },
  },
  parameters: {
    variant_notes: Object.fromEntries(
      heroVariants.map((variant) => {
        if (variant.steps === "intent")
          return [variant.flag, `${heroHeadlines[variant.headline]}\n${heroIntroduction}`];
        const steps = heroSteps[variant.steps];
        return [
          variant.flag,
          `${heroHeadlines[variant.headline]}\n1. ${steps.first}\n2. ${steps.second.before}${steps.second.emphasis}${steps.second.after}\n3. ${steps.third.before}${steps.third.emphasis}${steps.third.after}`,
        ];
      }),
    ),
  },
  metrics: [
    {
      uuid: "c9682ed4-8814-4f6f-9dcc-7099ab87fbf3",
      name: "Cloud signup within 7 days",
      kind: "ExperimentMetric",
      metric_type: "funnel",
      goal: "increase",
      conversion_window: heroExperiment.attributionDays,
      conversion_window_unit: "day",
      series: [{ kind: "EventsNode", event: heroExperiment.primaryEvent }],
    },
  ],
  metrics_secondary: [
    {
      uuid: "e1f6b838-b276-4a6e-bb50-5d5fbd8e6d16",
      name: "Signup and account connection within 7 days",
      kind: "ExperimentMetric",
      metric_type: "funnel",
      goal: "increase",
      conversion_window: heroExperiment.attributionDays,
      conversion_window_unit: "day",
      series: [
        { kind: "EventsNode", event: heroExperiment.primaryEvent },
        { kind: "EventsNode", event: "account_connected" },
      ],
    },
  ],
  exposure_criteria: { filterTestAccounts: true, multiple_variant_handling: "exclude" },
  only_count_matured_users: true,
};
const Experiment = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
  start_date: Schema.NullOr(Schema.String),
  end_date: Schema.NullOr(Schema.String),
  version: Schema.Number,
  feature_flag: Schema.Struct({ id: Schema.Number, key: Schema.String }),
  parameters: Schema.optional(Schema.Unknown),
  metrics: Schema.Array(Schema.Unknown),
  metrics_secondary: Schema.Array(Schema.Unknown),
  exposure_criteria: Schema.Unknown,
  only_count_matured_users: Schema.Boolean,
});
const NativeFlag = Schema.Struct({
  id: Schema.Number,
  key: Schema.String,
  active: Schema.Boolean,
  ...FlagConfig.fields,
});

/** A narrow REST adapter retains conversion_window_unit, which the generated write DTO omits. */
export const nativeHeroExperiment = Effect.gen(function* () {
  const credentials = yield* yield* Credentials;
  const client = yield* HttpClient.HttpClient;
  const request = (
    project: number,
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const authenticated = HttpClientRequest.make(method)(
        `${credentials.apiBaseUrl}/api/projects/${project}/${path}`,
      ).pipe(HttpClientRequest.bearerToken(Redacted.make(credentials.apiKey)));
      const outgoing =
        body === undefined
          ? authenticated
          : authenticated.pipe(HttpClientRequest.bodyJsonUnsafe(body));
      const response = yield* client.execute(outgoing);
      if (response.status < 200 || response.status >= 300)
        return yield* new PostHogProvisioningFailed({
          operation: `${method} ${path}: HTTP ${response.status}`,
          detail: Redacted.make(yield* response.json),
        });
      return yield* response.json;
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        (detail) =>
          new PostHogProvisioningFailed({
            operation: `${method} ${path}`,
            detail: Redacted.make(detail),
          }),
      ),
    );
  const get = Effect.fn(function* (project: number, id: number) {
    const experiment = yield* request(project, `experiments/${id}/`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Experiment)),
    );
    const flag = yield* request(project, `feature_flags/${experiment.feature_flag.id}/`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(NativeFlag)),
    );
    const actual = yield* Schema.decodeUnknownEffect(Definition)({
      ...experiment,
      feature_flag_key: flag.key,
      feature_flag: flag,
    });
    return { ...experiment, flag, definition: actual };
  });
  const find = Effect.fn(function* (project: number, flagKey: string) {
    let offset = 0;
    let found: number | undefined;
    while (true) {
      const page = yield* request(
        project,
        `experiments/?limit=100&offset=${offset}&status=all&archived=false`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              results: Schema.Array(
                Schema.Struct({
                  id: Schema.Number,
                  feature_flag: Schema.Struct({ key: Schema.String }),
                }),
              ),
              next: Schema.NullOr(Schema.String),
            }),
          ),
        ),
      );
      for (const item of page.results)
        if (item.feature_flag.key === flagKey) {
          if (found !== undefined)
            return yield* Effect.die("Multiple experiments own the hero flag");
          found = item.id;
        }
      if (page.next === null) return found === undefined ? undefined : yield* get(project, found);
      if (page.results.length === 0) return yield* Effect.die("Empty experiment pagination page");
      offset += page.results.length;
    }
  });
  const sync = Effect.fn(function* (project: number, definition: PostHogExperimentDefinition) {
    const existing = yield* find(project, definition.feature_flag_key);
    if (
      existing !== undefined &&
      !existing.description.endsWith(ownership(definition.feature_flag_key))
    )
      return yield* Effect.die("The hero experiment is not owned by this definition");
    if (existing !== undefined && isDeepStrictEqual(existing.definition, definition))
      return existing;
    if (existing !== undefined && existing.start_date !== null)
      return yield* Effect.die("Use a new experiment key to change a launched experiment");
    if (existing === undefined) {
      const flags = yield* request(
        project,
        `feature_flags/?search=${encodeURIComponent(definition.feature_flag_key)}`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ results: Schema.Array(Schema.Struct({ key: Schema.String })) }),
          ),
        ),
      );
      if (flags.results.some((flag) => flag.key === definition.feature_flag_key))
        return yield* Effect.die("An existing flag is not owned by the hero experiment");
    }
    // Register the intentional event names without emitting synthetic production events
    // or disabling PostHog's unknown-event validation.
    for (const name of new Set(
      [...definition.metrics, ...definition.metrics_secondary].flatMap((metric) =>
        metric.series.map((source) => source.event),
      ),
    )) {
      const definitions = yield* request(
        project,
        `event_definitions/?names=${encodeURIComponent(name)}`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ results: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          ),
        ),
      );
      if (!definitions.results.some((value) => value.name === name))
        yield* request(project, "event_definitions/", "POST", { name, post_to_slack: false });
    }
    const created = yield* request(
      project,
      existing === undefined ? "experiments/" : `experiments/${existing.id}/`,
      existing === undefined ? "POST" : "PATCH",
      {
        ...definition,
        ...(existing === undefined ? {} : { version: existing.version }),
      },
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Number }))));
    const result = yield* get(project, created.id);
    if (
      !isDeepStrictEqual(result.definition, definition) ||
      result.start_date !== null ||
      result.flag.active
    )
      return yield* Effect.die("PostHog did not retain the declared draft configuration");
    return result;
  });
  const results = (project: number, experiment: Effect.Success<ReturnType<typeof get>>) =>
    Effect.gen(function* () {
      if (experiment.start_date === null) return { status: "draft", results: [] };
      const output = [];
      for (const metric of [...experiment.metrics, ...experiment.metrics_secondary]) {
        const result = yield* request(project, "query/", "POST", {
          query: { kind: "ExperimentQuery", experiment_id: experiment.id, metric },
          refresh: "force_blocking",
        });
        output.push({ metric, result });
      }
      return {
        status:
          experiment.end_date !== null ? "stopped" : experiment.flag.active ? "running" : "paused",
        results: output,
      };
    });
  return { find, sync, results };
});

interface Props {
  readonly projectId: number;
  readonly definition: PostHogExperimentDefinition;
}
interface Attributes extends Props {
  readonly id: number;
  readonly featureFlagId: number;
}
/** Native experiment lifecycle retained separately from the application deployment. */
export type PostHogHeroExperiment = Resource<"Executor.PostHogHeroExperiment", Props, Attributes>;
/** Declares a draft experiment and its native multivariate feature flag. */
export const PostHogHeroExperiment = Resource<PostHogHeroExperiment>(
  "Executor.PostHogHeroExperiment",
);
/** No deployment starts, pauses or deletes an experiment or changes a launched definition. */
export const postHogExperimentProvider = () =>
  Provider.effect(
    PostHogHeroExperiment,
    Effect.gen(function* () {
      const api = yield* nativeHeroExperiment;
      const attributes = (
        projectId: number,
        value: NonNullable<Effect.Success<ReturnType<typeof api.find>>>,
      ): Attributes => ({
        projectId,
        id: value.id,
        featureFlagId: value.flag.id,
        definition: value.definition,
      });
      return {
        stables: ["id", "projectId", "featureFlagId"],
        diff: ({ news, output }) =>
          !isResolved(news) || output === undefined
            ? Effect.succeed(undefined)
            : Effect.succeed(
                news.projectId !== output.projectId ||
                  news.definition.feature_flag_key !== output.definition.feature_flag_key
                  ? { action: "replace" as const }
                  : isDeepStrictEqual(news.definition, output.definition)
                    ? undefined
                    : { action: "update" as const },
              ),
        read: Effect.fn(function* ({ olds }) {
          const value = yield* api.find(olds.projectId, olds.definition.feature_flag_key);
          if (
            value !== undefined &&
            !value.description.endsWith(ownership(olds.definition.feature_flag_key))
          )
            return yield* Effect.die("Hero experiment ownership mismatch");
          return value === undefined ? undefined : attributes(olds.projectId, value);
        }),
        reconcile: Effect.fn(function* ({ news }) {
          return attributes(news.projectId, yield* api.sync(news.projectId, news.definition));
        }),
        delete: () => Effect.void,
      };
    }),
  );
