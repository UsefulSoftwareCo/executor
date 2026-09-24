import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import { makeTestExecutor } from "./testing";

const encoder = new TextEncoder();

const packageFiles = (description = "Extract text from PDFs.") => [
  {
    path: "SKILL.md",
    bytes: encoder.encode(
      `---\nname: pdf-processing\ndescription: ${description}\n---\n\n# PDF processing\n`,
    ),
  },
  { path: "assets/icon.bin", bytes: Uint8Array.from([0, 255, 4, 8]) },
];

describe("executor.skills", () => {
  it.effect("uses frontmatter as the initial invocation preference", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const files = [
        {
          path: "SKILL.md",
          bytes: encoder.encode(
            "---\nname: user-invoked\ndescription: Run only when named.\ndisable-model-invocation: true\n---\n\n# User invoked\n",
          ),
        },
      ];

      const manual = yield* executor.skills.create({
        owner: "user",
        package: { files },
      });
      expect(manual.delivery).toEqual({ kind: "enabled", invocation: "manual" });

      const overridden = yield* executor.skills.create({
        owner: "user",
        package: {
          files: files.map((file) => ({
            ...file,
            bytes: encoder.encode(
              "---\nname: user-invoked-override\ndescription: Run only when named.\ndisable-model-invocation: true\n---\n\n# User invoked\n",
            ),
          })),
        },
        delivery: { kind: "enabled", invocation: "model" },
      });
      expect(overridden.delivery).toEqual({ kind: "enabled", invocation: "model" });
    }),
  );

  it.effect("creates an immutable revision and keeps package bytes out of list results", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const created = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });

      expect(created.id).toMatch(/^skl_/);
      expect(created.name).toBe("pdf-processing");
      expect(created.delivery).toEqual({ kind: "enabled", invocation: "model" });
      expect(created.revisions).toHaveLength(1);

      const listed = yield* executor.skills.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty("files");
      expect(listed[0]?.activeRevisionId).toBe(created.activeRevisionId);

      const file = yield* executor.skills.readFile({
        skillId: created.id,
        path: "assets/icon.bin",
      });
      expect(file.bytes).toEqual(Uint8Array.from([0, 255, 4, 8]));
    }),
  );

  it.effect("stages trusted source bytes and imports them as an immutable managed copy", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const candidate = yield* executor.skills.stageCandidate({
        owner: "user",
        package: { files: packageFiles() },
        source: {
          locator: {
            kind: "github",
            repository: "executor-js/example-skills",
            directory: "skills/pdf-processing",
            requestedRef: "main",
            resolvedCommit: "0123456789abcdef",
          },
          tracking: {
            kind: "tracked",
            symbolicReference: "main",
            resolvedRevision: "0123456789abcdef",
          },
        },
      });

      expect(candidate.id).toMatch(/^skc_/);
      expect(candidate.revision.name).toBe("pdf-processing");
      expect(candidate.expiresAt.getTime() - candidate.createdAt.getTime()).toBe(30 * 60 * 1000);

      const imported = yield* executor.skills.importCandidate({ candidateId: candidate.id });
      expect(imported.source).toEqual({
        kind: "imported",
        locator: candidate.source.locator,
        tracking: candidate.source.tracking,
        baselineRevisionId: imported.activeRevisionId,
      });
      expect(imported.delivery).toEqual({ kind: "enabled", invocation: "model" });

      const pinned = yield* executor.skills.setSource({
        skillId: imported.id,
        change: {
          kind: "setTracking",
          tracking: { kind: "pinned", upstreamRevision: "0123456789abcdef" },
        },
      });
      expect(pinned.source).toMatchObject({
        kind: "imported",
        tracking: { kind: "pinned", upstreamRevision: "0123456789abcdef" },
      });
      const detached = yield* executor.skills.setSource({
        skillId: imported.id,
        change: { kind: "detach" },
      });
      expect(detached.source).toEqual({ kind: "authored" });

      const binary = yield* executor.skills.readFile({
        skillId: imported.id,
        path: "assets/icon.bin",
      });
      expect(binary.bytes).toEqual(Uint8Array.from([0, 255, 4, 8]));

      const secondImport = yield* executor.skills
        .importCandidate({ candidateId: candidate.id })
        .pipe(Effect.result);
      expect(Result.isFailure(secondImport)).toBe(true);
      expect(
        Result.isFailure(secondImport) &&
          Predicate.isTagged("SkillCandidateNotFoundError")(secondImport.failure),
      ).toBe(true);
    }),
  );

  it.effect("edits with a revision precondition and preserves history", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const created = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });
      const edited = yield* executor.skills.edit({
        skillId: created.id,
        expectedActiveRevisionId: created.activeRevisionId,
        package: { files: packageFiles("Extract tables from PDFs.") },
      });

      expect(edited.id).toBe(created.id);
      expect(edited.activeRevisionId).not.toBe(created.activeRevisionId);
      expect(edited.revisions).toHaveLength(2);
      expect(edited.description).toBe("Extract tables from PDFs.");

      const stale = yield* executor.skills
        .edit({
          skillId: created.id,
          expectedActiveRevisionId: created.activeRevisionId,
          package: { files: packageFiles("A stale edit.") },
        })
        .pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      if (Result.isSuccess(stale)) return;
      expect(Predicate.isTagged("SkillRevisionConflictError")(stale.failure)).toBe(true);
    }),
  );

  it.effect("moves a skill to another owner while preserving its identity and history", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const created = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });
      const editInput = {
        skillId: created.id,
        owner: "org" as const,
        expectedActiveRevisionId: created.activeRevisionId,
        package: { files: packageFiles("Extract tables from PDFs.") },
      };

      const moved = yield* executor.skills.edit(editInput);

      expect(moved.id).toBe(created.id);
      expect(moved.owner).toBe("org");
      expect(moved.revisions).toHaveLength(2);
      const originalAsset = yield* executor.skills.readFile({
        skillId: moved.id,
        revisionId: created.activeRevisionId,
        path: "assets/icon.bin",
      });
      expect(originalAsset.bytes).toEqual(Uint8Array.from([0, 255, 4, 8]));
    }),
  );

  it.effect("refuses to move a skill onto an existing name in the target owner", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const personal = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });
      const workspace = yield* executor.skills.create({
        owner: "org",
        package: { files: packageFiles("Workspace copy.") },
      });

      const result = yield* executor.skills
        .edit({
          skillId: personal.id,
          owner: "org",
          expectedActiveRevisionId: personal.activeRevisionId,
          package: { files: packageFiles("Move this copy.") },
        })
        .pipe(Effect.result);

      expect(
        Result.isFailure(result) && Predicate.isTagged("SkillNameConflictError")(result.failure),
      ).toBe(true);
      expect((yield* executor.skills.get({ skillId: personal.id })).owner).toBe("user");
      expect((yield* executor.skills.get({ skillId: workspace.id })).description).toBe(
        "Workspace copy.",
      );
    }),
  );

  it.effect("reviews source updates against the baseline and requires conflict choices", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const source = {
        locator: {
          kind: "github" as const,
          repository: "executor-js/example-skills",
          directory: "skills/pdf-processing",
          requestedRef: "main",
          resolvedCommit: "commit-one",
        },
        tracking: {
          kind: "tracked" as const,
          symbolicReference: "main",
          resolvedRevision: "commit-one",
        },
      };
      const initial = yield* executor.skills.stageCandidate({
        owner: "user",
        package: { files: packageFiles() },
        source,
      });
      const imported = yield* executor.skills.importCandidate({ candidateId: initial.id });
      const edited = yield* executor.skills.edit({
        skillId: imported.id,
        expectedActiveRevisionId: imported.activeRevisionId,
        package: { files: packageFiles("Keep my local description.") },
      });
      const candidate = yield* executor.skills.stageCandidate({
        owner: "user",
        package: {
          files: [
            ...packageFiles("Use the upstream description.").slice(0, 1),
            { path: "assets/icon.bin", bytes: Uint8Array.from([9, 8, 7]) },
          ],
        },
        source: {
          locator: { ...source.locator, resolvedCommit: "commit-two" },
          tracking: { ...source.tracking, resolvedRevision: "commit-two" },
        },
      });
      const review = yield* executor.skills.reviewCandidate({
        skillId: imported.id,
        candidateId: candidate.id,
      });
      expect(review.conflicts).toEqual(["SKILL.md"]);
      expect(review.changes.map((change) => change.path)).toEqual(["SKILL.md", "assets/icon.bin"]);

      const unresolved = yield* executor.skills
        .applyCandidate({
          skillId: imported.id,
          candidateId: candidate.id,
          expectedActiveRevisionId: edited.activeRevisionId,
          expectedBaselineRevisionId: imported.activeRevisionId,
          resolutions: [],
        })
        .pipe(Effect.result);
      expect(
        Result.isFailure(unresolved) &&
          Predicate.isTagged("SkillUpdateConflictError")(unresolved.failure),
      ).toBe(true);

      const applied = yield* executor.skills.applyCandidate({
        skillId: imported.id,
        candidateId: candidate.id,
        expectedActiveRevisionId: edited.activeRevisionId,
        expectedBaselineRevisionId: imported.activeRevisionId,
        resolutions: [{ path: "SKILL.md", choice: "local" }],
      });
      expect(applied.description).toBe("Keep my local description.");
      expect(applied.source).toMatchObject({
        kind: "imported",
        locator: { kind: "github", resolvedCommit: "commit-two" },
      });
      const asset = yield* executor.skills.readFile({
        skillId: applied.id,
        path: "assets/icon.bin",
      });
      expect(asset.bytes).toEqual(Uint8Array.from([9, 8, 7]));
    }),
  );

  it.effect("stores safe nonportable content as blocked and lets an edit repair it", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const blocked = yield* executor.skills.create({
        owner: "user",
        package: {
          files: [{ path: "SKILL.md", bytes: encoder.encode("---\nname: [\n---\nbody") }],
        },
      });
      expect(blocked.delivery.kind).toBe("blocked");
      expect(blocked.name).toBeNull();

      const repaired = yield* executor.skills.edit({
        skillId: blocked.id,
        expectedActiveRevisionId: blocked.activeRevisionId,
        package: { files: packageFiles() },
      });
      expect(repaired.delivery).toEqual({ kind: "enabled", invocation: "model" });
      expect(repaired.name).toBe("pdf-processing");
    }),
  );

  it.effect("restores by creating a new revision and removes the aggregate", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const created = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });
      const edited = yield* executor.skills.edit({
        skillId: created.id,
        expectedActiveRevisionId: created.activeRevisionId,
        package: { files: packageFiles("Extract tables from PDFs.") },
      });
      const restored = yield* executor.skills.restoreRevision({
        skillId: created.id,
        expectedActiveRevisionId: edited.activeRevisionId,
        revisionId: created.activeRevisionId,
      });

      expect(restored.activeRevisionId).not.toBe(created.activeRevisionId);
      expect(restored.revisions).toHaveLength(3);
      expect(restored.description).toBe("Extract text from PDFs.");

      yield* executor.skills.remove({ skillId: created.id });
      expect(yield* executor.skills.list()).toEqual([]);
    }),
  );

  it.effect("changes delivery explicitly and refuses to enable a blocked revision", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const created = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });
      const disabled = yield* executor.skills.setDelivery({
        skillId: created.id,
        delivery: { kind: "disabled" },
      });
      expect(disabled.delivery).toEqual({ kind: "disabled" });
      const modelEnabled = yield* executor.skills.setDelivery({
        skillId: created.id,
        delivery: { kind: "enabled", invocation: "model" },
      });
      expect(modelEnabled.delivery).toEqual({ kind: "enabled", invocation: "model" });

      const blocked = yield* executor.skills.create({
        owner: "user",
        package: {
          files: [{ path: "SKILL.md", bytes: encoder.encode("---\nname: [\n---\nbody") }],
        },
      });
      const result = yield* executor.skills
        .setDelivery({
          skillId: blocked.id,
          delivery: { kind: "enabled", invocation: "manual" },
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.isTagged("SkillInvalidTransitionError")(result.failure)).toBe(true);
    }),
  );

  it.effect("derives requirement status without provisioning dependencies", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.skills.create({
        owner: "user",
        package: {
          files: [
            {
              path: "SKILL.md",
              bytes: encoder.encode(
                "---\nname: helper-skill\ndescription: A helper skill.\n---\nBody",
              ),
            },
          ],
        },
      });
      const requiring = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
        requirements: [
          { kind: "skill", name: "helper-skill", owner: null },
          { kind: "runtime", command: "pdftotext", version: null },
          { kind: "integration", integration: "missing-api", toolPatterns: [] },
        ],
      });
      const detail = yield* executor.skills.get({ skillId: requiring.id });
      expect(detail.requirementStatuses.map(({ status }) => status)).toEqual([
        "satisfied",
        "unknown",
        "missing",
      ]);
      expect(yield* executor.integrations.list()).toEqual([]);
    }),
  );

  it.effect("exports valid packages portably and blocked packages only as managed backups", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const valid = yield* executor.skills.create({
        owner: "user",
        package: { files: packageFiles() },
      });
      const portable = yield* executor.skills.export({ skillId: valid.id, kind: "portable" });
      expect(portable.kind).toBe("portable");
      expect(portable.files.find(({ path }) => path === "assets/icon.bin")?.bytes).toEqual(
        Uint8Array.from([0, 255, 4, 8]),
      );

      const blocked = yield* executor.skills.create({
        owner: "user",
        package: {
          files: [{ path: "SKILL.md", bytes: encoder.encode("---\nname: [\n---\nbody") }],
        },
      });
      const rejected = yield* executor.skills
        .export({ skillId: blocked.id, kind: "portable" })
        .pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isSuccess(rejected)) return;
      expect(Predicate.isTagged("PortableSkillExportRejectedError")(rejected.failure)).toBe(true);

      const backup = yield* executor.skills.export({ skillId: blocked.id, kind: "backup" });
      expect(backup.kind).toBe("backup");
      if (backup.kind !== "backup") return;
      expect(backup.skill.id).toBe(blocked.id);
      expect(backup.files).toHaveLength(1);
    }),
  );
});
