import { expect } from "@effect/vitest";
import { Effect, Encoding } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([] as const);

scenario(
  "Managed skills · create, inspect requirements, and opt in to model selection",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const executor = yield* client(api, identity);
    const created = yield* executor.skills.create({
      payload: {
        owner: "user",
        package: {
          files: [
            {
              path: "SKILL.md",
              bytes: Encoding.encodeBase64(
                new TextEncoder().encode(
                  "---\nname: release-notes\ndescription: Draft release notes from merged changes.\ndisable-model-invocation: true\n---\n\n# Release notes\n",
                ),
              ),
            },
            {
              path: "references/style.md",
              bytes: Encoding.encodeBase64(
                new TextEncoder().encode("# Style\n\nLead with the user-visible change."),
              ),
            },
          ],
        },
        requirements: [{ kind: "runtime", command: "git", version: null }],
      },
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const manualSession = mcp.session(identity);
        const manualTools = yield* manualSession.listTools();
        expect(manualTools, "a manual skill has no model-visible activation tool").not.toContain(
          "skill_release_notes",
        );

        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the managed skill", async () => {
            await visit(page, `/skills/${created.id}`);
            await page.getByRole("heading", { name: "release-notes" }).waitFor();
            expect(await page.getByText("Runtime: git", { exact: true }).isVisible()).toBe(true);
            expect(await page.getByText("Not checked", { exact: true }).isVisible()).toBe(true);
            await page
              .getByRole("button", { name: "Allow model selection help", exact: true })
              .hover();
            await page
              .getByRole("tooltip")
              .getByText(
                "This skill asks agents not to select it automatically. Changing this switch overrides that preference in Executor.",
                { exact: true },
              )
              .waitFor();
          });

          await step("Opt in to model selection", async () => {
            await page.getByRole("switch").nth(1).click();
            await Promise.all([
              page.waitForResponse(
                (response) =>
                  response.url().endsWith(`/api/skills/${created.id}/delivery`) &&
                  response.status() === 200,
              ),
              page
                .getByRole("alertdialog")
                .getByRole("button", { name: "Allow model selection" })
                .click(),
            ]);
            await visit(page, page.url());
            await expect.poll(() => page.getByRole("switch").nth(1).isChecked()).toBe(true);
          });

          await step("Move the skill to the workspace", async () => {
            await page.getByRole("link", { name: "Edit", exact: true }).click();
            await page.getByRole("heading", { name: "Edit skill", exact: true }).waitFor();
            await page.getByRole("combobox").click();
            await page.getByRole("option", { name: "Workspace", exact: true }).click();
            await Promise.all([
              page.waitForResponse(
                (response) =>
                  response.url().endsWith(`/api/skills/${created.id}/package`) &&
                  response.request().method() === "PUT" &&
                  response.status() === 200,
              ),
              page.getByRole("button", { name: "Save skill", exact: true }).click(),
            ]);
            await page.getByRole("heading", { name: "release-notes", exact: true }).waitFor();
            await page.getByText("Workspace", { exact: true }).waitFor();
          });
        });

        const session = mcp.session(identity);
        const tools = yield* session.describeTools();
        expect(tools.find(({ name }) => name === "skills")?.description).toContain(
          "`release-notes`",
        );
        const activation = tools.find(({ name }) => name === "skill_release_notes");
        expect(activation?.description).toBe("Draft release notes from merged changes.");
        expect(
          JSON.stringify(activation).length,
          "the activation tool stays below the per-tool context budget",
        ).toBeLessThan(300);

        const activated = yield* session.call("skill_release_notes", {});
        expect(activated.ok).toBe(true);
        expect(activated.text).toContain("# Release notes");
        expect(activated.text).not.toContain("disable-model-invocation");

        const index = yield* session.call("skills", {});
        expect(index.text).toContain("release-notes");
        expect(index.text).toContain("`execute`");

        const loaded = yield* session.call("skills", { name: "release-notes", owner: "org" });
        expect(loaded.ok).toBe(true);
        expect(loaded.text).toContain("# Release notes");
        expect(loaded.text).not.toContain("disable-model-invocation");
        expect(loaded.text).toContain("<file>references/style.md</file>");

        const reference = yield* session.call("skills", {
          name: "release-notes",
          owner: "org",
          file: "references/style.md",
        });
        expect(reference.ok).toBe(true);
        expect(reference.text).toContain("Lead with the user-visible change.");
      }),
      executor.skills.remove({ params: { skillId: created.id } }).pipe(Effect.orDie),
    );
  }),
);

scenario(
  "Managed skills · create stays in sync with the skills and toolkit views",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const executor = yield* client(api, identity);

    yield* Effect.ensuring(
      browser.session(identity, async ({ page, step }) => {
        await step("Open skill management for a toolkit with no skills", async () => {
          await visit(page, "/toolkits");
          await page.getByRole("button", { name: "Add personal toolkit", exact: true }).click();
          await page.getByLabel("Toolkit name").fill("Feedback toolkit");
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith("/api/toolkits") &&
                response.request().method() === "POST" &&
                response.status() === 200,
            ),
            page.getByRole("button", { name: "Create toolkit", exact: true }).click(),
          ]);
          await page.getByRole("link", { name: /Feedback toolkit/ }).click();
          await page.getByRole("button", { name: "Manage skills", exact: true }).click();
          await page.getByText("Add a managed skill before assigning skills").waitFor();
          await page.getByRole("link", { name: "Add skill", exact: true }).click();
        });

        await step("Create a managed skill and see it without refreshing", async () => {
          await page.getByRole("heading", { name: "New skill", exact: true }).waitFor();
          await page
            .getByLabel("Contents of SKILL.md")
            .fill(
              "---\nname: feedback-skill\ndescription: Capture product feedback.\n---\n\n# Feedback skill\n",
            );
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith("/api/skills") &&
                response.request().method() === "POST" &&
                response.status() === 200,
            ),
            page.getByRole("button", { name: "Save skill", exact: true }).click(),
          ]);
          await page.getByRole("heading", { name: "feedback-skill", exact: true }).waitFor();
          await page
            .getByRole("navigation")
            .getByRole("link", { name: "Skills", exact: true })
            .click();
          await page.getByText("feedback-skill", { exact: true }).waitFor();
        });

        await step("See the new skill in toolkit management without refreshing", async () => {
          await page.getByRole("link", { name: "Toolkits", exact: true }).click();
          await page.getByRole("link", { name: /Feedback toolkit/ }).click();
          await page.getByRole("button", { name: "Manage skills", exact: true }).click();
          await page.getByText("feedback-skill", { exact: true }).waitFor();
        });

        await step("Remove the temporary toolkit", async () => {
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.getByRole("button", { name: "Delete toolkit", exact: true }).click();
          await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
          await page.getByRole("heading", { name: "Toolkits", exact: true }).waitFor();
        });
      }),
      Effect.gen(function* () {
        const skills = yield* executor.skills.list();
        yield* Effect.forEach(
          skills.filter((skill) => skill.name === "feedback-skill"),
          (skill) => executor.skills.remove({ params: { skillId: skill.id } }),
          { discard: true },
        );
      }).pipe(Effect.orDie),
    );
  }),
);
