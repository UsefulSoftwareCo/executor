export type FixtureFile = string | { readonly bytes: number } | { readonly link: string };

export type Fixture = {
  readonly name: string;
  readonly files: Readonly<Record<string, FixtureFile>>;
} & ({ readonly published: ReadonlyArray<string> } | { readonly refused: string });

const skill = (body: string) => `---\nname: guide\ndescription: A fixture skill.\n---\n\n${body}\n`;

const linking = (name: string, body: string, outcome: { readonly refused: string } | "published") =>
  ({
    name,
    files: {
      "skills/app-authoring/SKILL.md": skill(body),
      "skills/app-authoring/storage.md": "Storage.",
      "skills/app-authoring/upgrades/guide.md": "An upgrade guide.",
      "skills/code-mode/SKILL.md": skill("Code mode."),
    },
    ...(outcome === "published"
      ? {
          published: [
            "skills/app-authoring/SKILL.md",
            "skills/app-authoring/storage.md",
            "skills/app-authoring/upgrades/guide.md",
            "skills/code-mode/SKILL.md",
          ],
        }
      : outcome),
  }) satisfies Fixture;

export const fixtures: ReadonlyArray<Fixture> = [
  linking("nested guide", "Read [the guide](upgrades/guide.md).", "published"),
  linking("link with a fragment and a query", "[x](./storage.md?view=1#keys)", "published"),
  linking("link in angle brackets", "[x](<storage.md>)", "published"),
  linking("titled link", '[x](upgrades/guide.md "Upgrade")', "published"),
  linking("reference link", "[x][guide]\n\n[guide]: upgrades/guide.md", "published"),
  linking(
    "external link",
    "[x](https://executor.sh/missing.md) and <https://example.com>",
    "published",
  ),
  linking("links in code", "`[x](missing.md)`\n\n```md\n[x](missing.md)\n```", "published"),
  linking("missing file", "[x](missing.md)", {
    refused: "app-authoring/SKILL.md links missing.md",
  }),
  linking("missing titled link", '[x](missing.md "Guide")', {
    refused: "app-authoring/SKILL.md links missing.md",
  }),
  linking("missing reference link", "[x][ref]\n\n[ref]: missing.md", {
    refused: "app-authoring/SKILL.md links missing.md",
  }),
  linking("missing file in angle brackets", "[x](<missing guide.md>)", {
    refused: "app-authoring/SKILL.md links missing guide.md",
  }),
  linking("missing image", "![x](diagram.png)", {
    refused: "app-authoring/SKILL.md links diagram.png",
  }),
  linking("another skill's file", "[x](../code-mode/SKILL.md)", {
    refused: "app-authoring/SKILL.md links ../code-mode/SKILL.md",
  }),
  {
    name: "dotfiles and dot directories",
    files: {
      "skills/app-authoring/SKILL.md": skill("Guide."),
      "skills/app-authoring/.notes.md": "Editor state.",
      "skills/app-authoring/.cache/page.md": "Tool state.",
      "skills/.drafts/SKILL.md": skill("Draft."),
    },
    published: ["skills/app-authoring/SKILL.md"],
  },
  {
    name: "file beside the skills",
    files: { "skills/README.md": "Not a skill.", "skills/app-authoring/SKILL.md": skill("Guide.") },
    published: ["skills/app-authoring/SKILL.md"],
  },
  {
    name: "file linked from outside the skills",
    files: {
      "outside.md": "Anything on the machine.",
      "skills/app-authoring/SKILL.md": skill("Guide."),
      "skills/app-authoring/outside.md": { link: "outside.md" },
    },
    refused: "app-authoring/outside.md is a symbolic link",
  },
  {
    name: "directory linked from outside the skills",
    files: {
      "elsewhere/outside.md": "Anything on the machine.",
      "skills/app-authoring/SKILL.md": skill("Guide."),
      "skills/app-authoring/linked": { link: "elsewhere" },
    },
    refused: "app-authoring/linked is a symbolic link",
  },
  {
    name: "file linked within the skill",
    files: {
      "skills/app-authoring/SKILL.md": skill("Guide."),
      "skills/app-authoring/copy.md": { link: "skills/app-authoring/SKILL.md" },
    },
    refused: "app-authoring/copy.md is a symbolic link",
  },
  {
    name: "skill directory linked",
    files: {
      "elsewhere/SKILL.md": skill("Guide."),
      "skills/app-authoring": { link: "elsewhere" },
    },
    refused: "app-authoring is a symbolic link",
  },
  {
    name: "file at the size limit",
    files: { "skills/app-authoring/SKILL.md": { bytes: 256 * 1024 } },
    published: ["skills/app-authoring/SKILL.md"],
  },
  {
    name: "file over the size limit",
    files: { "skills/app-authoring/SKILL.md": { bytes: 256 * 1024 + 1 } },
    refused: "app-authoring/SKILL.md is 262145 bytes; each file may be at most 262144",
  },
  {
    name: "too many files",
    files: Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`skills/app-authoring/page-${index}.md`, "Page."]),
    ),
    refused: "have 101 files; they may have at most 100",
  },
];
