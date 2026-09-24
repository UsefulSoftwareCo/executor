import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ManagedSkillId, SkillPackageDigest } from "@executor-js/sdk/shared";

import { materializeSkills } from "./skill-materializer";

const bytes = new TextEncoder().encode("managed contents\n");
const fileDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const skill = {
  id: ManagedSkillId.make("skl_test"),
  owner: "user" as const,
  name: "safe-skill",
  revisionDigest: SkillPackageDigest.make("sha256:package"),
  files: [{ path: "SKILL.md", digest: fileDigest, bytes }],
};

describe("skill materializer", () => {
  it("preserves drift unless forced and keeps unknown files", async () => {
    const root = await mkdtemp(join(tmpdir(), "executor-skills-"));
    try {
      const first = await materializeSkills({
        root,
        origin: "https://executor.example",
        skills: [skill],
        force: false,
      });
      expect(first.added).toBe(1);
      const directory = join(root, skill.name);
      await writeFile(join(directory, "SKILL.md"), "local edit\n");
      await writeFile(join(directory, "notes.txt"), "keep me\n");

      const skipped = await materializeSkills({
        root,
        origin: "https://executor.example",
        skills: [skill],
        force: false,
      });
      expect(skipped.skipped).toEqual(["safe-skill has local changes: SKILL.md"]);
      expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("local edit\n");

      const forced = await materializeSkills({
        root,
        origin: "https://executor.example",
        skills: [skill],
        force: true,
      });
      expect(forced.updated).toBe(1);
      expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("managed contents\n");
      expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("keep me\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only unchanged generated files when a skill is no longer enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "executor-skills-"));
    try {
      await materializeSkills({
        root,
        origin: "https://executor.example",
        skills: [skill],
        force: false,
      });
      const directory = join(root, skill.name);
      await writeFile(join(directory, "notes.txt"), "keep me\n");
      const removed = await materializeSkills({
        root,
        origin: "https://executor.example",
        skills: [],
        force: false,
      });
      expect(removed.removed).toBe(1);
      expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("keep me\n");
      await expect(readFile(join(directory, "SKILL.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
