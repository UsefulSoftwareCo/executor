/** Declarative PostHog dashboards and saved insights. */
import { isDeepStrictEqual } from "node:util";
import * as Dashboards from "@distilled.cloud/posthog/dashboards";
import * as Insights from "@distilled.cloud/posthog/insights";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { Effect, Layer, Redacted, Schema } from "effect";
import { PostHogProvisioningFailed } from "./posthog-provider.ts";

interface ReportProps {
  readonly projectId: number;
  readonly name: string;
  readonly description: string;
}
interface ReportAttributes extends ReportProps {
  readonly id: number;
}
/** A retained product-usage dashboard. */
export type PostHogDashboard = Resource<"Executor.PostHogDashboard", ReportProps, ReportAttributes>;
/** Declare a dashboard; saved insights are separate dependent resources. */
export const PostHogDashboard = Resource<PostHogDashboard>("Executor.PostHogDashboard");
/** A saved query attached to one managed dashboard. */
export interface PostHogInsightProps extends ReportProps {
  readonly dashboardId: number;
  readonly query: Insights.InsightQuerySchema;
}
interface InsightAttributes extends ReportAttributes {
  readonly query: unknown;
  readonly dashboards: ReadonlyArray<number>;
}
/** Saved insight identity is stable when its query or title changes. */
export type PostHogInsight = Resource<
  "Executor.PostHogInsight",
  PostHogInsightProps,
  InsightAttributes
>;
/** Declare a saved insight and its dashboard membership. */
export const PostHogInsight = Resource<PostHogInsight>("Executor.PostHogInsight");

const Response = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
});
const protect = (operation: string) =>
  Effect.mapError(
    (detail: unknown) =>
      new PostHogProvisioningFailed({ operation, detail: Redacted.make(detail) }),
  );
const find = <E, R>(page: (offset: number) => Effect.Effect<unknown, E, R>, name: string) =>
  Effect.gen(function* () {
    let offset = 0;
    let found: number | undefined;
    while (true) {
      const result = yield* page(offset).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              results: Schema.Array(
                Schema.Struct({ id: Schema.Number, name: Schema.NullOr(Schema.String) }),
              ),
              next: Schema.NullOr(Schema.String),
            }),
          ),
        ),
      );
      for (const item of result.results)
        if (item.name === name) {
          if (found !== undefined)
            return yield* Effect.die("Multiple PostHog reports match the declared name");
          found = item.id;
        }
      if (result.next === null) return found;
      if (result.results.length === 0)
        return yield* Effect.die("Empty PostHog report pagination page");
      offset += result.results.length;
    }
  });
const ownership = Effect.gen(function* () {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return (id: string) => `[alchemy:${stack.name}:${stage}:${id}]`;
});

/** Dashboard and insight lifecycles share only the reporting API boundary. */
export const postHogReportProviders = () =>
  Layer.mergeAll(
    Provider.effect(
      PostHogDashboard,
      Effect.gen(function* () {
        const get = yield* Dashboards.getDashboard;
        const list = yield* Dashboards.listDashboards;
        const create = yield* Dashboards.createDashboard;
        const update = yield* Dashboards.updateDashboardsPartial;
        const remove = yield* Dashboards.dashboardsDestroy;
        const marker = yield* ownership;
        const read = Effect.fn(function* (props: ReportProps, id: number) {
          const value = yield* get({ project_id: String(props.projectId), id }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!value) return undefined;
          return {
            ...(yield* Schema.decodeUnknownEffect(Response)(value)),
            projectId: props.projectId,
          };
        });
        const lookup = (props: ReportProps) =>
          find(
            (offset) => list({ project_id: String(props.projectId), limit: 100, offset }),
            props.name,
          );
        return {
          stables: ["id", "projectId"],
          diff: ({ id, news, output }) =>
            Effect.sync(() => {
              if (!isResolved(news) || !output) return undefined;
              if (news.projectId !== output.projectId) return { action: "replace" as const };
              return news.name !== output.name ||
                `${news.description}\n${marker(id)}` !== output.description
                ? { action: "update" as const }
                : undefined;
            }),
          read: Effect.fn(function* ({ id, olds, output }) {
            const resourceId = output?.id ?? (yield* lookup(olds));
            if (resourceId === undefined) return undefined;
            const value = yield* read(olds, resourceId);
            return value && !value.description.endsWith(marker(id)) ? Unowned(value) : value;
          }, protect("read dashboard")),
          reconcile: Effect.fn(function* ({ id, news, output }) {
            const resourceId = output?.id ?? (yield* lookup(news));
            const existing = resourceId === undefined ? undefined : yield* read(news, resourceId);
            if (existing && !output && !existing.description.endsWith(marker(id)))
              return yield* Effect.die("PostHog dashboard is not owned by this resource");
            const body = {
              project_id: String(news.projectId),
              name: news.name,
              description: `${news.description}\n${marker(id)}`,
              pinned: true,
            };
            const value = existing
              ? yield* update({ ...body, id: existing.id })
              : yield* create(body);
            return {
              ...(yield* Schema.decodeUnknownEffect(Response)(value)),
              projectId: news.projectId,
            };
          }, protect("reconcile dashboard")),
          delete: ({ output }) =>
            remove({ project_id: String(output.projectId), id: output.id }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.asVoid,
              protect("delete dashboard"),
            ),
        };
      }),
    ),
    Provider.effect(
      PostHogInsight,
      Effect.gen(function* () {
        const get = yield* Insights.getInsight;
        const list = yield* Insights.listInsights;
        const create = yield* Insights.createInsight;
        const update = yield* Insights.updateInsightsPartial;
        const remove = yield* Insights.insightsDestroy;
        const marker = yield* ownership;
        const response = Schema.Struct({
          ...Response.fields,
          query: Schema.Unknown,
          dashboards: Schema.Array(Schema.Number),
        });
        const read = Effect.fn(function* (props: ReportProps, id: number) {
          const value = yield* get({ project_id: String(props.projectId), id: String(id) }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!value) return undefined;
          return {
            ...(yield* Schema.decodeUnknownEffect(response)(value)),
            projectId: props.projectId,
          };
        });
        const lookup = (props: ReportProps) =>
          find(
            (offset) => list({ project_id: String(props.projectId), limit: 100, offset }),
            props.name,
          );
        return {
          stables: ["id", "projectId"],
          diff: ({ id, news, output }) =>
            Effect.sync(() => {
              if (!isResolved(news) || !output) return undefined;
              if (news.projectId !== output.projectId) return { action: "replace" as const };
              return news.name !== output.name ||
                `${news.description}\n${marker(id)}` !== output.description ||
                !isDeepStrictEqual(news.query, output.query) ||
                !isDeepStrictEqual([news.dashboardId], output.dashboards)
                ? { action: "update" as const }
                : undefined;
            }),
          read: Effect.fn(function* ({ id, olds, output }) {
            const resourceId = output?.id ?? (yield* lookup(olds));
            if (resourceId === undefined) return undefined;
            const value = yield* read(olds, resourceId);
            return value && !value.description.endsWith(marker(id)) ? Unowned(value) : value;
          }, protect("read insight")),
          reconcile: Effect.fn(function* ({ id, news, output }) {
            const resourceId = output?.id ?? (yield* lookup(news));
            const existing = resourceId === undefined ? undefined : yield* read(news, resourceId);
            if (existing && !output && !existing.description.endsWith(marker(id)))
              return yield* Effect.die("PostHog insight is not owned by this resource");
            const body = {
              project_id: String(news.projectId),
              name: news.name,
              description: `${news.description}\n${marker(id)}`,
              dashboards: [news.dashboardId],
              query: news.query,
            };
            const value = existing
              ? yield* update({ ...body, id: String(existing.id) })
              : yield* create(body);
            return {
              ...(yield* Schema.decodeUnknownEffect(response)(value)),
              projectId: news.projectId,
            };
          }, protect("reconcile insight")),
          delete: ({ output }) =>
            remove({ project_id: String(output.projectId), id: String(output.id) }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.asVoid,
              protect("delete insight"),
            ),
        };
      }),
    ),
  );
