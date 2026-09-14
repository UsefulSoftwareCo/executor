// Cross-target: Agent Skills, end to end.
//
// A user saves a SKILL.md directory to their workspace through the console's
// API. The product promise under test is that every agent connected over MCP
// sees it next — in the `skills` tool's description (the catalog), in its index,
// and as loadable instructions with the bundled files reachable one at a time.
// Delete it, and the agent stops seeing it. The console and the agent share one
// store, not two caches.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { SkillName } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([] as const);

/** Selfhost shares one workspace across scenarios, so every name is unique to
 *  this run and assertions look for "mine", never "the only one". */
const uniqueSuffix = () => randomBytes(4).toString("hex");

const skillMarkdown = (name: string, marker: string) =>
  [
    "---",
    `name: ${name}`,
    `description: Release-notes house style. Use when drafting release notes (${marker}).`,
    "metadata:",
    '  version: "1.0"',
    "---",
    "",
    "# Release notes",
    "",
    `Lead with the user-visible change. Marker: ${marker}.`,
    "See `references/tone.md` for the voice.",
  ].join("\n");

scenario(
  "Skills · a skill saved to the workspace is what a connected agent loads next",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const session = mcp.session(identity);

    const suffix = uniqueSuffix();
    const name = SkillName.make(`release-notes-${suffix}`);
    const marker = `skill-ok-${suffix}`;
    const toneMarker = `tone-ok-${suffix}`;

    yield* Effect.gen(function* () {
      // Save through the same endpoint the console's editor uses.
      const saved = yield* client.skills.save({
        payload: {
          owner: "user",
          files: [
            { path: "SKILL.md", content: skillMarkdown(name, marker) },
            { path: "references/tone.md", content: `# Tone\n\nPlain and direct. ${toneMarker}` },
          ],
        },
      });
      expect(saved.name, "the name comes from the frontmatter").toBe(name);
      expect(
        saved.files.map((file) => file.path),
        "SKILL.md leads the stored manifest",
      ).toEqual(["SKILL.md", "references/tone.md"]);
      for (const file of saved.files) {
        expect(file.digest, `${file.path} carries a sha256 digest`).toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
      }

      // A fresh MCP session sees the skill in the tool's own description — the
      // catalog a model reads before it asks for anything.
      const tools = yield* session.describeTools();
      const skillsTool = tools.find((tool) => tool.name === "skills");
      expect(skillsTool?.description, "the skills tool advertises the saved skill").toContain(
        `\`${name}\``,
      );

      const index = yield* session.call("skills", {});
      expect(index.text, "the index lists the saved skill next to Executor's docs").toContain(
        `\`${name}\``,
      );
      expect(index.text).toContain("`execute`");

      const loaded = yield* session.call("skills", { name });
      expect(loaded.ok, `loading the skill succeeds: ${loaded.text}`).toBe(true);
      expect(loaded.text, "the body is served with its frontmatter stripped").toContain(
        `Marker: ${marker}`,
      );
      expect(loaded.text).not.toContain("description: Release-notes");
      expect(loaded.text, "bundled files are listed, not inlined").toContain(
        "<file>references/tone.md</file>",
      );
      expect(loaded.text).not.toContain(toneMarker);

      const tone = yield* session.call("skills", { name, file: "references/tone.md" });
      expect(tone.ok, `reading a bundled file succeeds: ${tone.text}`).toBe(true);
      expect(tone.text, "the bundled file's content is returned verbatim").toContain(toneMarker);

      // Delete in the console; the agent's next call misses.
      yield* client.skills.remove({ params: { owner: "user", name } });
      const gone = yield* session.call("skills", { name });
      expect(gone.ok, "a removed skill no longer loads").toBe(false);
      expect(gone.text).toContain(`No skill named "${name}"`);
    }).pipe(
      Effect.ensuring(
        client.skills.remove({ params: { owner: "user", name } }).pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "Skills · a malformed SKILL.md is refused with the reason",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);

    const result = yield* client.skills
      .save({
        payload: {
          owner: "user",
          files: [{ path: "SKILL.md", content: "---\nname: Not Valid\ndescription: x\n---\n" }],
        },
      })
      .pipe(Effect.result);
    expect(result._tag, "the save is refused").toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(String(result.failure._tag), "as an invalid-skill error").toBe("InvalidSkillError");
  }),
);
