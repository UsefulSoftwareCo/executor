import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  SKILL_MAX_FILE_BYTES,
  defaultSkillInvocation,
  prepareSkillPackage,
  readPreparedSkillFile,
  type SkillPackageFileInput,
} from "./skill-package";

const encoder = new TextEncoder();

const skillMarkdown = (
  frontmatter = "name: pdf-processing\ndescription: Extract text from PDFs.",
) => encoder.encode(`---\n${frontmatter}\n---\n\n# PDF processing\n`);

const validPackage = (): readonly SkillPackageFileInput[] => [
  { path: "SKILL.md", bytes: skillMarkdown() },
  { path: "assets/icon.png", bytes: Uint8Array.from([0, 255, 1, 2]) },
  { path: "scripts/extract.py", bytes: encoder.encode("print('never executed')\n") },
];

describe("prepareSkillPackage", () => {
  it.effect("preserves text and binary bytes in a valid portable package", () =>
    Effect.gen(function* () {
      const result = yield* prepareSkillPackage([...validPackage()].reverse());

      expect(result.kind).toBe("valid");
      if (result.kind !== "valid") return;
      expect(result.revision.name).toBe("pdf-processing");
      expect(result.revision.description).toBe("Extract text from PDFs.");
      expect(result.revision.files.map((file) => file.path)).toEqual([
        "SKILL.md",
        "assets/icon.png",
        "scripts/extract.py",
      ]);
      expect(result.revision.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.digest))).toBe(
        true,
      );
      expect(yield* readPreparedSkillFile(result.revision, "assets/icon.png")).toEqual(
        Uint8Array.from([0, 255, 1, 2]),
      );
    }),
  );

  it.effect("validates the model invocation preference", () =>
    Effect.gen(function* () {
      for (const disabled of [true, false]) {
        const result = yield* prepareSkillPackage([
          {
            path: "SKILL.md",
            bytes: skillMarkdown(
              `name: pdf-processing\ndescription: Extract text from PDFs.\ndisable-model-invocation: ${disabled}`,
            ),
          },
        ]);
        expect(result.kind).toBe("valid");
        if (result.kind !== "valid") continue;
        expect(defaultSkillInvocation(result.revision.frontmatter)).toBe(
          disabled ? "manual" : "model",
        );
      }

      const invalid = yield* prepareSkillPackage([
        {
          path: "SKILL.md",
          bytes: skillMarkdown(
            "name: pdf-processing\ndescription: Extract text from PDFs.\ndisable-model-invocation: sometimes",
          ),
        },
      ]);
      expect(invalid.kind).toBe("blocked");
      if (invalid.kind !== "blocked") return;
      expect(invalid.revision.diagnostics.map(({ code }) => code)).toContain(
        "disable_model_invocation_invalid",
      );
    }),
  );

  it.effect("keeps a safe nonportable package as a blocked revision", () =>
    Effect.gen(function* () {
      const malformed = encoder.encode("---\nname: [\ndescription: nope\n---\nbody");
      const result = yield* prepareSkillPackage([{ path: "SKILL.md", bytes: malformed }]);

      expect(result.kind).toBe("blocked");
      if (result.kind !== "blocked") return;
      expect(result.revision.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "frontmatter_invalid_yaml",
      );
      expect(yield* readPreparedSkillFile(result.revision, "SKILL.md")).toEqual(malformed);
    }),
  );

  it.effect("rejects paths and limits that are unsafe to store", () =>
    Effect.gen(function* () {
      const cases: readonly (readonly SkillPackageFileInput[])[] = [
        [{ path: "../SKILL.md", bytes: skillMarkdown() }],
        [
          { path: "SKILL.md", bytes: skillMarkdown() },
          { path: "SKILL.md", bytes: skillMarkdown() },
        ],
        [{ path: "SKILL.md", bytes: new Uint8Array(SKILL_MAX_FILE_BYTES + 1) }],
      ];

      for (const files of cases) {
        const result = yield* prepareSkillPackage(files);
        expect(result.kind).toBe("rejected");
      }
    }),
  );

  it.effect("blocks paths that collide on common native filesystems", () =>
    Effect.gen(function* () {
      const result = yield* prepareSkillPackage([
        { path: "SKILL.md", bytes: skillMarkdown() },
        { path: "References/API.md", bytes: encoder.encode("one") },
        { path: "references/api.md", bytes: encoder.encode("two") },
      ]);

      expect(result.kind).toBe("blocked");
      if (result.kind !== "blocked") return;
      expect(result.revision.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "path_portability_collision",
      );
    }),
  );
});
