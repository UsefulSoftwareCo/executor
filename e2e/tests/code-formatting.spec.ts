/** Format the real source viewer without rewriting retained source or numeric identifiers. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
/** Display listings name every file; contents are inlined only within the budget. */
const Display = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Number,
      content: Schema.optionalKey(Schema.String),
    }),
  ),
});
const DisplayFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  content: Schema.String,
});
const Revision = Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) });
const Pinned = Schema.Struct({ id: Schema.String });
const displayPaths = { source: "source/display", workspace: "workspace/display" } as const;
/** A generated file above the inline budget, formatted only when read on its own. */
const largeSnippet = {
  path: "large-demo.ts",
  content: `export const operations=[${Array.from(
    { length: 4000 },
    (_, index) => `{id:${index},name:"operation-${index}"}`,
  ).join(",")}];`,
};
const snippets = [
  {
    path: "format-demo.ts",
    content:
      'export type User={id:string;name:string};export const users:User[]=[{id:"1",name:"Ada"}];',
  },
  { path: "format-demo.js", content: "export const add=(a,b)=>{return a+b};" },
  {
    path: "format-demo.tsx",
    content: "export const Widget=()=> <button disabled={false}>Hi</button>",
  },
  {
    path: "data.json",
    content: '{"id":9007199254740993,"items":[1,2],"text":"<script>literal</script>"}',
  },
  { path: "unfinished.ts", content: "export const unfinished =" },
  { path: "invalid.json", content: '{"unfinished":' },
  { path: "widget.jsx", content: "export const Widget=()=> <button>Hi</button>" },
  { path: "command.sh", content: "#!/bin/sh\nprintf '%s\\n' 'stay   unchanged'\n" },
];
layer(HostedLive, { excludeTestServices: true })("Code formatting", (it) => {
  it.effect(scenarios.codeFormatting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const files = [
          {
            path: "index.ts",
            content:
              'import {defineApp,query,object} from "apps";export default defineApp({accounts:{}},{queries:{ping:query({input:object({})},async()=>"pong")}});',
          },
          ...snippets,
          largeSnippet,
        ];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Formatting ${randomUUID().slice(0, 6)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.asVoid, Effect.orDie),
        );
        const displays = new Map<string, typeof Display.Type>();
        // Single-file reads are pinned to the deployment or commit the listing came from.
        const filePaths = {
          source: `${path}/deployments/${
            (yield* body(Pinned, yield* api.request(actors.owner, "GET", `${path}/source`))).id
          }/display/file`,
          workspace: `${path}/commits/${
            (yield* body(Revision, yield* api.request(actors.owner, "GET", `${path}/workspace`)))
              .revision.commit
          }/display/file`,
        };
        const largeDisplays = new Map<string, typeof DisplayFile.Type>();
        for (const endpoint of ["source", "workspace"] as const) {
          const response = yield* api.request(
            actors.owner,
            "GET",
            `${path}/${displayPaths[endpoint]}`,
          );
          expect(response.status).toBe(200);
          const display = yield* body(Display, response);
          displays.set(endpoint, display);
          expect(display.files.find((file) => file.path === "format-demo.ts")?.content).toContain(
            "users: User[]",
          );
          expect(display.files.find((file) => file.path === "format-demo.js")?.content).toContain(
            "return a + b;",
          );
          expect(display.files.find((file) => file.path === "format-demo.tsx")?.content).toContain(
            "Widget = () =>",
          );
          expect(display.files.find((file) => file.path === "widget.jsx")?.content).toContain(
            "Widget = () =>",
          );
          expect(display.files.find((file) => file.path === "data.json")?.content).toContain(
            '\n  "id": 9007199254740993',
          );
          for (const name of ["unfinished.ts", "invalid.json", "command.sh"]) {
            expect(display.files.find((file) => file.path === name)?.content).toBe(
              snippets.find((file) => file.path === name)?.content,
            );
          }
          expect(
            (yield* api.request(actors.member, "GET", `${path}/${displayPaths[endpoint]}`)).status,
          ).toBe(403);
          // The large file is listed by path and stored size, then read on its own.
          expect(display.files.find((file) => file.path === largeSnippet.path)).toEqual({
            path: largeSnippet.path,
            size: new TextEncoder().encode(largeSnippet.content).byteLength,
          });
          const largeFile = `${filePaths[endpoint]}?path=${largeSnippet.path}`;
          const large = yield* body(
            DisplayFile,
            yield* api.request(actors.owner, "GET", largeFile),
          );
          expect(large.size).toBe(new TextEncoder().encode(largeSnippet.content).byteLength);
          expect(large.content).toContain('\n  { id: 0, name: "operation-0" },\n');
          largeDisplays.set(endpoint, large);
          expect((yield* api.request(actors.member, "GET", largeFile)).status).toBe(403);
          expect(
            (yield* api.request(actors.owner, "GET", `${filePaths[endpoint]}?path=missing.ts`))
              .status,
          ).toBe(404);
        }
        yield* browser.login(actors.owner);
        // Observe the clipboard boundary without reading or replacing the machine's clipboard.
        yield* browser.use("Capture copied source at the browser boundary", (page) =>
          page.addInitScript(
            (rawScripts) => {
              new MutationObserver(() => {
                const code = document
                  .querySelector(".source-file .code-view code")
                  ?.cloneNode(true);
                if (!(code instanceof Element)) return;
                code.querySelectorAll(".line-number").forEach((node) => node.remove());
                if (rawScripts.includes((code.textContent ?? "").trimEnd()))
                  document.documentElement.dataset.rawSourceSeen = "true";
              }).observe(document, { subtree: true, childList: true, characterData: true });
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                  writeText: (text: string) => {
                    document.documentElement.dataset.copiedCode = text;
                    return Promise.resolve();
                  },
                },
              });
            },
            files
              .filter((file) => /\.[jt]sx?$/.test(file.path) && file.path !== "unfinished.ts")
              .map((file) => file.content),
          ),
        );
        for (const [endpoint, view] of [
          ["source", "deployments"],
          ["workspace", "source"],
        ] as const) {
          yield* browser.use(`Open ${endpoint} source`, (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=${view}`),
          );
          const read = () =>
            browser.use("Read code without its decorative line numbers", (page) =>
              page.locator(".code-view code").evaluate((element) => {
                const copy = element.cloneNode(true);
                if (!(copy instanceof Element)) throw new Error("Code element missing");
                copy.querySelectorAll(".line-number").forEach((node) => node.remove());
                return copy.textContent ?? "";
              }),
            );
          for (const file of snippets) {
            yield* browser.use(`Select ${file.path}`, (page) =>
              page.getByRole("button", { name: file.path, exact: true }).click(),
            );
            if (file.path === "format-demo.ts")
              yield* browser.use("TypeScript formatting has completed", (page) =>
                page.locator(".code-view").filter({ hasText: "users: User[]" }).waitFor(),
              );
            if (file.path === "format-demo.js")
              yield* browser.use("JavaScript formatting has completed", (page) =>
                page.locator(".code-view").filter({ hasText: "return a + b;" }).waitFor(),
              );
            if (file.path === "format-demo.tsx")
              yield* browser.use("TSX formatting has completed", (page) =>
                page.locator(".code-view").filter({ hasText: "Widget = () =>" }).waitFor(),
              );
            if (file.path === "data.json")
              yield* browser.use("JSON is indented without rounding its identifier", (page) =>
                page.locator(".code-view").filter({ hasText: '"id": 9007199254740993' }).waitFor(),
              );
            const shown = (yield* read()).trimEnd();
            const expected = displays
              .get(endpoint)
              ?.files.find((item) => item.path === file.path)?.content;
            expect(shown).toBe(expected?.trimEnd());
            yield* browser.use("Line count matches the delivered display text", (page) =>
              page.getByText(`${expected?.split("\n").length} lines`, { exact: true }).waitFor(),
            );
            if (file.path === "data.json") {
              expect(shown).toContain('\n  "id": 9007199254740993');
              expect(shown).toContain("<script>literal</script>");
              expect(shown).not.toContain("9007199254740992");
            } else if (
              file.path === "unfinished.ts" ||
              file.path === "invalid.json" ||
              file.path === "command.sh"
            )
              expect(shown).toBe(file.content.trimEnd());
            else expect(shown).not.toBe(file.content);
            yield* browser.use("Copy the displayed source", (page) =>
              page.getByRole("button", { name: "Copy source", exact: true }).click(),
            );
            expect(
              (yield* browser.use("Read the text sent to the clipboard", (page) =>
                page.evaluate(() => document.documentElement.dataset.copiedCode),
              ))?.trimEnd(),
            ).toBe(shown);
            if (file.path === "data.json" || file.path === "format-demo.ts")
              yield* browser.checkpoint(`${endpoint}: formatted ${file.path}`);
          }
          expect(
            yield* browser.use("No raw source was painted before formatting", (page) =>
              page.evaluate(() => document.documentElement.dataset.rawSourceSeen),
            ),
          ).toBeUndefined();
          yield* browser.use(`Select ${largeSnippet.path}`, (page) =>
            page.getByRole("button", { name: largeSnippet.path, exact: true }).click(),
          );
          const large = largeDisplays.get(endpoint)?.content ?? "";
          yield* browser.use("The selected large file loads with display formatting", (page) =>
            page
              .locator(".code-view")
              .filter({ hasText: '{ id: 3999, name: "operation-3999" }' })
              .waitFor(),
          );
          expect((yield* read()).trimEnd()).toBe(large.trimEnd());
          yield* browser.use("Line count matches the loaded display text", (page) =>
            page.getByText(`${large.split("\n").length} lines`, { exact: true }).waitFor(),
          );
          yield* browser.use("Copy the loaded source", (page) =>
            page.getByRole("button", { name: "Copy source", exact: true }).click(),
          );
          expect(
            (yield* browser.use("Read the loaded text sent to the clipboard", (page) =>
              page.evaluate(() => document.documentElement.dataset.copiedCode),
            ))?.trimEnd(),
          ).toBe(large.trimEnd());
          yield* browser.checkpoint(`${endpoint}: loaded ${largeSnippet.path}`);
        }
        for (const endpoint of ["source", "workspace"]) {
          const stored = yield* body(
            Source,
            yield* api.request(actors.owner, "GET", `${path}/${endpoint}`),
          );
          expect(stored.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
            files.toSorted((a, b) => a.path.localeCompare(b.path)),
          );
        }
        // Listings inline and format a bounded amount of source; larger files are read on their own.
        const largeFiles = [
          { path: "index.ts", content: 'export default "draft";' },
          ...Array.from({ length: 5 }, (_, index) => ({
            path: `budget-${index}.ts`,
            content: `export const text="${"a".repeat(60 * 1024)}";`,
          })),
          { path: "formatted.ts", content: `export const text="${"a".repeat(250 * 1024)}";` },
          { path: "oversized.ts", content: `export const text="${"a".repeat(257 * 1024)}";` },
        ];
        const draft = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/drafts`, {
            name: `Formatting budget ${randomUUID().slice(0, 6)}`,
            files: largeFiles,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${draft.id}`).pipe(Effect.orDie),
        );
        const bounded = yield* body(
          Schema.Struct({ ...Display.fields, ...Revision.fields }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${draft.id}/workspace/display`),
        );
        expect(bounded.files.map((file) => file.path).toSorted()).toEqual(
          largeFiles.map((file) => file.path).toSorted(),
        );
        expect(
          bounded.files.filter(
            (file) =>
              file.path.startsWith("budget-") && file.content?.startsWith("export const text =\n"),
          ),
        ).toHaveLength(4);
        for (const file of largeFiles.filter((file) => file.path !== "index.ts"))
          expect(bounded.files.find((item) => item.path === file.path)?.size).toBe(
            new TextEncoder().encode(file.content).byteLength,
          );
        for (const name of ["budget-4.ts", "formatted.ts", "oversized.ts"])
          expect(bounded.files.find((file) => file.path === name)?.content).toBeUndefined();
        const readFile = (name: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `${prefix}/apps/${draft.id}/commits/${bounded.revision.commit}/display/file?path=${name}`,
            )
            .pipe(Effect.flatMap((response) => body(DisplayFile, response)));
        expect((yield* readFile("budget-4.ts")).content).toMatch(/^export const text =\n/);
        expect((yield* readFile("formatted.ts")).content).toMatch(/^export const text =\n/);
        // Files above the formatting budget are returned as their exact stored text.
        expect((yield* readFile("oversized.ts")).content).toBe(
          largeFiles.find((file) => file.path === "oversized.ts")?.content,
        );
        // Raw reads still return every stored file byte for byte.
        const raw = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${draft.id}/workspace`),
        );
        expect(raw.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
          largeFiles.toSorted((a, b) => a.path.localeCompare(b.path)),
        );
      }),
    ),
  );
});
