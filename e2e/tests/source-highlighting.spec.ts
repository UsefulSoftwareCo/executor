import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

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
        const created = yield* api.request(actors.owner, "POST", `${prefix}/drafts`, {
          name: `Highlighting ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: "export default {};" }, ...files],
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
});
