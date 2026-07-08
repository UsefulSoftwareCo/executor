import { Effect, Predicate, Schema } from "effect";
import { sha256Hex, type Owner } from "@executor-js/sdk";

import type { AppToolExecutor, CollectedTool } from "../executor/app-tool-executor";
import type { AppsStore } from "../plugin/store";
import { bundleEntry } from "./bundle";
import {
  DESCRIPTOR_VERSION,
  stableStringify,
  type AppDescriptor,
  type ModuleSourceRef,
  type ToolDescriptor,
} from "./descriptor";
import { toolchainRef } from "./bundle";
import { discover, PublishError, type SkippedArtifact } from "./discover";

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
  readonly now?: () => number;
}

const textDecoder = new TextDecoder();

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
      const bundled = yield* bundleEntry({ files, entry: artifact.entry }).pipe(
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

    const descriptorSeed = {
      version: DESCRIPTOR_VERSION,
      app: input.app,
      sourceRef: input.sourceRef,
      descriptorKey: "",
      publishedAt: deps.now?.() ?? Date.now(),
      toolchain: toolchainRef(),
      tools,
      workflows: discovered.skipped.filter((item) => item.path.startsWith("workflows/")),
      ui: discovered.skipped.filter((item) => item.path.startsWith("ui/")),
      skills: discovered.skipped.filter((item) => item.path.startsWith("skills/")),
      skipped: discovered.skipped,
    };
    const descriptorBodyWithoutKey = stableStringify(descriptorSeed);
    const descriptorKey = yield* deps.store.putBlob(descriptorBodyWithoutKey, owner).pipe(
      Effect.mapError(
        () =>
          new PublishError({
            stage: "project",
            message: "failed to write descriptor blob",
            diagnostics: [],
          }),
      ),
    );
    const descriptor: AppDescriptor = { ...descriptorSeed, descriptorKey };
    const descriptorBody = stableStringify(descriptor);
    const finalDescriptorKey = yield* deps.store.putBlob(descriptorBody, owner).pipe(
      Effect.mapError(
        () =>
          new PublishError({
            stage: "project",
            message: "failed to write final descriptor blob",
            diagnostics: [],
          }),
      ),
    );
    const finalDescriptor: AppDescriptor = { ...descriptor, descriptorKey: finalDescriptorKey };
    yield* deps.store.putPublished(finalDescriptor, owner, existing?.sourceRef ?? null).pipe(
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
      descriptor: finalDescriptor,
      publishedTools: finalDescriptor.tools.map((tool) => tool.name),
      skipped: discovered.skipped,
      noop: false,
    };
  });
