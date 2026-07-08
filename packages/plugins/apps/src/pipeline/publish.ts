import { Effect, Predicate, Schema } from "effect";
import { sha256Hex, type Owner } from "@executor-js/sdk";

import type { AppToolExecutor, CollectedTool } from "../executor/app-tool-executor";
import type { AppsStore } from "../plugin/store";
import { bundleEntry, inProcessBundleBackend, type BundleBackend } from "./bundle";
import {
  DESCRIPTOR_VERSION,
  stableStringify,
  type AppDescriptor,
  type ModuleSourceRef,
  type ToolDescriptor,
} from "./descriptor";
import { discover, PublishError, type SkippedArtifact } from "./discover";
export { PublishError } from "./discover";

export const PUBLISH_LIMITS = {
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
} as const;

export interface PublishFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PublishInput {
  readonly app: string;
  readonly owner?: Owner;
  readonly files: readonly PublishFile[];
  readonly sourceRef: string;
}

export interface PublishResult {
  readonly descriptor: AppDescriptor;
  readonly publishedTools: readonly string[];
  readonly skipped: readonly SkippedArtifact[];
  readonly noop: boolean;
}

export interface PublishDeps {
  readonly store: AppsStore;
  readonly executor: AppToolExecutor;
  readonly bundler?: BundleBackend;
  readonly now?: () => number;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const byteLength = (value: Uint8Array | string): number =>
  typeof value === "string" ? textEncoder.encode(value).byteLength : value.byteLength;

export const enforcePublishLimits = (files: readonly PublishFile[]): PublishError | null => {
  const diagnostics: { readonly path: string; readonly message: string }[] = [];
  if (files.length > PUBLISH_LIMITS.maxFiles) {
    diagnostics.push({
      path: "",
      message: `publish has ${files.length} files, exceeding the limit of ${PUBLISH_LIMITS.maxFiles}`,
    });
  }
  let total = 0;
  for (const file of files) {
    const size = byteLength(file.bytes);
    total += size;
    if (size > PUBLISH_LIMITS.maxFileBytes) {
      diagnostics.push({
        path: file.path,
        message: `file is ${size} bytes, exceeding the per-file limit of ${PUBLISH_LIMITS.maxFileBytes} bytes`,
      });
    }
  }
  if (total > PUBLISH_LIMITS.maxTotalBytes) {
    diagnostics.push({
      path: "",
      message: `publish total is ${total} bytes, exceeding the total limit of ${PUBLISH_LIMITS.maxTotalBytes} bytes`,
    });
  }
  return diagnostics.length === 0
    ? null
    : new PublishError({
        stage: "discover",
        message: `publish payload exceeds limits (${diagnostics.length} problem(s))`,
        diagnostics,
      });
};

const fileMap = (files: readonly PublishFile[]): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const file of files) out.set(file.path, textDecoder.decode(file.bytes));
  return out;
};

const sourceRef = (path: string, source: string): Effect.Effect<ModuleSourceRef> =>
  sha256Hex(source).pipe(Effect.map((sourceHash) => ({ path, sourceHash })));

const isPublishError = Predicate.isTagged("PublishError") as (
  value: unknown,
) => value is PublishError;

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

const toPublishError = (
  stage: PublishError["stage"],
  path: string,
  cause: {
    readonly message: string;
    readonly diagnostics?: readonly { readonly path: string; readonly message: string }[];
  },
): PublishError =>
  new PublishError({
    stage,
    // oxlint-disable-next-line executor/no-unknown-error-message -- typed AppExecutorError conversion keeps its stable diagnostic message
    message: cause.message,
    diagnostics:
      cause.diagnostics && cause.diagnostics.length > 0
        ? cause.diagnostics
        : // oxlint-disable-next-line executor/no-unknown-error-message -- typed AppExecutorError conversion keeps its stable diagnostic message
          [{ path, message: cause.message }],
  });

const toolDescriptor = (input: {
  readonly collected: CollectedTool;
  readonly sourcePath: string;
  readonly bundleKey: string;
  readonly source: ModuleSourceRef;
}): ToolDescriptor => ({
  name: input.collected.toolName,
  sourcePath: input.sourcePath,
  bundleKey: input.bundleKey,
  source: input.source,
  description: input.collected.description,
  integrations: input.collected.integrations,
  inputSchema: input.collected.inputSchema,
  outputSchema: input.collected.outputSchema,
  annotations: input.collected.annotations,
});

export const publish = (
  deps: PublishDeps,
  input: PublishInput,
): Effect.Effect<PublishResult, PublishError> =>
  Effect.gen(function* () {
    const owner = input.owner ?? "org";
    const bundler = deps.bundler ?? inProcessBundleBackend();
    const limitError = enforcePublishLimits(input.files);
    if (limitError) return yield* limitError;
    const files = fileMap(input.files);
    const discovered = discover(files);
    if (isPublishError(discovered)) return yield* discovered;

    const existing = yield* deps.store.getDescriptorRecord(input.app).pipe(
      Effect.mapError(
        (cause) =>
          new PublishError({
            stage: "project",
            message: "failed to read existing app descriptor",
            diagnostics: [],
            cause,
          } as never),
      ),
    );
    if (existing?.sourceRef === input.sourceRef) {
      const descriptorBody = yield* deps.store.getBlob(existing.descriptorKey).pipe(
        Effect.mapError(
          () =>
            new PublishError({
              stage: "project",
              message: "failed to read existing descriptor blob",
              diagnostics: [],
            }),
        ),
      );
      if (descriptorBody) {
        return {
          descriptor: decodeJson(descriptorBody) as AppDescriptor,
          publishedTools: [],
          skipped: discovered.skipped,
          noop: true,
        };
      }
    }

    const staged: {
      readonly entry: string;
      readonly bundle: string;
      readonly collected: readonly CollectedTool[];
      readonly source: ModuleSourceRef;
    }[] = [];
    for (const artifact of discovered.tools) {
      const bundled = yield* bundleEntry({ files, entry: artifact.entry }, bundler).pipe(
        Effect.mapError((cause) => toPublishError("bundle", artifact.entry, cause)),
      );
      const collected = yield* deps.executor
        .collect(bundled.code, { fileSlug: artifact.name, sourcePath: artifact.entry })
        .pipe(Effect.mapError((cause) => toPublishError("collect", artifact.entry, cause)));
      const source = yield* sourceRef(artifact.entry, files.get(artifact.entry) ?? "");
      staged.push({
        entry: artifact.entry,
        bundle: bundled.code,
        collected: collected.tools,
        source,
      });
    }

    const tools: ToolDescriptor[] = [];
    for (const artifact of staged) {
      const bundleKey = yield* deps.store.putBlob(artifact.bundle, owner).pipe(
        Effect.mapError(
          () =>
            new PublishError({
              stage: "project",
              message: `failed to write bundle for ${artifact.entry}`,
              diagnostics: [{ path: artifact.entry, message: "bundle blob write failed" }],
            }),
        ),
      );
      for (const tool of artifact.collected) {
        tools.push(
          toolDescriptor({
            collected: tool,
            sourcePath: artifact.entry,
            bundleKey,
            source: artifact.source,
          }),
        );
      }
    }

    const descriptor: AppDescriptor = {
      version: DESCRIPTOR_VERSION,
      app: input.app,
      sourceRef: input.sourceRef,
      publishedAt: deps.now?.() ?? Date.now(),
      toolchain: bundler.toolchain(),
      tools,
      workflows: discovered.skipped.filter((item) => item.path.startsWith("workflows/")),
      ui: discovered.skipped.filter((item) => item.path.startsWith("ui/")),
      skills: discovered.skipped.filter((item) => item.path.startsWith("skills/")),
      skipped: discovered.skipped,
    };
    const descriptorBody = stableStringify(descriptor);
    const descriptorKey = yield* deps.store.putBlob(descriptorBody, owner).pipe(
      Effect.mapError(
        () =>
          new PublishError({
            stage: "project",
            message: "failed to write descriptor blob",
            diagnostics: [],
          }),
      ),
    );
    yield* deps.store
      .putPublished(descriptor, descriptorKey, owner, existing?.sourceRef ?? null)
      .pipe(
        Effect.mapError((cause) => {
          if (Predicate.isTagged("AppPublishConflictError")(cause)) {
            return new PublishError({
              stage: "project",
              message: `app "${input.app}" changed during publish`,
              diagnostics: [{ path: "", message: "publish sourceRef changed during publish" }],
            });
          }
          return new PublishError({
            stage: "project",
            message: "failed to persist app publication",
            diagnostics: [],
          });
        }),
      );
    return {
      descriptor,
      publishedTools: descriptor.tools.map((tool) => tool.name),
      skipped: discovered.skipped,
      noop: false,
    };
  });
