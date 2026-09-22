import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const files = [
  { path: "styles.css", content: ".example { color: #123456; margin: 2px; }" },
  { path: "README.md", content: "# Example\nA **bold** description with `code`." },
  { path: "guide.markdown", content: "# Guide\nRead [the example](README.md)." },
  { path: "config.json", content: '{ "enabled": true, "count": 42, "name": "Example" }' },
];

layer(HostedLive, { excludeTestServices: true })("Source highlighting", (it) => {
  it.effect(scenarios.sourceHighlighting.title, (context) =>
    withCase(
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
        }
        yield* browser.checkpoint("Highlighted source after switching file types");
      }),
    ),
  );
});
