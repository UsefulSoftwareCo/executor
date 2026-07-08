import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { InternalError } from "@executor-js/sdk/shared";

const SourceSlugParams = {
  slug: Schema.String,
};

const CreateSourcePayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    slug: Schema.optional(Schema.String),
    app: Schema.optional(Schema.String),
    url: Schema.String,
    ref: Schema.optional(Schema.String),
    token: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("local-directory"),
    slug: Schema.optional(Schema.String),
    app: Schema.optional(Schema.String),
    path: Schema.String,
  }),
]);

const SyncDiagnostic = Schema.Struct({
  stage: Schema.Literals(["source", "discover", "bundle", "collect", "project"]),
  message: Schema.String,
  diagnostics: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  ),
});

const SourceStatus = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pending") }),
  Schema.Struct({
    type: Schema.Literals(["published", "up-to-date"]),
    at: Schema.Number,
    tools: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    at: Schema.Number,
    errors: Schema.Array(SyncDiagnostic),
  }),
]);

const SourceRecord = Schema.Struct({
  slug: Schema.String,
  app: Schema.String,
  kind: Schema.Literals(["git", "local-directory"]),
  config: CreateSourcePayload,
  sourceRef: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: SourceStatus,
  updatedAt: Schema.Number,
});

const SourcesResponse = Schema.Struct({ sources: Schema.Array(SourceRecord) });
const SourceResponse = Schema.Struct({ source: Schema.NullOr(SourceRecord) });
const CreateSourceResponse = Schema.Struct({ source: SourceRecord });
const DeleteSourceResponse = Schema.Struct({ removed: Schema.Boolean });
const SyncSourceResponse = Schema.Struct({
  status: Schema.Literals(["published", "up-to-date", "failed"]),
  sourceRef: Schema.optional(Schema.String),
  tools: Schema.Array(Schema.String),
  errors: Schema.optional(Schema.Array(SyncDiagnostic)),
});

const ListDirsQuery = Schema.Struct({
  path: Schema.optional(Schema.String),
  includeHidden: Schema.optional(Schema.String),
});
const ListDirsResponse = Schema.Struct({
  path: Schema.String,
  parent: Schema.NullOr(Schema.String),
  dirs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      isSymlink: Schema.Boolean,
    }),
  ),
});

const DomainErrors = [InternalError] as const;

export const AppsBaseGroup = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.get("listSources", "/apps/sources", {
      success: SourcesResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createSource", "/apps/sources", {
      payload: CreateSourcePayload,
      success: CreateSourceResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getSource", "/apps/sources/:slug", {
      params: SourceSlugParams,
      success: SourceResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteSource", "/apps/sources/:slug", {
      params: SourceSlugParams,
      success: DeleteSourceResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("syncSource", "/apps/sources/:slug/sync", {
      params: SourceSlugParams,
      success: SyncSourceResponse,
      error: DomainErrors,
    }),
  );

export const AppsGroup = AppsBaseGroup.add(
  // Local-directory browsing names directories on the host running Executor.
  // It is only safe for the local single-user host, and the plugin sourceKinds
  // gate keeps shared selfhost and cloud deployments from registering it.
  HttpApiEndpoint.get("listDirs", "/apps/fs/dirs", {
    query: ListDirsQuery,
    success: ListDirsResponse,
    error: DomainErrors,
  }),
);

export const appsGroupForSourceKinds = (
  sourceKinds: readonly ("git" | "local-directory")[] | undefined,
) => ((sourceKinds?.includes("local-directory") ?? true) ? AppsGroup : AppsBaseGroup);
