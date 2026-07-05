import { Effect } from "effect";

import type { ArtifactStore, FileSet, SnapshotId } from "../seams/artifact-store";
import type { ToolSandbox } from "../seams/tool-sandbox";
import { bundleEntry, toolchainRef } from "./bundle";
import {
  DESCRIPTOR_SNAPSHOT_PATH,
  DESCRIPTOR_VERSION,
  stableStringify,
  type AppDescriptor,
  type ConnectionDecl,
  type ModuleSourceRef,
  type SkillDescriptor,
  type ToolDescriptor,
  type UiDescriptor,
  type WorkflowDescriptor,
} from "./descriptor";
import { discover, PublishError, type DiscoveredArtifact, type FileDiagnostic } from "./discover";
import { validateCron } from "../workflow/scheduler";

// ---------------------------------------------------------------------------
// publish — the compiler. discover (fs-shape) -> bundle (esbuild, platform
// external) -> collect (import in the sandbox with nothing bound; define*
// returns descriptors; run twice + byte-compare = determinism) -> project.
//
// ATOMICITY (Fix 1): ALL fallible work (discover, bundle, collect, descriptor
// assembly, ui/skill blob HASHING + STAGING) happens BEFORE any persistence.
// The extracted descriptor is written INTO the snapshot itself
// (`.executor/descriptor.json`) and the snapshot is committed LAST. Only after
// the commit succeeds are the projections published: the ui/skill blobs (staged
// in memory until now) and the published-descriptor pointer.
//
// Nothing is persisted on a failed publish: a failure in discover/bundle/
// collect/assembly leaves the ArtifactStore and the store untouched (the commit
// never runs). If a projection write fails AFTER the commit, the published app
// is still fully recoverable from the committed snapshot alone — the descriptor
// (incl. the ui/skill blob bytes reachable from the source in the snapshot) is
// in `.executor/descriptor.json`, so projections are idempotently re-derivable
// via `repairProjections` (recompute-on-read). See `loadDescriptorFromSnapshot`.
// ---------------------------------------------------------------------------

// Publish payload limits (Fix 7). A publish file set is user-supplied and
// otherwise unbounded, so an oversized set could exhaust memory / disk before
// any per-file work runs. These caps are enforced up front (before discover),
// so an oversized set fails with a typed diagnostic and nothing is persisted.
export const PUBLISH_LIMITS = {
  /** Max number of files in one publish. */
  maxFiles: 256,
  /** Max bytes for any single file. */
  maxFileBytes: 1024 * 1024, // 1 MiB
  /** Max total bytes across all files. */
  maxTotalBytes: 4 * 1024 * 1024, // 4 MiB
} as const;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** Reject an oversized publish set with a typed diagnostic before any work. */
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

/** Content-addressed blob writer (SHA-256 hex key -> value). Idempotent. */
export type PutBlob = (hash: string, value: string) => Effect.Effect<void, PublishError>;

export interface PublishInput {
  readonly scope: string;
  readonly files: FileSet;
  readonly commitMessage?: string;
}

export interface PublishOutput {
  readonly snapshotId: SnapshotId;
  readonly descriptor: AppDescriptor;
}

const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  });

const sourceRef = (path: string, source: string): Effect.Effect<ModuleSourceRef> =>
  sha256Hex(source).pipe(Effect.map((sourceHash) => ({ path, sourceHash })));

const parseFrontmatter = (body: string): Record<string, string> => {
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};

// The raw shape the sandbox collect returns for one artifact's descriptor.
interface CollectedDescriptor {
  readonly kind: "tool" | "workflow";
  readonly description?: string;
  readonly connections?: Record<
    string,
    { decl: string; integration?: string; description?: string }
  >;
  readonly annotations?: ToolDescriptor["annotations"];
  readonly schedule?: { cron: string; timezone?: string };
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

/** A ui/skill blob staged in memory during assembly, written only AFTER the
 *  snapshot commits (or re-derivable from the snapshot on a repair). */
export interface StagedBlob {
  readonly key: string;
  readonly value: string;
}

/** The result of the all-fallible-work phase: a descriptor (still without a
 *  snapshotId — the commit hash is not known yet) plus the blobs to stage. */
interface AssembledApp {
  readonly tools: readonly ToolDescriptor[];
  readonly workflows: readonly WorkflowDescriptor[];
  readonly ui: readonly UiDescriptor[];
  readonly skills: readonly SkillDescriptor[];
  readonly blobs: readonly StagedBlob[];
}

export interface PublishDeps {
  readonly artifactStore: ArtifactStore;
  readonly sandbox: ToolSandbox;
  readonly putBlob: PutBlob;
}

// ---------------------------------------------------------------------------
// Phase 1 — assemble: everything that can fail, with ZERO persistence. Bundles,
// collects, assembles per-entry descriptors with provenance, and STAGES (hashes,
// does not write) the ui/skill blobs.
// ---------------------------------------------------------------------------
const assemble = (deps: PublishDeps, files: FileSet): Effect.Effect<AssembledApp, PublishError> =>
  Effect.gen(function* () {
    const discovered = discover(files);
    if (discovered instanceof PublishError) return yield* Effect.fail(discovered);

    const tools: ToolDescriptor[] = [];
    const workflows: WorkflowDescriptor[] = [];
    const ui: UiDescriptor[] = [];
    const skills: SkillDescriptor[] = [];
    const blobs: StagedBlob[] = [];

    const codeArtifacts = discovered.artifacts.filter(
      (a): a is DiscoveredArtifact => a.kind === "tool" || a.kind === "workflow",
    );

    // --- bundle + collect each tool/workflow ------------------------------
    for (const artifact of codeArtifacts) {
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
            diagnostics: [{ path: artifact.entry, message: "define* did not run" }],
          }),
        );
      }
      const connections = toConnectionDecls(raw.connections);
      const source = yield* sourceRef(artifact.entry, files.get(artifact.entry) ?? "");
      if (artifact.kind === "tool") {
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
      } else {
        // Validate any declared cron at PUBLISH time (Fix 8): an adversarial
        // cron (`*/0`, negative step, out-of-range) is rejected here with a
        // typed diagnostic rather than reaching the scheduler.
        if (raw.schedule?.cron !== undefined) {
          try {
            validateCron(raw.schedule.cron);
          } catch (cause) {
            return yield* Effect.fail(
              new PublishError({
                message: `workflow "${artifact.name}" has an invalid cron`,
                stage: "collect",
                diagnostics: [
                  {
                    path: artifact.entry,
                    message: cause instanceof Error ? cause.message : String(cause),
                  },
                ],
              }),
            );
          }
        }
        workflows.push({
          name: artifact.name,
          sourcePath: artifact.entry,
          source,
          description: raw.description ?? "",
          connections,
          schedule: raw.schedule,
        });
      }
    }

    // --- ui: bundle for the browser, STAGE the bundle as a blob -----------
    for (const artifact of discovered.artifacts.filter((a) => a.kind === "ui")) {
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
      const hash = yield* sha256Hex(bundle.code);
      blobs.push({ key: `ui/${hash}`, value: bundle.code });
      // Pull title/maxHeight from a `config({...})` call if present (best-effort
      // static scan; the shell also reads config() at mount).
      const src = files.get(artifact.entry) ?? "";
      const titleMatch = src.match(/title:\s*["'`]([^"'`]+)["'`]/);
      const maxHeightMatch = src.match(/maxHeight:\s*(\d+)/);
      const source = yield* sourceRef(artifact.entry, src);
      ui.push({
        name: artifact.name,
        sourcePath: artifact.entry,
        source,
        bundleHash: hash,
        title: titleMatch?.[1],
        maxHeight: maxHeightMatch ? Number(maxHeightMatch[1]) : undefined,
      });
    }

    // --- skills: STAGE the SKILL.md body, index name + description --------
    for (const artifact of discovered.artifacts.filter((a) => a.kind === "skill")) {
      const body = files.get(artifact.entry) ?? "";
      const fm = parseFrontmatter(body);
      const hash = yield* sha256Hex(body);
      blobs.push({ key: `skill/${hash}`, value: body });
      const source = yield* sourceRef(artifact.entry, body);
      skills.push({
        name: artifact.name,
        sourcePath: artifact.entry,
        source,
        description: fm.description ?? "",
        bodyHash: hash,
      });
    }

    return { tools, workflows, ui, skills, blobs };
  });

/** Build the descriptor's stable, snapshot-independent shape. `snapshotId` is
 *  stamped separately (it is the commit hash, not known until the commit) and is
 *  the ONE field that varies with the commit, so the bytes written INTO the
 *  snapshot omit it and a reader stamps it from the commit it read from. */
const descriptorBody = (
  scope: string,
  assembled: AssembledApp,
): Omit<AppDescriptor, "snapshotId"> => ({
  version: DESCRIPTOR_VERSION,
  scope,
  toolchain: toolchainRef(),
  tools: assembled.tools,
  workflows: assembled.workflows,
  ui: assembled.ui,
  skills: assembled.skills,
});

export const publish = (
  deps: PublishDeps,
  input: PublishInput,
): Effect.Effect<PublishOutput, PublishError> =>
  Effect.gen(function* () {
    // --- Phase 0: bound the payload BEFORE any work (Fix 7). Oversized sets
    //     fail with a typed diagnostic and nothing is bundled or persisted. ---
    const overLimit = enforcePublishLimits(input.files);
    if (overLimit) return yield* Effect.fail(overLimit);

    // --- Phase 1: all fallible work, ZERO persistence ---------------------
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

    // --- Phase 2: commit LAST. Write the descriptor body INTO the snapshot so
    //     projections are recoverable from the commit alone. The bytes are
    //     key-sorted and snapshotId-free, so they are deterministic. ---------
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

    // --- Phase 3: publish projections DERIVED from the committed snapshot.
    //     These are idempotently re-derivable from the commit (repair path), so
    //     a failure here does not lose the published app. ---------------------
    yield* publishProjections(deps, descriptor, assembled.blobs);

    return { snapshotId: meta.id, descriptor };
  });

/** Write the projections derived from a committed descriptor: the content-
 *  addressed ui/skill blobs, then the published-descriptor pointer. Idempotent
 *  (blobs are content-addressed; the pointer is a keyed upsert), so it doubles
 *  as the repair path (recompute-on-read of a snapshot whose projections were
 *  lost between commit and pointer write). */
export const publishProjections = (
  deps: Pick<PublishDeps, "putBlob">,
  descriptor: AppDescriptor,
  blobs: readonly StagedBlob[],
): Effect.Effect<void, PublishError> =>
  Effect.forEach(blobs, (b) => deps.putBlob(b.key, b.value), { discard: true }).pipe(
    Effect.map(() => void descriptor),
  );

/** Recover a descriptor from a committed snapshot alone (repair / recompute-on-
 *  read). Reads `.executor/descriptor.json` from the snapshot and stamps the
 *  snapshotId from the commit it was read from. Returns null if the snapshot has
 *  no descriptor (a snapshot committed before this format, or not an app). */
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

/** Re-stage the ui/skill blobs a descriptor references, by re-reading the
 *  snapshot's source and re-bundling/re-hashing. Used by the repair path when a
 *  descriptor pointer exists but its projections (blobs) went missing. */
export const restageBlobs = (
  deps: Pick<PublishDeps, "artifactStore">,
  descriptor: AppDescriptor,
): Effect.Effect<readonly StagedBlob[], PublishError> =>
  Effect.gen(function* () {
    const scopeStore = yield* deps.artifactStore
      .forScope(descriptor.scope)
      .pipe(
        Effect.mapError(
          (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
        ),
      );
    const files = yield* scopeStore
      .read(descriptor.snapshotId as SnapshotId)
      .pipe(
        Effect.mapError(
          (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
        ),
      );
    const blobs: StagedBlob[] = [];
    for (const uiDesc of descriptor.ui) {
      const bundle = yield* bundleEntry({ files, entry: uiDesc.sourcePath }).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "bundle",
              diagnostics: [{ path: uiDesc.sourcePath, message: c.message }],
            }),
        ),
      );
      blobs.push({ key: `ui/${uiDesc.bundleHash}`, value: bundle.code });
    }
    for (const skillDesc of descriptor.skills) {
      const body = files.get(skillDesc.sourcePath) ?? "";
      blobs.push({ key: `skill/${skillDesc.bodyHash}`, value: body });
    }
    return blobs;
  });
