import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";

const icon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#4ea1ff"/></svg>';
const server = {
  path: "index.ts",
  content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
};
const main = {
  path: "ui/index.html",
  content:
    '<!doctype html><html><head><title>Desktop pages</title></head><body><p id="main"></p><script type="module" src="./main.ts"></script></body></html>',
};
const plainPage = {
  path: "ui/index.html",
  content:
    "<!doctype html><html><head><title>Plain</title></head><body><h1>Plain</h1></body></html>",
};
const files = [
  server,
  main,
  {
    path: "ui/menubar.html",
    content:
      '<!doctype html><html><head><title>Menu</title></head><body><p id="menu"></p><script type="module" src="./menubar.ts"></script></body></html>',
  },
  { path: "ui/shared.ts", content: 'export const label = "shared";' },
  {
    path: "ui/main.ts",
    content:
      'import { label } from "./shared.ts"; document.querySelector("#main")!.textContent = `main ${label}`;',
  },
  {
    path: "ui/menubar.ts",
    content:
      'import { label } from "./shared.ts"; const context = JSON.parse(document.getElementById("executor-context")!.textContent!); document.querySelector("#menu")!.textContent = `menu ${label} ${context.version}`;',
  },
  { path: "ui/icon.svg", content: icon },
  appsManifest,
];
const Location = Schema.Struct({
  status: Schema.Literal("ready"),
  url: Schema.String,
  name: Schema.String,
  icon: Schema.Boolean,
  menuBar: Schema.Boolean,
});
const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("VersionBuildFailed"),
  stage: Schema.String,
  location: Schema.optional(Schema.Struct({ file: Schema.String })),
  message: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("App desktop pages", (it) => {
  it.effect(scenarios.appDesktopPages.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (name: string, deployed: ReadonlyArray<{ path: string; content: string }>) =>
          api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name,
            files: deployed,
          });
        const created = (
          name: string,
          deployed: ReadonlyArray<{ path: string; content: string }>,
        ) =>
          Effect.gen(function* () {
            const response = yield* deploy(name, deployed);
            yield* evidence.json(`deploy-${name}.json`, {
              status: response.status,
              body: response.body,
            });
            expect(response.status).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const location = (app: string) =>
          Effect.gen(function* () {
            const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app}/ui`);
            const response = yield* api.request(actors.owner, "GET", `${prefix}/${app}/ui`);
            expect(response.status).toBe(200);
            const found = yield* body(Location, response);
            expect(found.url).toBe(url);
            return found;
          });

        const name = `Desktop pages ${randomUUID().slice(0, 8)}`;
        const app = yield* created(name, files);
        const full = yield* location(app.id);
        expect(full).toMatchObject({ status: "ready", name, icon: true, menuBar: true });

        const plainName = `Plain page ${randomUUID().slice(0, 8)}`;
        const plain = yield* created(plainName, [server, plainPage, appsManifest]);
        const plainLocation = yield* location(plain.id);
        expect(plainLocation).toMatchObject({
          status: "ready",
          name: plainName,
          icon: false,
          menuBar: false,
        });

        yield* browser.login(actors.owner);
        yield* openPrivateApp(new URL("/_executor/menubar", full.url).href);
        const version = yield* browser.use("Read the menu-bar page's version", (page) =>
          page.evaluate(
            () =>
              JSON.parse(document.getElementById("executor-context")?.textContent ?? "{}")
                .version as string,
          ),
        );
        yield* browser.use("The menu-bar page runs its entry with the host's context", (page) =>
          page
            .locator("#menu")
            .filter({ hasText: `menu shared ${version}` })
            .waitFor(),
        );
        yield* browser.use("Open the main page", (page) => page.goto(full.url));
        yield* browser.use("The main page runs its own entry", (page) =>
          page.locator("#main").filter({ hasText: "main shared" }).waitFor(),
        );
        yield* browser.checkpoint("The menu-bar page shares code with the main page");

        const fetched = yield* browser.use("Read the icon and the retained page paths", (page) =>
          page.evaluate(
            (version) =>
              Promise.all(
                [
                  "/_executor/icon.svg",
                  `/_executor/assets/${version}/_executor/menubar.html`,
                  `/_executor/assets/${version}/_executor/icon.svg`,
                  `/_executor/assets/${version}/index.html`,
                  "/_executor/menubar.html",
                ].map((path) =>
                  fetch(path).then((response) =>
                    response.text().then((text) => ({
                      status: response.status,
                      type: response.headers.get("content-type"),
                      policy: response.headers.get("content-security-policy"),
                      body: text,
                    })),
                  ),
                ),
              ).then(([icon, ...raw]) => ({ icon, raw: raw.map((read) => read?.status) })),
            version,
          ),
        );
        expect(fetched.icon).toMatchObject({ status: 200, type: "image/svg+xml", body: icon });
        expect(fetched.icon?.policy).toContain("default-src 'none'");
        expect(fetched.raw).toEqual([404, 404, 404, 404]);
        expect(
          yield* browser.use("The icon decodes as an image", (page) =>
            page.evaluate(() => {
              const image = new Image();
              image.src = "/_executor/icon.svg";
              return image.decode().then(() => image.naturalWidth);
            }),
          ),
        ).toBeGreaterThan(0);

        yield* openPrivateApp(new URL("/_executor/menubar", plainLocation.url).href);
        expect(
          yield* browser.use("An app without a menu-bar page says so", (page) =>
            page.locator("body").innerText(),
          ),
        ).toBe("This app has no menu-bar page.");

        const failure = (deployed: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* deploy(`Desktop failure ${randomUUID().slice(0, 8)}`, [
              server,
              ...deployed,
              appsManifest,
            ]);
            expect(response.status).toBe(422);
            return yield* body(BuildFailed, response);
          });
        expect(
          yield* failure([{ path: "ui/menubar.html", content: "<!doctype html><p>Menu</p>" }]),
        ).toMatchObject({ stage: "source", location: { file: "ui/menubar.html" } });
        const notSvg = yield* failure([
          plainPage,
          { path: "ui/icon.svg", content: "<p>not an icon</p>" },
        ]);
        expect(notSvg).toMatchObject({ stage: "source", location: { file: "ui/icon.svg" } });
        expect(notSvg.message).toContain(
          'must contain one <svg xmlns="http://www.w3.org/2000/svg"> element',
        );
        const large = yield* failure([
          plainPage,
          {
            path: "ui/icon.svg",
            content: `<svg xmlns="http://www.w3.org/2000/svg"><desc>${"x".repeat(70_000)}</desc></svg>`,
          },
        ]);
        expect(large).toMatchObject({ stage: "source", location: { file: "ui/icon.svg" } });
        expect(large.message).toContain("an icon can be at most 65536");
        const svg = (inner: string, attributes = "") =>
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attributes}>${inner}</svg>`;
        const rejected = yield* Effect.forEach(
          [
            `<!DOCTYPE svg [<!ENTITY big "x">]>${svg("<desc>&big;</desc>")}`,
            svg("<rect>"),
            svg("<script>alert(1)</script>"),
            svg("<foreignObject><p>page</p></foreignObject>"),
            svg("<rect/>", ' onload="alert(1)"'),
            svg('<image href="https://tracker.example/pixel.png"/>'),
            svg('<use xlink:href="data:image/svg+xml,&lt;svg/&gt;"/>'),
            `<?xml-stylesheet href="https://evil.example/a.css"?>${svg("<rect/>")}`,
          ],
          (content) =>
            failure([plainPage, { path: "ui/icon.svg", content }]).pipe(
              Effect.map((refused) => {
                expect(refused).toMatchObject({
                  stage: "source",
                  location: { file: "ui/icon.svg" },
                });
                return refused.message.replace(/^.*?ui\/icon\.svg /su, "");
              }),
            ),
        );
        expect(rejected).toEqual([
          "declares a DOCTYPE. Remove it; an icon can't declare a DOCTYPE or entities.",
          expect.stringMatching(/^is not well-formed XML: /u),
          "has a <script> element. Remove it; an icon can't run scripts or embed other content.",
          "has a <foreignObject> element. Remove it; an icon can't run scripts or embed other content.",
          "has an onload attribute on <svg>. Remove it; an icon can't run scripts.",
          'links <image> to https://tracker.example/pixel.png. Link only to an element in the icon itself, such as href="#shape"; an icon can\'t load other files.',
          'links <use> to data:image/svg+xml,<svg/>. Link only to an element in the icon itself, such as href="#shape"; an icon can\'t load other files.',
          "has a <?xml-stylesheet?> instruction. Remove it; an icon can't load stylesheets or other files.",
        ]);
        const kept = yield* created(`Desktop icon ${randomUUID().slice(0, 8)}`, [
          server,
          plainPage,
          {
            path: "ui/icon.svg",
            content: `<?xml version="1.0" encoding="UTF-8"?>${svg('<defs><path id="shape" d="M0 0h16v16H0z"/></defs><use xlink:href="#shape"/>', ' viewBox="0 0 16 16"')}`,
          },
          appsManifest,
        ]);
        expect((yield* location(kept.id)).icon).toBe(true);
      }),
    ),
  );
});
