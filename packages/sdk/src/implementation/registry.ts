/** Publish a chosen Git snapshot; installation creates an ordinary, independently owned app. */
import { Clock, Effect, Option, Result, Schema } from "effect";
import type { Executor } from "../contracts/executor.ts";
import {
  PackageManifest,
  PackageName,
  Publication,
  PublicationIssue,
  PublicationReadiness,
  PublicationSnapshot,
  RegistryError,
  publicPackageName,
  type PublicationReference,
  type Registry,
  type RegistryOptions,
  type RegistryStorage,
} from "../contracts/registry.ts";
import { JsonObject } from "../contracts/shared.ts";
import { SourceFiles, type AppSourceStorage } from "../contracts/source.ts";
import type { AppCopySnapshot } from "../contracts/apps.ts";
import type { Query } from "./database.ts";
import { storedApp } from "./apps.ts";
import { initializeAppRepository } from "./initial-source.ts";
import type { BlobStorage } from "../contracts/blobs.ts";

const invalid = (reason: typeof PublicationIssue.Type.reason, name: string | null = null) =>
  new PublicationIssue({ reason, name });

/** Parse the exact saved source that will be published without evaluating any app code. */
const publicationSource = (files: SourceFiles) =>
  Effect.gen(function* () {
    if (
      files.length > 512 ||
      files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0) >
        4 * 1024 * 1024
    )
      return yield* invalid("limit");
    if (
      files.some(
        (file) =>
          /(^|\/)(?:\.git|node_modules|\.env(?:\..*)?|\.npmrc|\.executor)(?:\/|$)/.test(
            file.path,
          ) ||
          file.path === "executor.lock.json" ||
          file.path.startsWith("__executor_deps/"),
      )
    )
      return yield* invalid("invalid-source");
    const file = files.find((file) => file.path === "package.json");
    if (file === undefined) return yield* invalid("missing-manifest");
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
      file.content,
    ).pipe(Effect.mapError(() => invalid("invalid-json")));
    const name = document.name;
    if (name === undefined || name === "") return yield* invalid("missing-name");
    if (typeof name !== "string") return yield* invalid("invalid-name");
    if (!Schema.is(PackageName)(name))
      return yield* invalid(
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? "unscoped-name" : "invalid-name",
        name,
      );
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifest)(document).pipe(
      Effect.mapError(() => invalid("invalid-metadata", name)),
    );
    if (Object.keys(manifest.executor?.dependencies ?? {}).length > 0)
      return yield* invalid("unsupported-dependencies", name);
    return manifest;
  });

/** Keep the established write error contract while previews expose the precise repair. */
const publicationFailure = (issue: PublicationIssue): RegistryError => {
  switch (issue.reason) {
    case "forbidden-scope":
      return new RegistryError({ reason: "forbidden" });
    case "name-taken":
      return new RegistryError({ reason: "conflict" });
    case "limit":
    case "invalid-source":
    case "unsupported-dependencies":
      return new RegistryError({ reason: issue.reason });
    case "missing-manifest":
    case "invalid-json":
    case "missing-name":
    case "unscoped-name":
    case "invalid-name":
    case "invalid-metadata":
      return new RegistryError({ reason: "invalid-manifest" });
  }
};

/** A catalog entry reads its pinned Git snapshot, independent of the editable default branch. */
const storedRegistry = (
  storage: RegistryStorage,
  sources: AppSourceStorage,
  origin: string,
): Registry => ({
  origin,
  list: storage.list,
  snapshot: (name, commit) =>
    Effect.gen(function* () {
      const row = yield* storage.get(name);
      if (row.publication.commit !== commit) return yield* new RegistryError({ reason: "changed" });
      const files = yield* sources
        .read(row.source)
        .pipe(Effect.mapError(() => new RegistryError({ reason: "storage" })));
      return PublicationSnapshot.make({ publication: row.publication, files });
    }),
});

/** Resolve reviewed public source for the shared copy operation. No app is created here. */
export const resolvePublication = (
  registry: Registry,
  input: PublicationReference,
): Effect.Effect<AppCopySnapshot, RegistryError> =>
  Effect.gen(function* () {
    const snapshot = yield* registry.snapshot(input.package, input.commit);
    if (snapshot.publication.name !== input.package || snapshot.publication.commit !== input.commit)
      return yield* new RegistryError({ reason: "changed" });
    const manifest = yield* publicationSource(snapshot.files).pipe(
      Effect.mapError(publicationFailure),
    );
    if (manifest.name !== input.package)
      return yield* new RegistryError({ reason: "invalid-source" });
    return {
      files: snapshot.files,
      origin: {
        reference: new URL(
          `/api/registry/source?name=${encodeURIComponent(input.package)}&commit=${encodeURIComponent(input.commit)}`,
          registry.origin,
        ).href,
        name: input.package,
        commit: input.commit,
      },
      activation: "deploy",
    };
  });

const unsupported = () => new RegistryError({ reason: "unsupported" });

/** Catalog reads for every executor; publication writes only where the catalog is stored here. */
export const makeRegistry = (
  options: RegistryOptions,
  origin: string,
  db: Query,
  sources: AppSourceStorage,
  blobs: BlobStorage,
): {
  readonly reads: Registry;
  readonly registry: Executor["registry"];
  readonly publications: Executor["publications"];
} => {
  const stored = "storage" in options ? options.storage : undefined;
  const reads: Registry =
    stored === undefined ? (options as Registry) : storedRegistry(stored, sources, origin);
  const registry: Executor["registry"] = {
    list: (input = {}) => reads.list(input.name),
    snapshot: (input) => reads.snapshot(input.name, input.commit),
  };
  if (stored === undefined)
    return {
      reads,
      registry,
      publications: {
        status: () => Effect.succeed({ publishing: false, origin: reads.origin }),
        preview: () => Effect.fail(unsupported()),
        publish: () => Effect.fail(unsupported()),
        owned: () => Effect.succeed([]),
        unpublish: () => Effect.fail(unsupported()),
      },
    };
  const storage = stored;
  const validate = (input: {
    readonly owner: Parameters<Executor["publications"]["publish"]>[0]["owner"];
    readonly namespace: string;
    readonly app: Parameters<Executor["publications"]["publish"]>[0]["app"];
    readonly files: SourceFiles;
  }) =>
    Effect.gen(function* () {
      const manifest = yield* publicationSource(input.files);
      const scope = manifest.name.slice(1, manifest.name.indexOf("/"));
      const owner = yield* storage.scopeOwner(scope);
      if (owner === null ? scope !== input.namespace : owner !== input.owner)
        return yield* new PublicationIssue({ reason: "forbidden-scope", name: manifest.name });
      const existing = yield* storage.get(manifest.name).pipe(
        Effect.map(Option.some),
        Effect.catchTag("RegistryError", (error) =>
          error.reason === "not-found" ? Effect.succeed(Option.none()) : Effect.fail(error),
        ),
      );
      if (Option.isSome(existing) && existing.value.app !== input.app)
        return yield* new PublicationIssue({ reason: "name-taken", name: manifest.name });
      return manifest;
    });
  return {
    reads,
    registry,
    publications: {
      status: () => Effect.succeed({ publishing: true, origin: reads.origin }),
      preview: (input) =>
        Effect.gen(function* () {
          const app = yield* storedApp(db, input);
          const files =
            input.files ??
            (yield* Effect.gen(function* () {
              const initialized = yield* initializeAppRepository(db, sources, blobs, app);
              const workspace = Option.isSome(initialized)
                ? initialized.value
                : yield* sources.workspace(app.code);
              if (workspace === null) return yield* new RegistryError({ reason: "not-found" });
              return workspace.files;
            }));
          const checked = yield* validate({ ...input, files }).pipe(Effect.result);
          if (Result.isSuccess(checked))
            return PublicationReadiness.make({ status: "ready", manifest: checked.success });
          if (!Schema.is(PublicationIssue)(checked.failure))
            return yield* Effect.fail(checked.failure);
          const initial = publicPackageName(input.namespace, app.name);
          const suggested =
            checked.failure.reason === "name-taken" &&
            Option.isSome(initial) &&
            initial.value === checked.failure.name
              ? publicPackageName(input.namespace, `${app.name} copy`)
              : initial;
          return PublicationReadiness.make({
            status: "blocked",
            issue: checked.failure,
            suggestedName: Option.getOrNull(suggested),
          });
        }).pipe(Effect.withSpan("sdk.publications.preview")),
      publish: (input) =>
        Effect.gen(function* () {
          const app = yield* storedApp(db, input);
          const files = yield* sources
            .read({ code: app.code, commit: input.commit })
            .pipe(Effect.mapError(() => new RegistryError({ reason: "invalid-source" })));
          const manifest = yield* validate({ ...input, files }).pipe(
            Effect.catchTag("PublicationIssue", (issue) => Effect.fail(publicationFailure(issue))),
          );
          const source = yield* sources
            .retain(app.code, files)
            .pipe(Effect.mapError(() => new RegistryError({ reason: "storage" })));
          return yield* storage.publish({
            name: manifest.name,
            owner: input.owner,
            app: app.id,
            source,
            publication: Publication.make({
              name: manifest.name,
              commit: input.commit,
              description: manifest.description ?? "",
              publishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            }),
          });
        }).pipe(Effect.withSpan("sdk.publications.publish")),
      owned: (input) => storage.owned(input.owner),
      unpublish: (input) =>
        storage.unpublish(input.owner, input.package).pipe(Effect.as({ name: input.package })),
    },
  };
};
