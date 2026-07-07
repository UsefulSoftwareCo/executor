import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { IntegrationRemovalNotAllowedError, InternalError } from "@executor-js/sdk/shared";

const GitHubSourcePayload = Schema.Struct({
  url: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
});

const SourceSlugParams = {
  slug: Schema.String,
};

const SkippedArtifact = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["not supported yet", "unsupported file type", "ignored"]),
});

const FileDiagnostic = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});

const SyncErrorData = Schema.Struct({
  stage: Schema.Literals(["source", "discover", "bundle", "collect", "project"]),
  message: Schema.String,
  diagnostics: Schema.optional(Schema.Array(FileDiagnostic)),
});

const GitHubSyncResponse = Schema.Struct({
  status: Schema.Literals(["published", "up-to-date", "failed"]),
  snapshotId: Schema.optional(Schema.String),
  upstreamSha: Schema.optional(Schema.String),
  tools: Schema.Array(Schema.String),
  skipped: Schema.Array(SkippedArtifact),
  errors: Schema.optional(Schema.Array(SyncErrorData)),
});

const GitHubSourceSummary = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  scope: Schema.String,
  url: Schema.String,
  repo: Schema.String,
  ref: Schema.String,
  hasToken: Schema.Boolean,
  upstreamSha: Schema.String,
  snapshotId: Schema.String,
  description: Schema.optional(Schema.String),
  publishedAt: Schema.String,
  tools: Schema.Array(Schema.String),
  skipped: Schema.Array(SkippedArtifact),
});

const GitHubSourcesResponse = Schema.Struct({
  sources: Schema.Array(GitHubSourceSummary),
});

const GitHubSourceResponse = Schema.Struct({
  source: Schema.NullOr(GitHubSourceSummary),
});

const RemoveSourceResponse = Schema.Struct({
  removed: Schema.Boolean,
});

const DomainErrors = [InternalError] as const;
const IntegrationRemovalNotAllowed = IntegrationRemovalNotAllowedError.annotate({
  httpApiStatus: 409,
});
const RemoveSourceErrors = [InternalError, IntegrationRemovalNotAllowed] as const;

export const AppsGroup = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.get("listGithubSources", "/apps/sources/github", {
      success: GitHubSourcesResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("syncGithubSource", "/apps/sources/github/sync", {
      payload: GitHubSourcePayload,
      success: GitHubSyncResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getGithubSource", "/apps/sources/github/:slug", {
      params: SourceSlugParams,
      success: GitHubSourceResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeGithubSource", "/apps/sources/github/:slug", {
      params: SourceSlugParams,
      success: RemoveSourceResponse,
      error: RemoveSourceErrors,
    }),
  );
