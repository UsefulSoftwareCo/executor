import { Effect, Schema } from "effect";

const PackageName = Schema.String.check(
  Schema.isPattern(/^@[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,62}$/u),
);
const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const SourceFilePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => {
      if (path.includes("\0")) return "expected no NUL bytes";
      if (path.includes("\\")) return "expected POSIX separators";
      if (path.startsWith("/")) return "expected a relative path";
      return path.length > 0 && path.split("/").every((s) => s !== "" && s !== "." && s !== "..")
        ? true
        : "expected canonical segments (non-empty, no `.` or `..`)";
    }),
  ),
);
const publicSourcePrefix = "ui/public/";
const SourceTextFile = Schema.Struct({ path: SourceFilePath, content: Schema.String });
const SourceBinaryFile = Schema.Struct({
  path: SourceFilePath,
  content: Schema.String.check(
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  ),
  encoding: Schema.Literal("base64"),
});
const SourceStoredFile = Schema.Struct({
  path: SourceFilePath,
  object: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const SourceFile = Schema.Union([SourceBinaryFile, SourceStoredFile, SourceTextFile]);
type SourceFile = typeof SourceFile.Type;
const isTextFile = (file: SourceFile): file is typeof SourceTextFile.Type =>
  !("object" in file) && !("encoding" in file);
const SourceFiles = Schema.NonEmptyArray(SourceFile).pipe(
  Schema.check(
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      new Set(files.map((f) => f.path)).size === files.length ? true : "expected unique paths",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      files.some((f) => f.path === "index.ts") ? true : "expected a root index.ts",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) => {
      const misplaced = files.find(
        (file) => !isTextFile(file) && !file.path.startsWith(publicSourcePrefix),
      );
      return misplaced === undefined
        ? true
        : `expected ${misplaced.path} to be UTF-8 text: only files under ${publicSourcePrefix} may be binary or stored`;
    }),
  ),
);
const AppCodeId = Schema.String.check(Schema.isPattern(/^code_[\s\S]+$/u));
const SourceSnapshot = Schema.Struct({
  revision: Schema.Struct({ code: AppCodeId, commit: SourceCommit }),
  files: SourceFiles,
});
const PackageManifest = Schema.Struct({
  name: PackageName,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
});
const PublicationIssue = Schema.Struct({
  _tag: Schema.Literal("PublicationIssue"),
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
});
const PublicationReadiness = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), manifest: PackageManifest }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    issue: PublicationIssue,
    suggestedName: Schema.NullOr(PackageName),
  }),
]);
const Publication = Schema.Struct({
  name: PackageName,
  commit: SourceCommit,
  description: Schema.String,
  publishedAt: Schema.String,
});
const PublicationSnapshot = Schema.Struct({ publication: Publication, files: SourceFiles });
const AppSourceView = Schema.Struct({
  ...SourceSnapshot.fields,
  namespace: Schema.NullOr(Schema.String),
  gitPath: Schema.String,
  gitUrl: Schema.String,
  canEdit: Schema.Boolean,
  publication: Schema.NullOr(PublicationReadiness),
});

export const releasedCatalog = (body: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(Publication))(body).pipe(
    Effect.mapError(() => ({ _tag: "RegistryError", reason: "invalid-source" }) as const),
  );

export const releasedInstall = (body: unknown, name: string, commit: string) =>
  Effect.gen(function* () {
    const snapshot = yield* Schema.decodeUnknownEffect(PublicationSnapshot)(body).pipe(
      Effect.mapError(() => "invalid-source" as const),
    );
    if (snapshot.publication.name !== name || snapshot.publication.commit !== commit)
      return yield* Effect.fail("changed" as const);
    const manifest = snapshot.files.find((file) => file.path === "package.json");
    if (manifest === undefined || !isTextFile(manifest))
      return yield* Effect.fail("invalid-manifest" as const);
    const document = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ name: Schema.Unknown })),
    )(manifest.content).pipe(Effect.mapError(() => "invalid-manifest" as const));
    if (!Schema.is(PackageName)(document.name)) return yield* Effect.fail("invalid-manifest");
    if (document.name !== name) return yield* Effect.fail("invalid-source" as const);
    return snapshot.files.length;
  });

export const releasedSourceView = (body: unknown) =>
  Schema.decodeUnknownEffect(AppSourceView)(body).pipe(
    Effect.mapError(() => "UnexpectedResponse" as const),
  );

const declaredErrors = new Set([
  "StorageError",
  "SourceError",
  "RegistryError",
  "AppAccessDenied",
  "AppNotFound",
  "AppNotDeployed",
  "DeploymentNotFound",
  "AppNameTaken",
  "AppSlugTaken",
  "AppDeploymentChanged",
  "AccountNotFound",
  "AccountSelectionInvalid",
  "DeploymentBuildFailed",
  "BuildMemoryExceeded",
]);
const HostRecovery = Schema.Struct({ action: Schema.String, instructions: Schema.String });
const HostAnswer = Schema.Struct({
  _tag: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  recovery: Schema.optional(HostRecovery),
});

export const releasedHostAnswer = (status: number, body: unknown) =>
  Schema.decodeUnknownEffect(HostAnswer)(body).pipe(
    Effect.mapError(() => "UnexpectedResponse" as const),
    Effect.filterOrFail(
      (answer) => !declaredErrors.has(answer._tag),
      () => "declared" as const,
    ),
    Effect.map(({ _tag, message, recovery }) => ({
      code: _tag,
      status,
      message,
      ...(recovery === undefined ? {} : { recovery }),
    })),
  );
