import { Effect } from "effect";

import type { ArtifactStore, FileSet, SnapshotId } from "../seams/artifact-store";
import type { ToolSandbox } from "../seams/tool-sandbox";
import { bundleEntry, toolchainRef } from "./bundle";
import {
  DESCRIPTOR_SNAPSHOT_PATH,
  DESCRIPTOR_VERSION,
  FLOW_ENTRIES_KEY,
  GUIDE_ENTRIES_KEY,
  stableStringify,
  type AppDescriptor,
  type ConnectionDecl,
  type ModuleSourceRef,
  type ToolDescriptor,
} from "./descriptor";
import { discover, PublishError, type FileDiagnostic, type SkippedArtifact } from "./discover";

// ---------------------------------------------------------------------------
// publish: discover -> bundle -> collect -> project.
//
// All fallible work happens before persistence. The extracted descriptor is
// written into the snapshot itself (`.executor/descriptor.json`) and the
// snapshot is committed last. The runtime writes the published-descriptor
// pointer only after this commit succeeds.
// ---------------------------------------------------------------------------

export const PUBLISH_LIMITS = {
  /** Max number of files in one publish. */
  maxFiles: 256,
  /** Max bytes for any single file. */
  maxFileBytes: 1024 * 1024,
  /** Max total bytes across all files. */
  maxTotalBytes: 4 * 1024 * 1024,
} as const;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export const enforcePublishLimits = (files: FileSet): PublishError | null => {
  const diagnostics: FileDiagnostic[] = [];
  if (files.size > PUBLISH_LIMITS.maxFiles) {
    diagnostics.push({
      path: "",
      message: `publish has ${files.size} files, exceeding the limit of ${PUBLISH_LIMITS.maxFiles}`,
    });
  }
  let total = 0;
  for (const [path, contents] of files) {
    const size = byteLength(contents);
    total += size;
    if (size > PUBLISH_LIMITS.maxFileBytes) {
      diagnostics.push({
        path,
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
  if (diagnostics.length === 0) return null;
  return new PublishError({
    message: `publish payload exceeds limits (${diagnostics.length} problem(s))`,
    stage: "discover",
    diagnostics,
  });
};

export interface PublishInput {
  readonly scope: string;
  readonly files: FileSet;
  readonly commitMessage?: string;
}

export interface PublishOutput {
  readonly snapshotId: SnapshotId;
  readonly descriptor: AppDescriptor;
  readonly skipped: readonly SkippedArtifact[];
}

const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  });

const sourceRef = (path: string, source: string): Effect.Effect<ModuleSourceRef> =>
  sha256Hex(source).pipe(Effect.map((sourceHash) => ({ path, sourceHash })));

interface CollectedDescriptor {
  readonly kind: "tool";
  readonly description?: string;
  readonly connections?: Record<
    string,
    { decl: string; integration?: string; description?: string }
  >;
  readonly annotations?: ToolDescriptor["annotations"];
  readonly inputJsonSchema?: unknown;
  readonly outputJsonSchema?: unknown;
}

const toConnectionDecls = (
  raw: CollectedDescriptor["connections"],
): Record<string, ConnectionDecl> => {
  const out: Record<string, ConnectionDecl> = {};
  for (const [role, c] of Object.entries(raw ?? {})) {
    if (c.decl === "array") {
      out[role] = { kind: "array", integration: c.integration ?? "", description: c.description };
    } else if (c.decl === "catalog") {
      out[role] = { kind: "catalog" };
    } else {
      out[role] = { kind: "single", integration: c.integration ?? "", description: c.description };
    }
  }
  return out;
};

interface AssembledApp {
  readonly tools: readonly ToolDescriptor[];
  readonly skipped: readonly SkippedArtifact[];
}

export interface PublishDeps {
  readonly artifactStore: ArtifactStore;
  readonly sandbox: ToolSandbox;
}

const assemble = (deps: PublishDeps, files: FileSet): Effect.Effect<AssembledApp, PublishError> =>
  Effect.gen(function* () {
    const discovered = discover(files);
    if (discovered instanceof PublishError) return yield* Effect.fail(discovered);

    const tools: ToolDescriptor[] = [];

    for (const artifact of discovered.artifacts) {
      const bundle = yield* bundleEntry({ files, entry: artifact.entry }).pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({
              message: cause.message,
              stage: "bundle",
              diagnostics: [{ path: artifact.entry, message: cause.message }],
            }),
        ),
      );
      const collected = yield* deps.sandbox.collect(bundle.code).pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({
              message: cause.message,
              stage: "collect",
              diagnostics: [{ path: artifact.entry, message: cause.message }],
            }),
        ),
      );
      const raw = collected.artifacts.default?.descriptor as CollectedDescriptor | undefined;
      if (!raw) {
        return yield* Effect.fail(
          new PublishError({
            message: `no descriptor collected from ${artifact.entry}`,
            stage: "collect",
            diagnostics: [{ path: artifact.entry, message: "defineTool did not run" }],
          }),
        );
      }
      const connections = toConnectionDecls(raw.connections);
      const source = yield* sourceRef(artifact.entry, files.get(artifact.entry) ?? "");
      tools.push({
        name: artifact.name,
        sourcePath: artifact.entry,
        source,
        description: raw.description ?? "",
        connections,
        inputSchema: raw.inputJsonSchema,
        outputSchema: raw.outputJsonSchema,
        annotations: raw.annotations,
      });
    }

    return { tools, skipped: discovered.skipped };
  });

const descriptorBody = (
  scope: string,
  assembled: AssembledApp,
): Omit<AppDescriptor, "snapshotId"> => ({
  version: DESCRIPTOR_VERSION,
  scope,
  toolchain: toolchainRef(),
  tools: assembled.tools,
  [FLOW_ENTRIES_KEY]: [],
  ui: [],
  [GUIDE_ENTRIES_KEY]: [],
});

export const publish = (
  deps: PublishDeps,
  input: PublishInput,
): Effect.Effect<PublishOutput, PublishError> =>
  Effect.gen(function* () {
    const overLimit = enforcePublishLimits(input.files);
    if (overLimit) return yield* Effect.fail(overLimit);

    const assembled = yield* assemble(deps, input.files);
    const body = descriptorBody(input.scope, assembled);

    const scopeStore = yield* deps.artifactStore
      .forScope(input.scope)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({ message: cause.message, stage: "project", diagnostics: [] }),
        ),
      );

    const filesWithDescriptor = new Map(input.files);
    filesWithDescriptor.set(DESCRIPTOR_SNAPSHOT_PATH, stableStringify(body));

    const meta = yield* scopeStore
      .commit(filesWithDescriptor, input.commitMessage ?? `publish ${new Date().toISOString()}`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({ message: cause.message, stage: "project", diagnostics: [] }),
        ),
      );

    const descriptor: AppDescriptor = { ...body, snapshotId: meta.id };

    return { snapshotId: meta.id, descriptor, skipped: assembled.skipped };
  });

export const loadDescriptorFromSnapshot = (
  store: ArtifactStore,
  scope: string,
  snapshotId: SnapshotId,
): Effect.Effect<AppDescriptor | null, PublishError> =>
  Effect.gen(function* () {
    const scopeStore = yield* store
      .forScope(scope)
      .pipe(
        Effect.mapError(
          (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
        ),
      );
    const raw = yield* scopeStore
      .readFile(snapshotId, DESCRIPTOR_SNAPSHOT_PATH)
      .pipe(
        Effect.mapError(
          (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
        ),
      );
    if (raw == null) return null;
    const body = JSON.parse(raw) as Omit<AppDescriptor, "snapshotId">;
    return { ...body, snapshotId };
  });
