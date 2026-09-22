/** Alchemy lifecycle for a PostHog project, including its server-issued ingestion token. */
import { isDeepStrictEqual } from "node:util";
import * as Api from "@distilled.cloud/posthog/organizations";
import { Credentials } from "@distilled.cloud/posthog/Credentials";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/** Fields owned by deployment; other project settings remain untouched. */
export interface PostHogProjectProps {
  readonly organizationId: string;
  readonly name: string;
  readonly appUrls: ReadonlyArray<string>;
  readonly timezone: string;
}

const ProjectResponse = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  app_urls: Schema.Array(Schema.String),
  timezone: Schema.String,
  session_recording_opt_in: Schema.Boolean,
  autocapture_opt_out: Schema.NullOr(Schema.Boolean),
  autocapture_exceptions_opt_in: Schema.NullOr(Schema.Boolean),
  test_account_filters_default_checked: Schema.NullOr(Schema.Boolean),
  test_account_filters: Schema.Unknown,
});

/** Persist only the fields used for reconciliation and the redacted ingestion token. */
export interface PostHogProjectAttributes {
  readonly id: number;
  readonly organizationId: string;
  readonly name: string;
  readonly apiToken: Redacted.Redacted<string>;
  readonly tags: ReadonlyArray<string>;
  readonly appUrls: ReadonlyArray<string>;
  readonly timezone: string;
  readonly recording: boolean;
  readonly autocapture: boolean | null;
  readonly exceptions: boolean | null;
  readonly filterTests: boolean | null;
  readonly testFilters: unknown;
}

/** A project owns one ingestion token; reconciliation never rotates it. */
export type PostHogProject = Resource<
  "Executor.PostHogProject",
  PostHogProjectProps,
  PostHogProjectAttributes
>;
/** Declare a project. Retain data-bearing production projects at the call site. */
export const PostHogProject = Resource<PostHogProject>("Executor.PostHogProject");

const attributes = (organizationId: string, response: Api.ProjectBackwardCompat) =>
  Effect.gen(function* () {
    const project = yield* Schema.decodeUnknownEffect(ProjectResponse)(response);
    const token = yield* Schema.decodeUnknownEffect(Schema.String)(
      Redacted.isRedacted(response.api_token)
        ? Redacted.value(response.api_token)
        : response.api_token,
    );
    return {
      id: project.id,
      organizationId,
      name: project.name,
      apiToken: Redacted.make(token),
      tags: project.tags,
      appUrls: project.app_urls,
      timezone: project.timezone,
      recording: project.session_recording_opt_in,
      autocapture: project.autocapture_opt_out,
      exceptions: project.autocapture_exceptions_opt_in,
      filterTests: project.test_account_filters_default_checked,
      testFilters: project.test_account_filters,
    };
  });

const testFilters = [
  { key: "executor_test", operator: "exact", type: "event", value: [true] },
  { key: "executor_internal", operator: "exact", type: "person", value: [true] },
];

/** Provider failures keep credential-bearing API bodies redacted in CLI diagnostics. */
export class PostHogProvisioningFailed extends Schema.TaggedError<PostHogProvisioningFailed>()(
  "PostHogProvisioningFailed",
  { operation: Schema.String, detail: Schema.Redacted(Schema.Unknown) },
) {}
const protect = (operation: string) =>
  Effect.mapError(
    (detail: unknown) =>
      new PostHogProvisioningFailed({ operation, detail: Redacted.make(detail) }),
  );

/** Read, update and recover owned projects using a stable stack/stage ownership tag. */
export const postHogProjectProvider = () =>
  Provider.effect(
    PostHogProject,
    Effect.gen(function* () {
      const get = yield* Api.getOrganizationsProject;
      const list = yield* Api.listOrganizationsProjects;
      const create = yield* Api.createOrganizationsProject;
      const update = yield* Api.updateOrganizationsProjectsPartial;
      const remove = yield* Api.organizationsProjectsDestroy;
      const stack = yield* Stack;
      const stage = yield* Stage;
      const marker = (id: string) => `alchemy:${stack.name}:${stage}:${id}`.toLowerCase();
      const find = Effect.fn(function* (props: PostHogProjectProps) {
        let offset = 0;
        while (true) {
          const page = yield* list({ organization_id: props.organizationId, limit: 100, offset });
          const parsed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              results: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
              next: Schema.NullOr(Schema.String),
            }),
          )(page);
          const match = parsed.results.find(
            (row) => row.name.toLowerCase() === props.name.toLowerCase(),
          );
          if (match) return yield* get({ organization_id: props.organizationId, id: match.id });
          if (parsed.next === null) return undefined;
          offset += parsed.results.length;
          if (parsed.results.length === 0)
            return yield* Effect.die("Empty PostHog pagination page");
        }
      });
      return {
        stables: ["id", "organizationId"],
        diff: ({ news, output }) =>
          Effect.sync(() => {
            if (!isResolved(news) || !output) return undefined;
            if (news.organizationId !== output.organizationId)
              return { action: "replace" as const };
            if (
              news.name !== output.name ||
              news.timezone !== output.timezone ||
              JSON.stringify(news.appUrls) !== JSON.stringify(output.appUrls) ||
              !output.recording ||
              output.autocapture !== true ||
              output.exceptions !== false ||
              output.filterTests !== true ||
              !isDeepStrictEqual(output.testFilters, testFilters)
            )
              return { action: "update" as const };
            return undefined;
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const response = output
            ? yield* get({ organization_id: output.organizationId, id: output.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : olds
              ? yield* find(olds)
              : undefined;
          if (!response) return undefined;
          const result = yield* attributes(
            output ? output.organizationId : olds.organizationId,
            response,
          );
          return result.tags.includes(marker(id)) ? result : Unowned(result);
        }, protect("read project")),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const current = output
            ? output
            : yield* find(news).pipe(
                Effect.flatMap((value) =>
                  value ? attributes(news.organizationId, value) : Effect.succeed(undefined),
                ),
              );
          if (current && !current.tags.includes(marker(id)) && !output)
            return yield* Effect.die("PostHog project name is already owned outside this resource");
          const settings = {
            organization_id: news.organizationId,
            name: news.name,
            app_urls: [...news.appUrls],
            timezone: news.timezone,
            tags: [...new Set([...(current?.tags ?? []), marker(id)])],
            session_recording_opt_in: true,
            autocapture_opt_out: true,
            autocapture_exceptions_opt_in: false,
            test_account_filters_default_checked: true,
            test_account_filters: testFilters,
          };
          const response = current
            ? yield* update({ ...settings, id: current.id })
            : yield* create(settings).pipe(
                Effect.flatMap((created) => attributes(news.organizationId, created)),
                Effect.flatMap((created) => update({ ...settings, id: created.id })),
              );
          return yield* attributes(news.organizationId, response);
        }, protect("reconcile project")),
        delete: ({ output }) =>
          remove({ organization_id: output.organizationId, id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.asVoid,
            protect("delete project"),
          ),
      };
    }),
  );

/** Resolve management authorization only during provisioning; never bind it into the Worker. */
export const postHogProviderCredentials = <A, E, R>(
  providers: Layer.Layer<A, E, R | Credentials>,
) =>
  providers.pipe(
    Layer.provide(
      Layer.succeed(
        Credentials,
        Effect.gen(function* () {
          const apiKey = yield* Config.Redacted("POSTHOG_PERSONAL_API_KEY");
          const apiBaseUrl = yield* Config.NonEmptyString("POSTHOG_HOST");
          return { apiKey: Redacted.value(apiKey), apiBaseUrl };
        }).pipe(Effect.orDie),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
