/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message, executor/no-instanceof-error, executor/no-instanceof-tagged-error -- boundary: git protocol failures normalize to AppSourceError */
import { Effect, Schema } from "effect";

import { handFetch, handRefsCheck } from "../git-client/hand";
import { hasTokenLikeQuery, redactUrl, validateGitFetchUrl } from "../git-client/url-security";
import { PublishError, enforcePublishLimits, type PublishFile } from "../pipeline/publish";
import { AppSourceError, type AppSourceSnapshot } from "./app-source";
import {
  classifyAppSourcePath,
  isRelevantAppSourcePath,
  type SourceSkippedFile,
} from "./relevant-files";

export interface GitAppSourceInput {
  readonly url: string;
  readonly ref?: string;
  readonly token?: string | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBytes?: number;
  readonly allowPrivateHosts?: boolean;
}

export interface GitAppSourceSnapshot extends AppSourceSnapshot {
  readonly url: string;
  readonly ref?: string;
  readonly resolvedRef: string;
  readonly skipped: readonly SourceSkippedFile[];
  readonly packBytes: number;
}

export interface GitRefsSnapshot {
  readonly sourceRef: string;
  readonly resolvedRef: string;
}

const textDecoder = new TextDecoder();
const decodeExecutorJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export const parseGitSourceUrl = (
  input: string,
  options: { readonly allowPrivateHosts?: boolean } = {},
): Effect.Effect<URL, AppSourceError> =>
  Effect.try({
    try: () => {
      const url = validateGitFetchUrl(input.trim(), options);
      if (hasTokenLikeQuery(url)) {
        throw new AppSourceError({
          message: "git source URL must not include token query parameters",
          path: redactUrl(input),
        });
      }
      return url;
    },
    catch: (cause) =>
      cause instanceof AppSourceError
        ? cause
        : new AppSourceError({
            message: cause instanceof Error ? cause.message : "git source URL is not valid",
            path: redactUrl(input),
            cause,
          }),
  });

const descriptionFor = (
  files: readonly PublishFile[],
): Effect.Effect<string | undefined, AppSourceError> =>
  Effect.gen(function* () {
    const file = files.find((item) => item.path === "executor.json");
    if (!file) return undefined;
    const parsed = yield* decodeExecutorJson(textDecoder.decode(file.bytes)).pipe(
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

const relevantFiles = (
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): { readonly files: readonly PublishFile[]; readonly skipped: readonly SourceSkippedFile[] } => {
  const out: PublishFile[] = [];
  const skipped: SourceSkippedFile[] = [];
  for (const file of files) {
    if (!isRelevantAppSourcePath(file.path)) {
      const classified = classifyAppSourcePath(file.path);
      if (classified !== "fetch") skipped.push(classified);
      continue;
    }
    out.push({ path: file.path, bytes: file.bytes });
  }
  return { files: out, skipped };
};

export const checkGitAppSourceRefs = (
  input: GitAppSourceInput,
): Effect.Effect<GitRefsSnapshot, AppSourceError> =>
  Effect.gen(function* () {
    yield* parseGitSourceUrl(input.url, { allowPrivateHosts: input.allowPrivateHosts });
    const checked = yield* Effect.tryPromise({
      try: () =>
        handRefsCheck(input.url, input.ref, {
          ...(input.token ? { token: input.token } : {}),
          ...(input.fetch ? { fetchImpl: input.fetch } : {}),
          allowPrivateHosts: input.allowPrivateHosts,
        }),
      catch: (cause) =>
        new AppSourceError({
          message: `git refs check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: redactUrl(input.url),
          cause,
        }),
    });
    if (!checked.ok || !checked.sha || !checked.resolvedRef) {
      return yield* new AppSourceError({
        message: checked.error ?? "git refs check failed",
        path: redactUrl(input.url),
      });
    }
    return { sourceRef: checked.sha, resolvedRef: checked.resolvedRef };
  });

export const fetchGitAppSource = (
  input: GitAppSourceInput,
): Effect.Effect<GitAppSourceSnapshot, AppSourceError | PublishError> =>
  Effect.gen(function* () {
    yield* parseGitSourceUrl(input.url, { allowPrivateHosts: input.allowPrivateHosts });
    const fetched = yield* Effect.tryPromise({
      try: () =>
        handFetch(input.url, input.ref, {
          ...(input.token ? { token: input.token } : {}),
          ...(input.fetch ? { fetchImpl: input.fetch } : {}),
          ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
          allowPrivateHosts: input.allowPrivateHosts,
        }),
      catch: (cause) =>
        new AppSourceError({
          message: `git fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: redactUrl(input.url),
          cause,
        }),
    });
    if (fetched.truncated === true) {
      return yield* new AppSourceError({
        message: fetched.error ?? "git repository is too large",
        path: redactUrl(input.url),
      });
    }
    if (!fetched.ok || !fetched.sha || !fetched.resolvedRef || !fetched.files) {
      return yield* new AppSourceError({
        message: fetched.error ?? "git fetch failed",
        path: redactUrl(input.url),
      });
    }
    const collected = relevantFiles(fetched.files);
    const limitError = enforcePublishLimits(collected.files);
    if (limitError) return yield* limitError;
    return {
      url: input.url,
      ...(input.ref ? { ref: input.ref } : {}),
      resolvedRef: fetched.resolvedRef,
      files: collected.files,
      sourceRef: fetched.sha,
      description: yield* descriptionFor(collected.files),
      skipped: collected.skipped,
      packBytes: fetched.packBytes ?? 0,
    };
  });

export const makeGitAppSource = (input: GitAppSourceInput) => ({
  fetch: () => fetchGitAppSource(input),
});
