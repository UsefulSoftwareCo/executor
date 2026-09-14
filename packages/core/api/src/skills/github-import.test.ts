import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { parseGitHubSkillSource } from "@executor-js/sdk";

import {
  importSkillsFromGitHub,
  parsedSourceOrError,
  skillDirectoriesInTree,
} from "./github-import";

describe("skillDirectoriesInTree", () => {
  const paths = [
    "README.md",
    "skills/pdf/SKILL.md",
    "skills/pdf/references/forms.md",
    "skills/pdf/nested/SKILL.md",
    "skills/csv/SKILL.md",
    "other/notes.md",
  ];

  it("finds every SKILL.md parent, shallow first", () => {
    expect(skillDirectoriesInTree(paths, "")).toEqual([
      "skills/csv",
      "skills/pdf",
      "skills/pdf/nested",
    ]);
  });

  it("scopes to the requested path", () => {
    expect(skillDirectoriesInTree(paths, "skills/pdf")).toEqual([
      "skills/pdf",
      "skills/pdf/nested",
    ]);
    expect(skillDirectoriesInTree(paths, "other")).toEqual([]);
  });

  it("treats a root SKILL.md as the empty directory", () => {
    expect(skillDirectoriesInTree(["SKILL.md", "ref.md"], "")).toEqual([""]);
  });
});

describe("parsedSourceOrError", () => {
  it("turns an unparseable source into a user-facing error", async () => {
    const result = await Effect.runPromise(Effect.result(parsedSourceOrError(Option.none())));
    expect(Result.isFailure(result)).toBe(true);
  });
});

// A fake GitHub: the repo lookup, one recursive tree, and raw file reads.
const fakeGitHub = (files: Record<string, string>): typeof globalThis.fetch =>
  (async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/skills") {
      return Response.json({ default_branch: "main" });
    }
    if (url.startsWith("https://api.github.com/repos/acme/skills/git/trees/main")) {
      return Response.json({
        sha: "abc",
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          type: "blob",
          size: content.length,
        })),
      });
    }
    const raw = "https://raw.githubusercontent.com/acme/skills/main/";
    if (url.startsWith(raw)) {
      const path = decodeURIComponent(url.slice(raw.length));
      const content = files[path];
      return content === undefined
        ? new Response("not found", { status: 404 })
        : new Response(content, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof globalThis.fetch;

describe("importSkillsFromGitHub", () => {
  const run = (files: Record<string, string>, source: string) =>
    Effect.runPromise(
      Effect.result(
        importSkillsFromGitHub(Option.getOrThrow(parseGitHubSkillSource(source))).pipe(
          // The real layer reads its fetch from this tag, so the fake plugs in
          // beneath it with no other change.
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fakeGitHub(files)),
        ),
      ),
    );

  const valid = [
    "---",
    "name: pdf",
    "description: Extract text from PDFs. Use when the user mentions PDFs.",
    "---",
    "# PDF",
  ].join("\n");

  it("returns validated candidates with their files and reports rejects", async () => {
    const result = await run(
      {
        "README.md": "# repo",
        "skills/pdf/SKILL.md": valid,
        "skills/pdf/references/forms.md": "# Forms",
        "skills/pdf/logo.png": "binary",
        "skills/broken/SKILL.md": "# no frontmatter",
      },
      "acme/skills",
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success.ref).toBe("main");
    expect(result.success.skills.map((s) => s.name)).toEqual(["pdf"]);
    expect(result.success.skills[0]?.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "references/forms.md",
    ]);
    expect(result.success.rejected.map((r) => r.directory)).toEqual(["skills/broken"]);
  });

  it("narrows to the names a pasted `--skill` flag asked for", async () => {
    const files = {
      "skills/pdf/SKILL.md": valid,
      "skills/csv/SKILL.md": valid.replace("name: pdf", "name: csv"),
    };
    const result = await run(files, "npx skills add acme/skills --skill csv");
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success.skills.map((s) => s.name)).toEqual(["csv"]);

    const missing = await run(files, "npx skills add acme/skills --skill nope");
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isSuccess(missing)) return;
    expect(missing.failure.reason).toContain("No skill named `nope`");
  });

  it("fails with a reason when the repo has no skills", async () => {
    const result = await run({ "README.md": "# repo" }, "acme/skills");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure.reason).toContain("No SKILL.md found");
  });
});
