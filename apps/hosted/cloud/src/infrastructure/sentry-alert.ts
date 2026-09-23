/** A stage-scoped workflow for new and regressed errors in the managed Sentry projects. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Api from "@distilled.cloud/sentry/sentry";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SentryProvisioningFailed } from "./sentry-provider.ts";

/** Project IDs and public DSNs come from managed resources. Test-stage alerts remain disabled. */
export interface SentryErrorAlertProps {
  readonly organization: string;
  readonly team: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly dsn: string }>;
  readonly name: string;
  readonly environment: string;
  readonly enabled: boolean;
}
const Condition = Schema.Struct({
  type: Schema.String,
  comparison: Schema.Unknown,
  conditionResult: Schema.Boolean,
});
const Action = Schema.Struct({
  type: Schema.String,
  integrationId: Schema.NullOr(Schema.String),
  data: Schema.Record(Schema.String, Schema.Unknown),
  config: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.String,
});
const Filter = Schema.Struct({
  logicType: Schema.String,
  conditions: Schema.Array(Condition),
  actions: Schema.Array(Action),
});
const Configuration = Schema.Struct({
  config: Schema.Record(Schema.String, Schema.Unknown),
  triggers: Schema.NullOr(Filter),
  actionFilters: Schema.NullOr(Schema.Array(Filter)),
  detectorIds: Schema.NullOr(Schema.Array(Schema.String)),
});
const Response = Schema.Struct({
  id: Schema.NumberFromString,
  name: Schema.String,
  environment: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
});
type AlertAttributes = typeof Response.Type & {
  readonly organization: string;
  readonly configuration: typeof Configuration.Type;
};
/** Own the workflow independently of projects and their automatic error monitors. */
export type SentryErrorAlert = Resource<
  "Executor.SentryErrorAlert",
  SentryErrorAlertProps,
  AlertAttributes
>;
/** Declare one environment's new-error and regression notifications. */
export const SentryErrorAlert = Resource<SentryErrorAlert>("Executor.SentryErrorAlert");
const protect = (operation: string) =>
  Effect.mapError(
    (detail: unknown) => new SentryProvisioningFailed({ operation, detail: Redacted.make(detail) }),
  );

/** Reconcile all owned alert fields; server-generated IDs are excluded from the comparison. */
export const sentryErrorAlertProvider = () =>
  Provider.effect(
    SentryErrorAlert,
    Effect.gen(function* () {
      const get = yield* Api.getOrganizationWorkflow;
      const list = yield* Api.listOrganizationWorkflows;
      const monitors = yield* Api.listOrganizationDetectors;
      const team = yield* Api.getTeam;
      const getEnvironment = yield* Api.getProjectEnvironment;
      const create = yield* Api.createOrganizationWorkflow;
      const update = yield* Api.updateOrganizationWorkflow;
      const remove = yield* Api.deleteOrganizationWorkflow;
      const http = yield* HttpClient.HttpClient;
      const lookup = Effect.fn(function* (props: SentryErrorAlertProps) {
        const rows = yield* list({ organization_id_or_slug: props.organization });
        const matches = rows.filter((row) => row.name === props.name);
        if (matches.length > 1 || rows.length >= 100)
          return yield* Effect.die("Sentry alert inventory needs explicit reconciliation");
        return matches[0];
      });
      const attributes = (organization: string, value: unknown) =>
        Effect.gen(function* () {
          const fields = yield* Schema.decodeUnknownEffect(Response)(value);
          const configuration = yield* Schema.decodeUnknownEffect(Configuration)(value);
          return { ...fields, organization, configuration };
        });
      const desired = Effect.fn(function* (props: SentryErrorAlertProps) {
        const errorIds: number[] = [];
        for (const project of props.projects) {
          const projectId = yield* Schema.decodeUnknownEffect(Schema.NumberFromString)(project.id);
          const response = yield* monitors({
            organization_id_or_slug: props.organization,
            project: [projectId],
          });
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ id: Schema.String, type: Schema.String, projectId: Schema.String }),
            ),
          )(response);
          const matches = rows.filter(
            (monitor) => monitor.type === "error" && monitor.projectId === project.id,
          );
          const match = matches[0];
          if (matches.length !== 1 || !match)
            return yield* Effect.die("Expected one Sentry error monitor per managed project");
          errorIds.push(yield* Schema.decodeUnknownEffect(Schema.NumberFromString)(match.id));
        }
        const recipient = yield* team({
          organization_id_or_slug: props.organization,
          team_id_or_slug: props.team,
        });
        return {
          organization_id_or_slug: props.organization,
          name: props.name,
          enabled: props.enabled,
          environment: props.environment,
          detector_ids: errorIds,
          config: { frequency: 60 },
          triggers: {
            logic_type: "any-short",
            conditions: [
              { type: "first_seen_event", comparison: true, conditionResult: true },
              { type: "regression_event", comparison: true, conditionResult: true },
            ],
          },
          action_filters: [
            {
              logic_type: "all",
              conditions: [],
              actions: [
                {
                  type: "email",
                  integrationId: null,
                  data: {},
                  config: { targetType: "team", targetIdentifier: recipient.id },
                  status: "active",
                },
              ],
            },
          ],
        };
      });
      const configuration = (body: Effect.Success<ReturnType<typeof desired>>) => ({
        config: body.config,
        detectorIds: body.detector_ids.map(String),
        triggers: {
          logicType: body.triggers.logic_type,
          conditions: body.triggers.conditions,
          actions: [],
        },
        actionFilters: body.action_filters.map((filter) => ({
          logicType: filter.logic_type,
          conditions: filter.conditions,
          actions: filter.actions,
        })),
      });
      const ensureEnvironment = Effect.fn(function* (props: SentryErrorAlertProps) {
        for (const project of props.projects) {
          const input = {
            organization_id_or_slug: props.organization,
            project_id_or_slug: project.id,
            environment: props.environment,
          };
          const exists = () =>
            getEnvironment(input).pipe(
              Effect.as(true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );
          if (yield* exists()) continue;
          // Sentry creates environments on first ingestion, not through a create-environment API.
          // A deterministic info event makes retries safe and is explicitly marked as synthetic.
          const dsn = new URL(project.dsn);
          const eventId = createHash("sha256")
            .update(`executor-environment:${project.id}:${props.environment}`)
            .digest("hex")
            .slice(0, 32);
          const event = {
            event_id: eventId,
            timestamp: new Date().toISOString(),
            platform: "javascript",
            level: "info",
            environment: props.environment,
            message: "Executor telemetry environment setup",
            tags: { executor_test: "true", setup_verification: "true" },
          };
          const body = [
            JSON.stringify({ event_id: eventId }),
            JSON.stringify({ type: "event" }),
            JSON.stringify(event),
            "",
          ].join("\n");
          const url = `${dsn.origin}/api/${project.id}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(dsn.username)}`;
          const response = yield* http.execute(
            HttpClientRequest.post(url).pipe(
              HttpClientRequest.bodyText(body, "application/x-sentry-envelope"),
            ),
          );
          if (response.status !== 200)
            return yield* Effect.die("Sentry environment bootstrap was rejected");
          let ready = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            if (yield* exists()) {
              ready = true;
              break;
            }
            yield* Effect.sleep("1 second");
          }
          if (!ready)
            return yield* Effect.die("Sentry environment is not visible yet; retry deployment");
        }
      });
      return {
        stables: ["id", "organization"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.organization !== output.organization) return { action: "replace" as const };
          const body = yield* desired(news);
          return news.name !== output.name ||
            news.environment !== output.environment ||
            news.enabled !== output.enabled ||
            !isDeepStrictEqual(configuration(body), output.configuration)
            ? { action: "update" as const }
            : undefined;
        }, protect("compare error alert")),
        read: Effect.fn(function* ({ olds, output }) {
          const value = output
            ? yield* get({
                organization_id_or_slug: olds.organization,
                workflow_id: output.id,
              }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)))
            : yield* lookup(olds);
          if (!value) return undefined;
          const result = yield* attributes(olds.organization, value);
          return output ? result : Unowned(result);
        }, protect("read error alert")),
        reconcile: Effect.fn(function* ({ news, output }) {
          yield* ensureEnvironment(news);
          const body = yield* desired(news);
          const value = output
            ? yield* update({ ...body, workflow_id: output.id })
            : yield* create(body);
          return yield* attributes(news.organization, value);
        }, protect("reconcile error alert")),
        delete: ({ output }) =>
          remove({ organization_id_or_slug: output.organization, workflow_id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.asVoid,
            protect("delete error alert"),
          ),
      };
    }),
  );
