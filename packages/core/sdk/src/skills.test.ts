import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Predicate, Result } from "effect";

import { makeTestExecutor } from "./testing";
import {
  parseSkillMarkdown,
  parseSkillUri,
  prepareSkillFiles,
  skillBody,
  skillFileUri,
} from "./skill";

// The `executor.skills` surface against the real SQLite test db, plus the pure
// SKILL.md validation it is built on. Skills are owner-scoped rows with no
// plugin involvement, so the default test executor (one tenant + one bound
// subject) is the whole fixture.

const SKILL_MD = [
  "---",
  "name: pdf-processing",
  "description: Extract text from PDFs. Use when the user mentions PDFs.",
  "license: Apache-2.0",
  "metadata:",
  "  author: example-org",
  '  version: "1.0"',
  "unknown-field: kept verbatim",
  "---",
  "",
  "# PDF processing",
  "",
  "Run `scripts/extract.py`.",
].join("\n");

const files = (skillMd = SKILL_MD) => [
  { path: "SKILL.md", content: skillMd },
  { path: "scripts/extract.py", content: "print('hi')\n" },
];

describe("parseSkillMarkdown", () => {
  it("splits frontmatter from body and keeps unknown fields", () => {
    const parsed = parseSkillMarkdown(SKILL_MD);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isFailure(parsed)) return;
    expect(parsed.success.name).toBe("pdf-processing");
    expect(parsed.success.description).toBe(
      "Extract text from PDFs. Use when the user mentions PDFs.",
    );
    expect(parsed.success.frontmatter["unknown-field"]).toBe("kept verbatim");
    expect(parsed.success.frontmatter.metadata).toEqual({ author: "example-org", version: "1.0" });
    expect(parsed.success.body.startsWith("# PDF processing")).toBe(true);
  });

  it("accepts an unquoted colon in a scalar value, as lenient clients do", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: pdf\ndescription: Use when: the user asks about PDFs\nmetadata:\n  note: a: b\n---\nBody",
    );
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isFailure(parsed)) return;
    expect(parsed.success.description).toBe("Use when: the user asks about PDFs");
  });

  it.each([
    ["no frontmatter", "# Just markdown"],
    ["unclosed frontmatter", "---\nname: x\ndescription: y\n"],
    ["uppercase name", "---\nname: PDF\ndescription: y\n---\n"],
    ["leading hyphen", "---\nname: -pdf\ndescription: y\n---\n"],
    ["double hyphen", "---\nname: pdf--x\ndescription: y\n---\n"],
    ["missing description", "---\nname: pdf\n---\n"],
    ["reserved name", "---\nname: execute\ndescription: y\n---\n"],
    ["non-string metadata value", "---\nname: pdf\ndescription: y\nmetadata:\n  n: 1\n---\n"],
  ])("rejects %s", (_label, markdown) => {
    expect(Result.isFailure(parseSkillMarkdown(markdown))).toBe(true);
  });
});

describe("prepareSkillFiles", () => {
  it("digests every file and puts SKILL.md first", async () => {
    const prepared = await prepareSkillFiles([...files()].reverse());
    expect(Result.isSuccess(prepared)).toBe(true);
    if (Result.isFailure(prepared)) return;
    expect(prepared.success.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/extract.py"]);
    for (const file of prepared.success.files) {
      expect(file.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(file.size).toBe(new TextEncoder().encode(file.content).byteLength);
    }
  });

  it.each([
    ["a path escaping the skill", [{ path: "../SKILL.md", content: "" }]],
    ["an absolute path", [{ path: "/SKILL.md", content: "" }]],
    ["no SKILL.md", [{ path: "README.md", content: "" }]],
    ["a duplicate path", [...files(), { path: "scripts/extract.py", content: "" }]],
  ])("rejects %s", async (_label, inputs) => {
    expect(Result.isFailure(await prepareSkillFiles(inputs))).toBe(true);
  });
});

describe("skill URIs", () => {
  it("round-trips owner, name, and path", () => {
    const uri = skillFileUri({ owner: "org", name: "pdf-processing" }, "references/FORMS.md");
    expect(uri).toBe("skill://org/pdf-processing/references/FORMS.md");
    expect(parseSkillUri(uri)).toEqual(
      Option.some({ owner: "org", name: "pdf-processing", path: "references/FORMS.md" }),
    );
  });

  it("rejects other schemes, unknown owners, and escaping paths", () => {
    expect(Option.isNone(parseSkillUri("ui://executor/shell.html"))).toBe(true);
    expect(Option.isNone(parseSkillUri("skill://team/pdf/SKILL.md"))).toBe(true);
    expect(Option.isNone(parseSkillUri("skill://org/pdf/../x"))).toBe(true);
  });
});

describe("executor.skills", () => {
  it.effect("list is empty when nothing is saved", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      expect(yield* executor.skills.list()).toEqual([]);
    }),
  );

  it.effect("save stores the directory under the frontmatter name", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.skills.save({ owner: "user", files: files() });
      expect(saved.owner).toBe("user");
      expect(saved.name).toBe("pdf-processing");
      expect(saved.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/extract.py"]);
      expect(skillBody(saved).startsWith("# PDF processing")).toBe(true);

      const fetched = yield* executor.skills.get({ owner: "user", name: "pdf-processing" });
      expect(fetched).toEqual(saved);

      // Lists carry the manifest, never the contents.
      const [summary] = yield* executor.skills.list();
      expect(summary?.files).toEqual(
        saved.files.map(({ path, size, digest }) => ({ path, size, digest })),
      );
      expect(summary?.frontmatter["unknown-field"]).toBe("kept verbatim");
    }),
  );

  it.effect("save replaces an existing skill of the same owner and name in place", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.skills.save({ owner: "user", files: files() });
      const updated = yield* executor.skills.save({
        owner: "user",
        files: [{ path: "SKILL.md", content: SKILL_MD.replace("Extract text", "Extract tables") }],
      });
      expect(updated.description).toContain("Extract tables");
      expect(updated.files).toHaveLength(1);
      expect(yield* executor.skills.list()).toHaveLength(1);
    }),
  );

  it.effect("a personal and a workspace skill may share a name", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.skills.save({ owner: "user", files: files() });
      yield* executor.skills.save({ owner: "org", files: files() });
      const listed = yield* executor.skills.list();
      expect(listed.map((s) => s.owner).sort()).toEqual(["org", "user"]);
    }),
  );

  it.effect("an invalid skill is refused with a reason", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* executor.skills
        .save({ owner: "user", files: [{ path: "SKILL.md", content: "# no frontmatter" }] })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.isTagged("InvalidSkillError")(result.failure)).toBe(true);
    }),
  );

  it.effect("get and remove target one (owner, name)", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.skills.save({ owner: "user", files: files() });
      yield* executor.skills.save({ owner: "org", files: files() });
      yield* executor.skills.remove({ owner: "user", name: "pdf-processing" });
      const remaining = yield* executor.skills.list();
      expect(remaining.map((s) => s.owner)).toEqual(["org"]);
      const missing = yield* executor.skills
        .get({ owner: "user", name: "pdf-processing" })
        .pipe(Effect.result);
      expect(Result.isFailure(missing)).toBe(true);
    }),
  );

  it.effect("org writes are refused when workspace writes are denied", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ orgWrites: "denied" });
      const result = yield* executor.skills
        .save({ owner: "org", files: files() })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.isTagged("OrgWriteDeniedError")(result.failure)).toBe(true);
      // Personal skills are untouched by the workspace gate.
      const personal = yield* executor.skills.save({ owner: "user", files: files() });
      expect(personal.owner).toBe("user");
    }),
  );
});
