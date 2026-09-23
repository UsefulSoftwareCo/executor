/** One source check for publication previews, writes, and imported package naming. */
import { Effect, Option, Schema } from "effect";
import { JsonObject, SourceFiles } from "@executor-js/sdk/core";
import {
  PackageManifest,
  PackageName,
  PublicationIssue,
  RegistryError,
  publicPackageName,
} from "../contracts/registry.ts";

const invalid = (reason: typeof PublicationIssue.Type.reason, name: string | null = null) =>
  new PublicationIssue({ reason, name });

/** Parse the exact saved source that will be published without evaluating any app code. */
export const publicationSource = (files: SourceFiles) =>
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
export const publicationFailure = (issue: PublicationIssue): RegistryError => {
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

/** Scope only freshly generated source, before Git retains it. Never rewrite an existing app. */
export const scopeGeneratedPackage = (files: SourceFiles, namespace: string, name: string) =>
  Effect.gen(function* () {
    const file = files.find((file) => file.path === "package.json");
    if (file === undefined) return yield* new RegistryError({ reason: "invalid-manifest" });
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
