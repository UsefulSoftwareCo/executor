import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import type { APIResponse, Page, Request, Route } from "playwright";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Workspace } from "../support/app-authoring.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

// Deliberately not in the editor's own style: `*` bullets and a padded table must survive
// untouched when the person edits a different block.
const skill = `---
name: search-messages
description: Search team messages.
license: MIT
---
# Search messages

Use the \`search\` tool to find messages, then summarize them.

## Steps

1. Call \`search\` with the user's topic.
2. Group results by channel:
   \`\`\`ts
   const byChannel = Object.groupBy(results, (m) => m.channel);
   \`\`\`

* Prefer recent messages.
* Never quote private channels.

| Tool   | Purpose          |
|:-------|:-----------------|
| search | Full-text search |
`;
const edited = skill
  .replace("description: Search team messages.", "description: Search and cite team messages.")
  .replace("then summarize them.\n", "then summarize them.\n\nAlways cite the channel.\n");
const files = [
  {
    path: "index.ts",
    content:
      'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, async () => ({}));',
  },
  { path: "skills/search-messages/SKILL.md", content: skill },
  appsManifest,
];
const skillPath = "skills/search-messages/SKILL.md";
const Running = Schema.Struct({ sourceCommit: Schema.String, files: Workspace.fields.files });

layer(HostedLive, { excludeTestServices: true })("Skill editor", (it) => {
  it.effect(scenarios.skillEditor.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Skill editor ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const workspace = () =>
          Effect.flatMap(api.request(actors.owner, "GET", `${path}/workspace`), (response) =>
            body(Workspace, response),
          );
        const skillFile = (snapshot: { readonly files: typeof Workspace.Type.files }) =>
          snapshot.files.find((file) => file.path === skillPath)?.content;

        const page = (label: string, action: (page: Page) => Promise<unknown>) =>
          browser.use(label, action);
        const instructions = (page: Page) =>
          page.getByRole("textbox", { name: "Skill instructions", exact: true });
        // Focus the editor and place the caret like a click at the text's end in one task, then wait
        // for the selectionchange that ProseMirror reads: it handles Enter with the selection it last
        // read, not the DOM caret. A separate click would start ProseMirror's focus timer, which puts
        // the caret back at the clicked point when it fires before that read.
        const caretAtEnd = (page: Page, text: string) =>
          instructions(page)
            .getByText(text)
            .evaluate(
              (element) =>
                new Promise<void>((resolve) => {
                  document.addEventListener(
                    "selectionchange",
                    () => requestAnimationFrame(() => resolve()),
                    { once: true },
                  );
                  element.closest<HTMLElement>("[contenteditable=true]")?.focus();
                  const range = document.createRange();
                  range.selectNodeContents(element);
                  range.collapse(false);
                  getSelection()?.removeAllRanges();
                  getSelection()?.addRange(range);
                }),
            );
        const skillUrl = `/org/${actors.organization.slug}/apps/${app.id}?view=skills`;

        // Every browser read of the working source passes through this route from the first page
        // load, so no read can start before a hold and slip past it.
        const workspaceReads = `**${path}/workspace`;
        const passing = new Set<Request>();
        const held: Route[] = [];
        // A route the test takes answers it itself; a held route waits for `release`.
        let hold: (route: Route) => "pass" | "hold" | "take" | Promise<"take"> = () => "pass";
        yield* page("Route working source reads", (page) => {
          const finished = (request: Request) => void passing.delete(request);
          page.on("requestfinished", finished);
          page.on("requestfailed", finished);
          return page.route(workspaceReads, (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            return Promise.resolve(hold(route)).then((decision) => {
              if (decision === "take") return;
              if (decision === "hold") return void held.push(route);
              passing.add(route.request());
              return route.fallback();
            });
          });
        });
        const until = <A>(label: string, value: () => A | undefined) =>
          Effect.suspend(() => {
            const current = value();
            return current === undefined ? Effect.fail(new Error(label)) : Effect.succeed(current);
          }).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }));
        const readsFinished = (label: string) =>
          until(`${label}: a working source read is still in flight`, () =>
            passing.size === 0 ? true : undefined,
          );
        const release = page("Release the held reads", () =>
          Promise.all(held.splice(0).map((route) => route.fallback())),
        );
        yield* Effect.addFinalizer(() => Effect.ignore(release));

        yield* browser.login(actors.owner);
        // The server sends the skill as the reader, and the editor replaces it once the page has
        // hydrated. Hold the page's scripts to see the server's page, then let it hydrate: the
        // skill's text, from its first heading to its last block, must stay where it was. One
        // step, since each step waits for hydration.
        const positions = (page: Page) =>
          Promise.all(
            [
              page.getByRole("heading", { name: "Search messages", exact: true }),
              page.getByRole("cell", { name: "Full-text search", exact: true }),
            ].map((element) => element.boundingBox().then((box) => [box?.x, box?.y])),
          );
        const transition = yield* browser.use("Open the skill, then let it hydrate", (page) => {
          let scriptHeld = () => {};
          const held = new Promise<void>((resolve) => {
            scriptHeld = resolve;
          });
          let releaseScripts = () => {};
          const scripts = new Promise<void>((resolve) => {
            releaseScripts = resolve;
          });
          const assets = /\/assets\/[^/]+\.js$/;
          return (
            page
              .route(assets, (route) => {
                scriptHeld();
                return scripts.then(() => route.fallback());
              })
              .then(() => page.goto(skillUrl, { waitUntil: "commit" }))
              .then(() =>
                Promise.all([
                  held,
                  page.getByRole("cell", { name: "Full-text search", exact: true }).waitFor(),
                ]),
              )
              // Measure with the final fonts; a late font load shifts the text by a pixel.
              .then(() => page.evaluate(() => document.fonts.ready.then(() => undefined)))
              .then(() =>
                Promise.all([
                  positions(page),
                  instructions(page).count(),
                  page.evaluate(() => document.documentElement.hasAttribute("data-hydrated")),
                  page.screenshot(),
                ]),
              )
              .then(([server, editors, hydrated, screenshot]) => {
                releaseScripts();
                // The page marks itself once hydrated; the editor's text box appears after that.
                return page
                  .waitForFunction(() => document.documentElement.hasAttribute("data-hydrated"))
                  .then(() => instructions(page).waitFor())
                  .then(() => positions(page))
                  .then((editor) => ({ server, editors, hydrated, screenshot, editor }));
              })
              .finally(() => {
                releaseScripts();
                return page.unroute(assets);
              })
          );
        });
        yield* evidence.attach(
          "server-rendered-skill-reader.png",
          "image/png",
          transition.screenshot,
        );
        // Editors never enter a separate mode: the page itself becomes editable.
        yield* browser.checkpoint("Visual skill editor");
        expect(transition.hydrated, "the server's page was measured before hydration").toBe(false);
        expect(transition.editors).toBe(0);
        expect(transition.server.flat()).not.toContain(undefined);
        expect(transition.editor, "the skill's text moved while the page hydrated").toEqual(
          transition.server,
        );
        yield* page("Place the cursor after the first paragraph", (page) =>
          caretAtEnd(page, "then summarize them."),
        );
        yield* page("Start a paragraph", (page) => page.keyboard.press("Enter"));
        yield* page("Type the paragraph", (page) => page.keyboard.type("Always cite the channel."));
        // The visual editor reports Markdown after a short pause; the draft exists once it does.
        yield* page("The paragraph is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );
        yield* page("Edit the description", (page) =>
          page
            .getByRole("textbox", { name: "Description", exact: true })
            .fill("Search and cite team messages."),
        );
        yield* browser.checkpoint("Edited skill");
        yield* page("Save the skill", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        yield* page("Saving clears the draft", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor({ state: "hidden" }),
        );

        // Only the edited description and the new paragraph change; other bytes stay as written.
        const committed = yield* workspace();
        expect(skillFile(committed)).toBe(edited);
        const history = yield* body(
          Schema.Array(Schema.Struct({ commit: Schema.String, message: Schema.String })),
          yield* api.request(actors.owner, "GET", `${path}/history`),
        );
        expect(history[0]).toEqual({
          commit: committed.revision.commit,
          message: "Update search-messages skill",
        });
        // Saving also deploys the new commit.
        const running = yield* api.request(actors.owner, "GET", `${path}/source`).pipe(
          Effect.flatMap((response) => body(Running, response)),
          Effect.filterOrFail(
            (source) => source.sourceCommit === committed.revision.commit,
            () => new Error("The saved commit is not deployed yet"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
        );
        expect(skillFile(running)).toBe(edited);
        yield* page("The deployment status clears", (page) =>
          page.getByRole("status").filter({ hasText: "Saved" }).waitFor({ state: "hidden" }),
        );
        yield* browser.checkpoint("Saved and deployed");

        // Someone else changes the same file while a draft is open; the draft must survive.
        yield* page("Place the cursor after the new paragraph", (page) =>
          caretAtEnd(page, "Always cite the channel."),
        );
        yield* page("Extend the paragraph", (page) => page.keyboard.type(" Link each message."));
        yield* page("The extension is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );
        // The save's own follow-up read must not deliver the concurrent edit behind the hold.
        yield* readsFinished("Before the concurrent edit");
        const concurrent = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: committed.revision.commit,
          files: committed.files.map((file) =>
            file.path === skillPath ? { ...file, content: `${edited}\nConcurrent edit.\n` } : file,
          ),
          message: "Concurrent edit",
        });
        expect(concurrent.status).toBe(200);
        // Save reads the source once to detect the conflict. Hold every later read until the person
        // has discarded: on a slow connection they can discard before a follow-up read returns.
        let reads = 0;
        hold = () => (++reads > 1 ? "hold" : "pass");
        yield* page("Save against the changed file", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        yield* page("Wait for the conflict", (page) =>
          page.getByRole("alert").filter({ hasText: "Someone else changed this file" }).waitFor(),
        );
        yield* page("The draft is still in the editor", (page) =>
          instructions(page).getByText("Always cite the channel. Link each message.").waitFor(),
        );
        yield* browser.checkpoint("Conflicting edit keeps the draft");
        expect(skillFile(yield* workspace())).toBe(`${edited}\nConcurrent edit.\n`);
        // Only held reads remain, so nothing can deliver the newer file before Discard.
        yield* readsFinished("Before discarding");
        const discard = page("Discard the draft", (page) => {
          page.once("dialog", (dialog) => void dialog.accept());
          return page.getByRole("button", { name: "Discard", exact: true }).click();
        });
        yield* discard;
        yield* page("Discarding loads the latest version", (page) =>
          instructions(page).getByText("Concurrent edit.").waitFor(),
        );
        hold = () => "pass";
        yield* release;
        yield* readsFinished("After the conflict");
        expect(skillFile(yield* workspace())).toBe(`${edited}\nConcurrent edit.\n`);

        // A save whose read fails reports it beside the editor alone. The loaded source stays as it
        // was, so the draft survives and saving again recovers.
        yield* page("Place the cursor after the concurrent edit", (page) =>
          caretAtEnd(page, "Concurrent edit."),
        );
        yield* page("Extend the concurrent edit", (page) => page.keyboard.type(" Then reply."));
        yield* page("The reply is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );
        hold = (route) => {
          hold = () => "pass";
          // A status no endpoint declares is an unexpected failure; a dropped connection would be
          // explained as a lost connection instead.
          return route
            .fulfill({ status: 599, contentType: "text/plain", body: "undeclared" })
            .then(() => "take" as const);
        };
        yield* page("Save while the source cannot be read", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        yield* page("The failed read is reported", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).first().waitFor(),
        );
        yield* browser.checkpoint("Failed save read keeps the draft");
        expect(
          yield* page("Only the save reports the failure", (page) =>
            Promise.all([
              page.getByText("Unable to complete this request", { exact: true }).count(),
              page.getByRole("button", { name: "Retry", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 0]);
        yield* page("The reply is still a draft", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );

        // Responses can arrive out of order. A read the page started before the conflict check
        // returns a newer version first; the check's own older response follows. The page must never
        // go back to a version older than one it has accepted, while saving or after discarding.
        let saveReads = 0;
        let earlierRead: Route | undefined;
        let checkRead: { readonly route: Route; readonly response: APIResponse } | undefined;
        hold = (route) => {
          saveReads += 1;
          // The save's conflict check passes; its follow-up read becomes the earlier read. The next
          // save's conflict check reads the server now and answers once the earlier read has. Any
          // read after that reaches the server directly.
          if (saveReads === 1 || saveReads > 3) return "pass";
          if (saveReads === 2) {
            earlierRead = route;
            return "hold";
          }
          return route.fetch().then((response) => {
            checkRead = { route, response };
            return "take" as const;
          });
        };
        yield* page("Save the reply", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        yield* page("Saving the reply clears the draft", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor({ state: "hidden" }),
        );
        const replied = yield* workspace();
        const earlier = yield* until(
          "The save has not started its follow-up read",
          () => earlierRead,
        );
        yield* page("Place the cursor after the reply", (page) => caretAtEnd(page, "Then reply."));
        yield* page("Extend the reply", (page) => page.keyboard.type(" Draft."));
        yield* page("The second extension is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );
        // Each concurrent version adds its own file, so the skill's file list shows which version the
        // page holds. Record every version it renders.
        const olderFile = { path: "skills/search-messages/older-edit.md", content: "Older\n" };
        const newerFile = { path: "skills/search-messages/newer-edit.md", content: "Newer\n" };
        yield* page("Record the versions the skill's file list shows", (page) =>
          page.evaluate(
            (names) => {
              const shown: string[] = [];
              const record = () => {
                const files =
                  document.querySelector('nav[aria-label="Skill files"]')?.textContent ?? "";
                const version = files.includes(names.newer)
                  ? "newer"
                  : files.includes(names.older)
                    ? "older"
                    : "neither";
                if (shown.at(-1) === version) return;
                shown.push(version);
                document.body.dataset.shownVersions = shown.join(" ");
              };
              record();
              new MutationObserver(record).observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true,
              });
            },
            { older: "older-edit.md", newer: "newer-edit.md" },
          ),
        );
        const older = `${skillFile(replied)}\nOlder concurrent edit.\n`;
        const olderCommit = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: replied.revision.commit,
          files: [
            ...replied.files.map((file) =>
              file.path === skillPath ? { ...file, content: older } : file,
            ),
            olderFile,
          ],
          message: "Older concurrent edit",
        });
        expect(olderCommit.status).toBe(200);
        yield* page("Save against the older edit", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        // The conflict check has read the older version on the server; hold its response.
        const check = yield* until("The conflict check has not read the source", () => checkRead);
        const olderSnapshot = yield* workspace();
        const newer = `${skillFile(replied)}\nNewer concurrent edit.\n`;
        const newerCommit = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: olderSnapshot.revision.commit,
          files: [
            ...olderSnapshot.files.flatMap((file) =>
              file.path === olderFile.path
                ? []
                : [file.path === skillPath ? { ...file, content: newer } : file],
            ),
            newerFile,
          ],
          message: "Newer concurrent edit",
        });
        expect(newerCommit.status).toBe(200);
        const accepted = yield* page("Deliver the newer version to the earlier read", () => {
          held.splice(held.indexOf(earlier), 1);
          return earlier
            .fetch()
            .then((response) => earlier.fulfill({ response }))
            .then(() => earlier.request().response())
            .then((response) => (response === null ? false : response.finished().then(() => true)));
        });
        yield* page("Deliver the older version to the conflict check", () =>
          check.route.fulfill({ response: check.response }),
        );
        yield* page("Wait for the second conflict", (page) =>
          page.getByRole("alert").filter({ hasText: "Someone else changed this file" }).waitFor(),
        );
        yield* page("The second draft is still in the editor", (page) =>
          instructions(page).getByText("Then reply. Draft.").waitFor(),
        );
        yield* readsFinished("Before discarding the second draft");
        yield* discard;
        yield* page("Discarding never loads a version older than one the page accepted", (page) =>
          instructions(page)
            .getByText(accepted ? "Newer concurrent edit." : "Older concurrent edit.")
            .waitFor(),
        );
        hold = () => "pass";
        yield* page("Stop routing working source reads", (page) => page.unroute(workspaceReads));
        yield* release;
        yield* readsFinished("After the reversed responses");
        const shown = yield* page("Read the versions the file list showed", (page) =>
          page.evaluate(() => document.body.dataset.shownVersions ?? ""),
        );
        expect(shown).toContain(accepted ? "newer" : "older");
        expect(shown).not.toMatch(/newer.*older/);
        expect(skillFile(yield* workspace())).toBe(newer);

        yield* browser.login(actors.member);
        yield* page("Open the skill as a member", (page) => page.goto(skillUrl));
        yield* page("Wait for the member's skill", (page) =>
          page
            .getByRole("region", { name: "App skills", exact: true })
            .getByText("Always cite the channel.")
            .waitFor(),
        );
        expect(
          yield* page("Members read skills without editing", (page) => instructions(page).count()),
        ).toBe(0);
      }),
    ),
  );
});
