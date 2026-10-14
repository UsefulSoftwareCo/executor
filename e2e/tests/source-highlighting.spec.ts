import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const files = [
  {
    path: "index.html",
    content: `<!doctype html>
<html lang="en">
  <head>
    <title>Example app</title>
    <style>.example { color: #123456; }</style>
  </head>
  <body>
    <!-- A small source example -->
    <h1 class="example">Hello, world!</h1>
    <script>const enabled = true;</script>
  </body>
</html>`,
  },
  {
    path: "styles.css",
    content: `/* Shared app styles */
@layer base {
  :root {
    color-scheme: dark;
    --accent: #123456;
  }

  .example:hover {
    color: var(--accent);
    margin: 2px;
  }
}`,
  },
  {
    path: "README.md",
    content: `# Example app

A **bold** description with \`inline code\`.

## Getting started

- Read [the guide](guide.markdown).
- Open the app in your browser.

> Keep the source readable.`,
  },
  { path: "guide.markdown", content: "# Guide\nRead [the example](README.md)." },
  {
    path: "config.json",
    content:
      '{\n  "name": "Example",\n  "enabled": true,\n  "count": 42,\n  "tags": [\n    "source",\n    "highlighting"\n  ],\n  "options": null\n}',
  },
];

layer(HostedLive, { excludeTestServices: true })("Source highlighting", (it) => {
  it.effect(scenarios.sourceHighlighting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const created = yield* api.request(actors.owner, "POST", prefix, {
          name: `Highlighting ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: "export default {};" }, ...files, appsManifest],
        });
        expect(created.status).toBe(200);
        const app = yield* body(App, created);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Use the dark source theme", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        yield* browser.use("Open working source", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=source`),
        );
        for (const file of files) {
          yield* browser.use(`Select ${file.path}`, (page) =>
            page
              .getByRole("navigation", { name: "Source files", exact: true })
              .getByRole("button", { name: file.path, exact: true })
              .click(),
          );
          yield* browser.use(`${file.path} has distinct syntax colors`, (page) =>
            expect
              .poll(() =>
                page
                  .getByRole("region", { name: "Source browser", exact: true })
                  .locator("code span[style]")
                  .evaluateAll(
                    (tokens) => new Set(tokens.map((token) => getComputedStyle(token).color)).size,
                  ),
              )
              .toBeGreaterThan(1),
          );
          expect(
            yield* browser.use(`${file.path} retains its source text`, (page) =>
              page
                .getByRole("region", { name: "Source browser", exact: true })
                .locator(".code-line > span:last-of-type")
                .allTextContents(),
            ),
          ).toEqual(file.content.split("\n"));
          yield* browser.checkpoint(`Highlighted ${file.path}`);
        }
        yield* browser.checkpoint("Highlighted source after switching file types");
      }),
    ),
  );

  it.effect(scenarios.skillCodeHighlighting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const snippet = 'const greeting: string = "hello";\nexport default greeting;';
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Skill highlighting ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";\nexport default defineApp({}, async () => ({}));`,
            },
            {
              path: "skills/greet/SKILL.md",
              content: `---\nname: greet\ndescription: Greet someone.\n---\n# Greet\n\n\`\`\`ts\n${snippet}\n\`\`\`\n`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Use the dark source theme", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        const colors = (scope: "editor" | "reader") => (page: Page) =>
          expect
            .poll(() =>
              page
                .getByRole("region", { name: "App skills", exact: true })
                .locator(
                  scope === "editor" ? "[role=textbox] pre span[style]" : "pre code span[style]",
                )
                .evaluateAll(
                  (tokens) => new Set(tokens.map((token) => getComputedStyle(token).color)).size,
                ),
            )
            .toBeGreaterThan(1);
        yield* browser.use("Open the editable skill instructions", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=skills`),
        );
        yield* browser.use("The visual editor replaces the loading reader", (page) =>
          page
            .getByRole("textbox", { name: "Skill instructions", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Editor code block has distinct syntax colors", colors("editor"));
        expect(
          yield* browser.use("Editor code block retains its text", (page) =>
            page
              .getByRole("textbox", { name: "Skill instructions", exact: true })
              .locator("pre code")
              .textContent(),
          ),
        ).toBe(snippet);
        yield* browser.checkpoint("Highlighted code block in the skill editor");
        // Type characters rather than pressing Enter. The browser inserts text at the DOM caret,
        // while ProseMirror handles Enter with the selection it last read, and Chrome can deliver
        // fast synthetic keys before the click's selectionchange event.
        yield* browser.use("Place the cursor after the last code line", (page) =>
          page
            .getByRole("textbox", { name: "Skill instructions", exact: true })
            .locator("pre code span[style]")
            .last()
            .click()
            .then(() => page.keyboard.press("End")),
        );
        yield* browser.use("The cursor is in the code block", (page) =>
          expect
            .poll(() =>
              page.evaluate(
                () => document.getSelection()?.anchorNode?.parentElement?.closest("pre") != null,
              ),
            )
            .toBe(true),
        );
        yield* browser.use("Type more code", (page) => page.keyboard.type(" const count = 2;"));
        yield* browser.use("New code is colored as it is typed", (page) =>
          expect
            .poll(() =>
              page
                .getByRole("textbox", { name: "Skill instructions", exact: true })
                .locator("pre span[style]")
                .allTextContents(),
            )
            .toContain("2"),
        );
        yield* browser.use("The edit is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Edited code block stays highlighted");

        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        yield* browser.login(actors.member);
        yield* browser.use("Open the read-only skill instructions", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=skills`),
        );
        yield* browser.use("Reader code block has distinct syntax colors", colors("reader"));
        expect(
          yield* browser.use("Reader code block retains its text without line numbers", (page) =>
            page
              .getByRole("region", { name: "App skills", exact: true })
              .locator("pre code")
              .textContent(),
          ),
        ).toBe(`${snippet}\n`);
        expect(
          yield* browser.use("Members without edit access get the reader", (page) =>
            page.getByRole("textbox", { name: "Skill instructions", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Highlighted code block in the skill reader");
      }),
    ),
  );
});
