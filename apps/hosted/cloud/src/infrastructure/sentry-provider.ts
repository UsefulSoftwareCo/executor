/** Persistent Sentry projects and ingestion keys, managed by Alchemy v2. */
import * as Api from "@distilled.cloud/sentry/sentry";
import { Credentials } from "@distilled.cloud/sentry/Credentials";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/** Existing organization and team are explicit inputs; this resource owns only its project. */
export interface SentryProjectProps {
  readonly organization: string;
  readonly team: string;
  readonly slug: string;
  readonly name: string;
  readonly platform: string;
}
/** Project identity and the configuration read back from Sentry. */
export interface SentryProjectAttributes {
  readonly id: string;
  readonly organization: string;
  readonly slug: string;
  readonly name: string;
  readonly platform: string | null;
  readonly teams: ReadonlyArray<string>;
}
/** Project replacement retains the old project's data when the declaration uses retain(). */
export type SentryProject = Resource<
  "Executor.SentryProject",
  SentryProjectProps,
  SentryProjectAttributes
>;
/** Declare a Sentry project. Existing matching slugs require explicit adoption. */
export const SentryProject = Resource<SentryProject>("Executor.SentryProject");

/** A separate named client key supplies a public DSN to runtime code. */
export interface SentryClientKeyProps {
  readonly organization: string;
  readonly project: string;
  readonly name: string;
}
/** Secret DSNs and management credentials never enter resource outputs. */
export interface SentryClientKeyAttributes extends SentryClientKeyProps {
  readonly id: string;
  readonly dsn: string;
  readonly active: boolean;
}
/** The key's stable ID survives project settings and application updates. */
export type SentryClientKey = Resource<
  "Executor.SentryClientKey",
  SentryClientKeyProps,
  SentryClientKeyAttributes
>;
/** Declare the public ingestion key used by one product surface. */
export const SentryClientKey = Resource<SentryClientKey>("Executor.SentryClientKey");

/** Keep API response bodies, which may contain secret DSNs, out of deployment diagnostics. */
export class SentryProvisioningFailed extends Schema.TaggedError<SentryProvisioningFailed>()(
  "SentryProvisioningFailed",
  { operation: Schema.String, detail: Schema.Redacted(Schema.Unknown) },
) {
  get message() {
    return `Sentry provisioning failed during ${this.operation}`;
  }
}
const protect = (operation: string) =>
  Effect.mapError(
    (detail: unknown) => new SentryProvisioningFailed({ operation, detail: Redacted.make(detail) }),
  );

/** Project lifecycle uses Sentry's unique slug and an explicit team association. */
export const sentryProjectProvider = () =>
  Provider.effect(
    SentryProject,
    Effect.gen(function* () {
      const get = yield* Api.getProject;
      const create = yield* Api.createTeamProject;
      const update = yield* Api.updateProject;
      const addTeam = yield* Api.addProjectTeam;
      const remove = yield* Api.deleteProject;
      const read = Effect.fn(function* (organization: string, slug: string) {
        const value = yield* get({
          organization_id_or_slug: organization,
          project_id_or_slug: slug,
        }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (!value) return undefined;
        return {
          id: value.id,
          organization,
          slug: value.slug,
          name: value.name,
          platform: value.platform,
          teams: value.teams.map((team) => team.slug),
        };
      });
      return {
        stables: ["id", "organization", "slug"],
        diff: ({ news, output }) =>
          Effect.sync(() => {
            if (!isResolved(news) || !output) return undefined;
            if (news.organization !== output.organization || news.slug !== output.slug)
              return { action: "replace" as const };
            if (
              news.name !== output.name ||
              news.platform !== output.platform ||
              !output.teams.includes(news.team)
            )
              return { action: "update" as const };
            return undefined;
          }),
        read: Effect.fn(function* ({ olds, output }) {
          const value = yield* read(olds.organization, olds.slug);
          return value && !output ? Unowned(value) : value;
        }, protect("read project")),
        reconcile: Effect.fn(function* ({ news, output }) {
          if (!output) {
            yield* create({
              organization_id_or_slug: news.organization,
              team_id_or_slug: news.team,
              slug: news.slug,
              name: news.name,
              platform: news.platform,
              default_rules: false,
            });
          } else {
            yield* update({
              organization_id_or_slug: news.organization,
              project_id_or_slug: news.slug,
              name: news.name,
              platform: news.platform,
            });
            if (!output.teams.includes(news.team))
              yield* addTeam({
                organization_id_or_slug: news.organization,
                project_id_or_slug: news.slug,
                team_id_or_slug: news.team,
              });
          }
          const value = yield* read(news.organization, news.slug);
          if (!value) return yield* Effect.die("Sentry project missing after provisioning");
          return value;
        }, protect("reconcile project")),
        delete: ({ output }) =>
          remove({
            organization_id_or_slug: output.organization,
            project_id_or_slug: output.slug,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.asVoid,
            protect("delete project"),
          ),
      };
    }),
  );

/** Named-key reconciliation preserves the DSN across deploys and recovers interrupted creates. */
export const sentryClientKeyProvider = () =>
  Provider.effect(
    SentryClientKey,
    Effect.gen(function* () {
      const get = yield* Api.getProjectKey;
      const list = yield* Api.listProjectKeys;
      const create = yield* Api.createProjectKey;
      const update = yield* Api.updateProjectKey;
      const remove = yield* Api.deleteProjectKey;
      const target = (props: SentryClientKeyProps) => ({
        organization_id_or_slug: props.organization,
        project_id_or_slug: props.project,
      });
      const attributes = (
        props: SentryClientKeyProps,
        value: Api.CreateProjectKeyResponse,
      ): SentryClientKeyAttributes => ({
        organization: props.organization,
        project: props.project,
        name: value.name,
        id: value.id,
        dsn: value.dsn.public,
        active: value.isActive,
      });
      const find = Effect.fn(function* (props: SentryClientKeyProps) {
        const keys = yield* list(target(props));
        const matches = keys.filter((key) => key.name === props.name);
        if (matches.length > 1 || keys.length >= 100)
          return yield* Effect.die("Sentry client key inventory needs explicit reconciliation");
        return matches[0];
      });
      return {
        stables: ["id", "dsn", "organization", "project"],
        diff: ({ news, output }) =>
          Effect.sync(() => {
            if (!isResolved(news) || !output) return undefined;
            if (news.organization !== output.organization || news.project !== output.project)
              return { action: "replace" as const };
            if (news.name !== output.name || !output.active) return { action: "update" as const };
            return undefined;
          }),
        read: Effect.fn(function* ({ olds, output }) {
          const value = output
            ? yield* get({ ...target(olds), key_id: output.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : yield* find(olds).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
          return value ? attributes(olds, value) : undefined;
        }, protect("read client key")),
        reconcile: Effect.fn(function* ({ news, output }) {
          const existing = output ? output : yield* find(news);
          const value = existing
            ? yield* update({
                ...target(news),
                key_id: existing.id,
                name: news.name,
                isActive: true,
              })
            : yield* create({ ...target(news), name: news.name });
          return attributes(news, value);
        }, protect("reconcile client key")),
        delete: ({ output }) =>
          remove({ ...target(output), key_id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.asVoid,
            protect("delete client key"),
          ),
      };
    }),
  );

/** Resolve management authorization only for provider operations. */
export const sentryProviderCredentials = <A, E, R>(providers: Layer.Layer<A, E, R | Credentials>) =>
  providers.pipe(
    Layer.provide(
      Layer.succeed(
        Credentials,
        Effect.gen(function* () {
          const apiKey = yield* Config.Redacted("SENTRY_AUTH_TOKEN");
          const apiBaseUrl = yield* Config.NonEmptyString("SENTRY_URL");
          return { apiKey, apiBaseUrl };
        }).pipe(Effect.orDie),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
