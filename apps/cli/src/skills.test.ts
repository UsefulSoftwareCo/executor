import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  formatSkillPullSummaryLine,
  formatSkillsTable,
  parseSkillMarker,
  planSkillsPull,
  readExistingSkillEntries,
  removeSkillDirectory,
  resolveEffectiveSkills,
  serializeSkillMarker,
  skillMarkerFor,
  summarizeSkillPullActions,
  writeSkillDirectory,
  SKILL_MARKER_FILENAME,
  type SkillDetail,
  type SkillSummary,
} from "./skills";

const withTmp = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "exec-skills-"))),
    body,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

const ORIGIN = "https://example.executor.sh";

const summary = (
  input: Partial<SkillSummary> & { owner: "org" | "user"; name: string },
): SkillSummary => ({
  description: "A test skill.",
  files: [{ path: "SKILL.md", size: 10, digest: "sha256:aaa" }],
  updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
  ...input,
});

describe("resolveEffectiveSkills", () => {
  it("keeps a single skill unaffected", () => {
    const skills = [summary({ owner: "org", name: "docs" })];
    expect(resolveEffectiveSkills(skills)).toEqual(skills);
  });

  it("prefers the user copy over an org copy of the same name", () => {
    const org = summary({ owner: "org", name: "docs", description: "org copy" });
    const user = summary({ owner: "user", name: "docs", description: "user copy" });
    expect(resolveEffectiveSkills([org, user])).toEqual([user]);
    // Order shouldn't matter.
    expect(resolveEffectiveSkills([user, org])).toEqual([user]);
  });

  it("keeps distinct names separate", () => {
    const a = summary({ owner: "org", name: "docs" });
    const b = summary({ owner: "user", name: "release-notes" });
    expect(resolveEffectiveSkills([a, b])).toEqual([a, b]);
  });
});

describe("formatSkillsTable", () => {
  it("reports an empty table", () => {
    expect(formatSkillsTable([])).toEqual(["No skills found."]);
  });

  it("includes a header and one row per skill", () => {
    const lines = formatSkillsTable([summary({ owner: "org", name: "docs" })]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("OWNER");
    expect(lines[1]).toContain("org");
    expect(lines[1]).toContain("docs");
  });
});

describe("skill markers", () => {
  it("round-trips through serialize/parse", () => {
    const marker = skillMarkerFor({
      origin: ORIGIN,
      skill: { owner: "user", name: "docs" },
      files: [{ path: "SKILL.md", size: 10, digest: "sha256:aaa" }],
    });
    const parsed = parseSkillMarker(serializeSkillMarker(marker));
    expect(parsed).toEqual(marker);
  });

  it("rejects malformed JSON", () => {
    expect(parseSkillMarker("not json")).toBeUndefined();
  });

  it("rejects an object missing required fields", () => {
    expect(parseSkillMarker(JSON.stringify({ origin: ORIGIN }))).toBeUndefined();
  });

  it("rejects an invalid owner", () => {
    expect(
      parseSkillMarker(
        JSON.stringify({ origin: ORIGIN, owner: "nobody", name: "docs", digests: {} }),
      ),
    ).toBeUndefined();
  });

  it("rejects non-string digest values", () => {
    expect(
      parseSkillMarker(
        JSON.stringify({ origin: ORIGIN, owner: "user", name: "docs", digests: { "SKILL.md": 1 } }),
      ),
    ).toBeUndefined();
  });
});

describe("planSkillsPull", () => {
  it("adds a skill with no existing directory", () => {
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [summary({ owner: "org", name: "docs" })],
      existing: [],
    });
    expect(actions).toEqual([{ name: "docs", kind: "add" }]);
  });

  it("marks a matching-digest skill unchanged", () => {
    const skill = summary({ owner: "org", name: "docs" });
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [skill],
      existing: [
        {
          name: "docs",
          marker: skillMarkerFor({ origin: ORIGIN, skill, files: skill.files }),
        },
      ],
    });
    expect(actions).toEqual([{ name: "docs", kind: "unchanged" }]);
  });

  it("updates a skill whose digests changed", () => {
    const skill = summary({ owner: "org", name: "docs" });
    const staleMarker = skillMarkerFor({
      origin: ORIGIN,
      skill,
      files: [{ path: "SKILL.md", size: 5, digest: "sha256:old" }],
    });
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [skill],
      existing: [{ name: "docs", marker: staleMarker }],
    });
    expect(actions).toEqual([{ name: "docs", kind: "update" }]);
  });

  it("never overwrites a directory with no marker", () => {
    const skill = summary({ owner: "org", name: "docs" });
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [skill],
      existing: [{ name: "docs", marker: undefined }],
    });
    expect(actions).toEqual([
      { name: "docs", kind: "skip", reason: expect.stringContaining(SKILL_MARKER_FILENAME) },
    ]);
  });

  it("skips a directory owned by a different server", () => {
    const skill = summary({ owner: "org", name: "docs" });
    const otherOriginMarker = skillMarkerFor({
      origin: "https://other.example",
      skill,
      files: skill.files,
    });
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [skill],
      existing: [{ name: "docs", marker: otherOriginMarker }],
    });
    expect(actions).toEqual([
      { name: "docs", kind: "skip", reason: expect.stringContaining("different server") },
    ]);
  });

  it("removes a marker-bearing directory whose skill no longer exists upstream", () => {
    const marker = skillMarkerFor({
      origin: ORIGIN,
      skill: { owner: "org", name: "gone" },
      files: [{ path: "SKILL.md", size: 1, digest: "sha256:x" }],
    });
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [],
      existing: [{ name: "gone", marker }],
    });
    expect(actions).toEqual([{ name: "gone", kind: "remove", reason: expect.any(String) }]);
  });

  it("never removes an unmanaged directory that has no matching upstream skill", () => {
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [],
      existing: [{ name: "my-notes", marker: undefined }],
    });
    expect(actions).toEqual([]);
  });

  it("never removes a directory owned by a different server", () => {
    const marker = skillMarkerFor({
      origin: "https://other.example",
      skill: { owner: "org", name: "gone" },
      files: [],
    });
    const actions = planSkillsPull({
      origin: ORIGIN,
      skills: [],
      existing: [{ name: "gone", marker }],
    });
    expect(actions).toEqual([]);
  });
});

describe("summarizeSkillPullActions / formatSkillPullSummaryLine", () => {
  it("counts each action kind", () => {
    const totals = summarizeSkillPullActions([
      { name: "a", kind: "add" },
      { name: "b", kind: "update" },
      { name: "c", kind: "unchanged" },
      { name: "d", kind: "remove" },
      { name: "e", kind: "skip" },
      { name: "f", kind: "add" },
    ]);
    expect(totals).toEqual({ added: 2, updated: 1, unchanged: 1, removed: 1, skipped: 1 });
    expect(formatSkillPullSummaryLine(totals)).toBe(
      "2 added, 1 updated, 1 removed, 1 skipped (1 unchanged)",
    );
  });

  it("omits the unchanged suffix when there are none", () => {
    const totals = summarizeSkillPullActions([{ name: "a", kind: "add" }]);
    expect(formatSkillPullSummaryLine(totals)).toBe("1 added, 0 updated, 0 removed, 0 skipped");
  });
});

describe("filesystem I/O", () => {
  it.effect("readExistingSkillEntries returns [] for a missing root", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const entries = yield* readExistingSkillEntries(join(dir, "does-not-exist"));
        expect(entries).toEqual([]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("readExistingSkillEntries reports marker and unmarked directories", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const managed = join(dir, "docs");
        mkdirSync(managed, { recursive: true });
        const marker = skillMarkerFor({
          origin: ORIGIN,
          skill: { owner: "org", name: "docs" },
          files: [{ path: "SKILL.md", size: 3, digest: "sha256:aaa" }],
        });
        writeFileSync(join(managed, SKILL_MARKER_FILENAME), serializeSkillMarker(marker));

        const unmanaged = join(dir, "my-notes");
        mkdirSync(unmanaged, { recursive: true });

        // A plain file at the root must not be mistaken for a skill directory.
        writeFileSync(join(dir, "readme.txt"), "hi");

        const entries = yield* readExistingSkillEntries(dir);
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        expect(byName.size).toBe(2);
        expect(byName.get("docs")?.marker).toEqual(marker);
        expect(byName.get("my-notes")?.marker).toBeUndefined();
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("writeSkillDirectory writes nested files and a marker", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const detail: SkillDetail = {
          owner: "user",
          name: "docs",
          description: "A test skill.",
          updatedAt: Date.now(),
          files: [
            { path: "SKILL.md", size: 5, digest: "sha256:aaa", content: "# Docs" },
            {
              path: "references/guide.md",
              size: 6,
              digest: "sha256:bbb",
              content: "Guide.",
            },
          ],
        };
        yield* writeSkillDirectory({ root: dir, origin: ORIGIN, skill: detail });

        const entries = yield* readExistingSkillEntries(dir);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.marker?.origin).toBe(ORIGIN);
        expect(entries[0]?.marker?.digests).toEqual({
          "SKILL.md": "sha256:aaa",
          "references/guide.md": "sha256:bbb",
        });
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("removeSkillDirectory deletes the directory recursively", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const target = join(dir, "docs", "references");
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "guide.md"), "Guide.");

        yield* removeSkillDirectory(dir, "docs");

        const entries = yield* readExistingSkillEntries(dir);
        expect(entries).toEqual([]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
