/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-instanceof-tagged-error -- boundary: filesystem path validation and fs errors normalize to AppSourceError */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { Effect, Schema } from "effect";

import { PublishError, enforcePublishLimits, type PublishFile } from "../pipeline/publish";
import { AppSourceError, type AppSourceSnapshot } from "./app-source";
import {
  classifyAppSourcePath,
  isRelevantAppSourcePath,
  type SourceSkippedFile,
} from "./relevant-files";

export interface LocalDirectoryAppSourceInput {
  readonly path: string;
}

export interface LocalDirectoryAppSourceSnapshot extends AppSourceSnapshot {
  readonly root: string;
  readonly skipped: readonly SourceSkippedFile[];
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const validateRoot = (path: string): Effect.Effect<string, AppSourceError> =>
  Effect.try({
    try: () => {
      if (!isAbsolute(path)) {
        throw new AppSourceError({ message: "local-directory source path must be absolute", path });
      }
      const parts = path.split(/[\\/]+/);
      if (parts.includes("..")) {
        throw new AppSourceError({
          message: "local-directory source path must not contain ..",
          path,
        });
      }
      return resolve(path);
    },
    catch: (cause) =>
      cause instanceof AppSourceError
        ? cause
        : new AppSourceError({ message: "invalid local-directory source path", path, cause }),
  });

const isUnderRoot = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const readRegularFileNoFollow = (
  root: string,
  rootReal: string,
  child: string,
): Effect.Effect<Uint8Array, AppSourceError> =>
  Effect.tryPromise({
    try: async () => {
      const fullPath = `${root}${sep}${child}`;
      const before = await lstat(fullPath);
      if (!before.isFile()) throw new Error("not a regular file");
      const resolved = await realpath(fullPath);
      if (!isUnderRoot(rootReal, resolved)) throw new Error("file resolves outside source root");
      const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const after = await handle.stat();
        if (!after.isFile()) throw new Error("not a regular file");
        if (before.dev !== after.dev || before.ino !== after.ino) {
          throw new Error("file changed while being read");
        }
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new AppSourceError({
        message: `failed to read local-directory file: ${child}`,
        path: child,
        cause,
      }),
  });

const walk = (
  root: string,
  rootReal: string,
  relative = "",
): Effect.Effect<
  { readonly files: readonly PublishFile[]; readonly skipped: readonly SourceSkippedFile[] },
  AppSourceError | PublishError
> =>
  Effect.gen(function* () {
    const dir = relative ? `${root}${sep}${relative}` : root;
    const entries = yield* Effect.tryPromise({
      try: () => readdir(dir, { withFileTypes: true }),
      catch: (cause) =>
        new AppSourceError({
          message: `failed to read local-directory source: ${relative || root}`,
          path: relative || root,
          cause,
        }),
    });
    const files: PublishFile[] = [];
    const skipped: SourceSkippedFile[] = [];
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: child, reason: "unsupported file type" });
        continue;
      }
      if (entry.isDirectory()) {
        if (
          child === "tools" ||
          child === "workflows" ||
          child === "ui" ||
          child === "skills" ||
          child.startsWith("tools/") ||
          child.startsWith("workflows/") ||
          child.startsWith("ui/") ||
          child.startsWith("skills/")
        ) {
          const nested = yield* walk(root, rootReal, child);
          files.push(...nested.files);
          skipped.push(...nested.skipped);
        }
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: child, reason: "unsupported file type" });
        continue;
      }
      const classified = classifyAppSourcePath(child);
      if (classified !== "fetch") {
        skipped.push(classified);
        continue;
      }
      if (!isRelevantAppSourcePath(child)) continue;
      const bytes = yield* readRegularFileNoFollow(root, rootReal, child);
      files.push({ path: child, bytes });
    }
    const limitError = enforcePublishLimits(files);
    if (limitError) return yield* limitError;
    return { files, skipped };
  });

const sourceRefFor = (files: readonly PublishFile[]): string => {
  const manifest = files
    .map((file) => `${file.path}:${sha256(file.bytes)}`)
    .sort()
    .join("\n");
  return sha256(manifest);
};

const decodeExecutorJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const descriptionFor = (
  files: readonly PublishFile[],
): Effect.Effect<string | undefined, AppSourceError> =>
  Effect.gen(function* () {
    const file = files.find((item) => item.path === "executor.json");
    if (!file) return undefined;
    const parsed = yield* decodeExecutorJson(new TextDecoder().decode(file.bytes)).pipe(
      Effect.mapError(
        (cause) =>
          new AppSourceError({
            message: "executor.json is not valid JSON",
            path: "executor.json",
            cause,
          }),
      ),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const description = (parsed as { readonly description?: unknown }).description;
    return typeof description === "string" ? description : undefined;
  });

export const fetchLocalDirectoryAppSource = (
  input: LocalDirectoryAppSourceInput,
): Effect.Effect<LocalDirectoryAppSourceSnapshot, AppSourceError | PublishError> =>
  Effect.gen(function* () {
    const root = yield* validateRoot(input.path);
    const rootReal = yield* Effect.tryPromise({
      try: () => realpath(root),
      catch: (cause) =>
        new AppSourceError({
          message: "failed to resolve local-directory source root",
          path: root,
          cause,
        }),
    });
    const collected = yield* walk(root, rootReal);
    return {
      root,
      files: collected.files,
      sourceRef: sourceRefFor(collected.files),
      description: yield* descriptionFor(collected.files),
      skipped: collected.skipped,
    };
  });

export const makeLocalDirectoryAppSource = (input: LocalDirectoryAppSourceInput) => ({
  fetch: () => fetchLocalDirectoryAppSource(input),
});
