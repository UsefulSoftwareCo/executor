/** Public app listings identify a chosen Git revision, without package versions or dependency resolution. */
import { Effect, Option, Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { appSlug } from "./app-slug.ts";
import { AppId, JsonObject, OwnerId } from "./shared.ts";
import { SourceCommit, SourceFilePath, SourceFiles, SourceRevision, isTextFile } from "./source.ts";

/**
 * The hosted Executor API origin: the default public registry and the host the CLI and SDK call.
 * Clients discover sign-in from it (RFC 9728); the dashboard and MCP live on other hosts.
 */
export const hostedExecutorOrigin = "https://api.executor.sh";

/**
 * Public name inside a publishing owner's scope, such as `@acme.executor.community/notes`. The
 * scope is the owner's current one; the label after it identifies the listing within the owner.
 */
export const PackageName = Schema.String.check(
  Schema.isPattern(/^@[a-z0-9][a-z0-9.-]{0,119}\/[a-z0-9][a-z0-9-]{0,62}$/u),
);
export type PackageName = typeof PackageName.Type;
/** The scope of a package name, without its `@`. */
export const packageScope = (name: PackageName) => name.slice(1, name.indexOf("/"));
/** The label of a package name: what stays when its owner's scope changes. */
export const packageLabel = (name: PackageName) => name.slice(name.indexOf("/") + 1);
/** Public packages are published under `<slug>.executor.community`, an organization's scope. */
export const publishingDomain = "executor.community";
/** Standard npm metadata remains source; only name and description identify a public listing. */
export const PackageManifest = Schema.Struct({
  name: PackageName,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
});
export type PackageManifest = typeof PackageManifest.Type;
/** Derive a public name from an authenticated publishing namespace and an app label. */
export const publicPackageName = (namespace: string, name: string) => {
  const label = Schema.is(PackageName)(name) ? packageLabel(name) : name;
  return Schema.decodeUnknownOption(PackageName)(`@${namespace}/${appSlug(label)}`);
};

/** A source or ownership issue that the author can repair before publishing. */
export class PublicationIssue extends Schema.TaggedError<PublicationIssue>()("PublicationIssue", {
  reason: Schema.Literals([
    "missing-manifest",
    "invalid-json",
    "missing-name",
    "unscoped-name",
    "invalid-name",
    "invalid-metadata",
    "invalid-source",
    "limit",
    "forbidden-scope",
    "name-taken",
  ]),
  name: Schema.NullOr(Schema.String),
}) {}

/** Read-only publication checks for this app and owner; publishing rechecks the same rules. */
export const PublicationReadiness = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), manifest: PackageManifest }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    issue: PublicationIssue,
    suggestedName: Schema.NullOr(PackageName),
  }),
]);
export type PublicationReadiness = typeof PublicationReadiness.Type;

/** One current public listing. The commit is the author's selected Git revision. */
export const Publication = Schema.Struct({
  name: PackageName,
  commit: SourceCommit,
  description: Schema.String,
  publishedAt: Schema.String,
});
export type Publication = typeof Publication.Type;
/** A complete source copy, with no private Git history, credentials, or app data. */
export const PublicationSnapshot = Schema.Struct({ publication: Publication, files: SourceFiles });
export type PublicationSnapshot = typeof PublicationSnapshot.Type;
/** Public copies identify the exact revision the user reviewed. */
export const PublicationReference = Schema.Struct({
  package: PackageName,
  commit: SourceCommit,
});
export type PublicationReference = typeof PublicationReference.Type;
const registryFailures = {
  "not-found": "The public app listing or its selected commit does not exist.",
  forbidden: "This package name is not in the publisher's current scope.",
  conflict: "Another app already publishes this package name.",
  changed:
    "The public listing changed since its commit was reviewed. Review the current listing before copying it.",
  "invalid-source": "The app source at this commit cannot be read as a public listing.",
  "invalid-manifest":
    "The app's package.json needs a valid package name in the publisher's scope and valid metadata.",
  storage: "Executor could not read or write the public app catalog. Try again.",
  network: "Executor could not reach the public app registry. Try again.",
  status: "The public app registry returned an unexpected HTTP status.",
  "invalid-response": "The public app registry returned a response Executor could not read.",
  limit: "The public app registry's response exceeded Executor's size limit.",
  unsupported: "This Executor reads a remote app registry and cannot publish to it.",
} as const;
/** Safe public-catalog failures. */
export const RegistryError = ApiError.define({
  tag: "RegistryError",
  status: 400,
  fields: {
    reason: Schema.Literals([
      "not-found",
      "forbidden",
      "conflict",
      "changed",
      "invalid-source",
      "invalid-manifest",
      "storage",
      "network",
      "status",
      "invalid-response",
      "limit",
      /** This executor reads a remote registry and cannot publish. */
      "unsupported",
    ]),
    /** The remote registry's HTTP status, for a `status` failure. */
    status: Schema.optional(Schema.Int),
  },
  message: ({ reason, status }) =>
    reason === "status" && status !== undefined
      ? `The public app registry responded with HTTP ${status}.`
      : registryFailures[reason],
  recorded: ({ reason, status }) =>
    reason === "status" && status !== undefined
      ? `The public app registry responded with HTTP ${status}.`
      : registryFailures[reason],
});
export type RegistryError = typeof RegistryError.Type;
/** Public reads require a selected commit; a changed listing never silently selects newer code. */
export interface Registry {
  readonly origin: string;
  readonly list: (name?: string) => Effect.Effect<ReadonlyArray<Publication>, RegistryError>;
  readonly snapshot: (
    name: string,
    commit: string,
  ) => Effect.Effect<PublicationSnapshot, RegistryError>;
  /**
   * One file of a listing's selected commit, by path, as its exact bytes. Installation reads the
   * public files a snapshot lists by their blob this way, one at a time.
   */
  readonly file: (
    name: string,
    commit: string,
    path: string,
  ) => Effect.Effect<Uint8Array, RegistryError>;
  /**
   * Read many files of one listing's selected commit. The listing is resolved once, so an install
   * reading its public files does not look it up again for each one.
   */
  readonly files: (
    name: string,
    commit: string,
  ) => Effect.Effect<(path: string) => Effect.Effect<Uint8Array, RegistryError>, RegistryError>;
}

/** A public listing has one stable URL even when its selected commit changes. */
export const registryPublicationPath = (name: string): string =>
  `/apps/${name.slice(1).split("/").map(encodeURIComponent).join("/")}`;

/**
 * One listing with its owner and retained source. The name is the owner's current scope and the
 * listing's label; storage keeps only the label, so an owner's new scope renames every listing.
 */
export const StoredPublication = Schema.Struct({
  name: PackageName,
  owner: OwnerId,
  app: AppId,
  publication: Publication,
  source: SourceRevision,
});
export type StoredPublication = typeof StoredPublication.Type;
/** Host-owned catalog persistence; public callers only see catalog metadata and selected source. */
export interface RegistryStorage {
  readonly get: (name: string) => Effect.Effect<StoredPublication, RegistryError>;
  readonly list: (name?: string) => Effect.Effect<ReadonlyArray<Publication>, RegistryError>;
  readonly owned: (owner: OwnerId) => Effect.Effect<ReadonlyArray<Publication>, RegistryError>;
  readonly publish: (input: StoredPublication) => Effect.Effect<Publication, RegistryError>;
  readonly unpublish: (owner: OwnerId, name: string) => Effect.Effect<void, RegistryError>;
}
/**
 * Where this executor's public catalog lives. A remote registry only reads another host's
 * listings. A stored catalog is this executor's own, published at the executor's origin.
 */
export type RegistryOptions = Registry | { readonly storage: RegistryStorage };

/** Scope only freshly generated source, before Git retains it. Never rewrite an existing app. */
export const scopeGeneratedPackage = (files: SourceFiles, namespace: string, name: string) =>
  Effect.gen(function* () {
    const file = files.find((file) => file.path === "package.json");
    if (file === undefined || !isTextFile(file))
      return yield* new RegistryError({ reason: "invalid-manifest" });
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
      file.content,
    ).pipe(Effect.mapError(() => new RegistryError({ reason: "invalid-manifest" })));
    const qualified = publicPackageName(namespace, name);
    if (Option.isNone(qualified)) return yield* new RegistryError({ reason: "invalid-manifest" });
    return yield* Schema.decodeUnknownEffect(SourceFiles)(
      files.map((entry) =>
        entry === file
          ? { ...entry, content: JSON.stringify({ ...manifest, name: qualified.value }, null, 2) }
          : entry,
      ),
    ).pipe(Effect.mapError(() => new RegistryError({ reason: "invalid-source" })));
  });

export const PublicationInputs = {
  status: Schema.Struct({}),
  /** Check `files` when the caller already holds the working source; otherwise the workspace is read. */
  preview: Schema.Struct({
    app: AppId,
    owner: OwnerId,
    namespace: Schema.NonEmptyString,
    files: Schema.optional(SourceFiles),
  }),
  publish: Schema.Struct({
    app: AppId,
    owner: OwnerId,
    namespace: Schema.NonEmptyString,
    commit: SourceCommit,
  }),
  owned: Schema.Struct({ owner: OwnerId }),
  unpublish: Schema.Struct({ owner: OwnerId, package: PackageName }),
};
export const RegistryInputs = {
  list: Schema.Struct({ name: Schema.optional(PackageName) }),
  snapshot: Schema.Struct({ name: PackageName, commit: SourceCommit }),
  file: Schema.Struct({ name: PackageName, commit: SourceCommit, path: SourceFilePath }),
};
