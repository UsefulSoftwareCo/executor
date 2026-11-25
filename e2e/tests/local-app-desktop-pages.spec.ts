import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const icon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#7b5cff"/></svg>';
const server = {
  path: "index.ts",
  content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
};
const main = {
  path: "ui/index.html",
  content:
    "<!doctype html><html><head><title>Local desktop</title></head><body><h1>Main</h1></body></html>",
};
const files = [
  server,
  main,
  {
    path: "ui/menubar.html",
    content:
      '<!doctype html><html><head><title>Menu</title></head><body><p id="menu"></p><script type="module" src="./menubar.ts"></script></body></html>',
  },
  {
    path: "ui/menubar.ts",
    content: 'document.querySelector("#menu")!.textContent = "local menu";',
  },
  { path: "ui/icon.svg", content: icon },
  appsManifest,
];
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Detail = Schema.Struct({
  uiUrl: Schema.NullOr(Schema.String),
  uiIcon: Schema.Boolean,
  uiMenuBar: Schema.Boolean,
});

layer(TestLive, { excludeTestServices: true })("Local app desktop pages", (it) => {
  it.effect(scenarios.localAppDesktopPages.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const send = (method: "POST" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const deployed = (deployFiles: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* send("POST", "/v1/apps/deploy", {
              owner: "local",
              name: `Local desktop ${randomUUID().slice(0, 8)}`,
              files: deployFiles,
            });
            expect(response.status).toBe(200);
            const { app } = yield* body(Deployed, response);
            yield* Effect.addFinalizer(() =>
              send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app.id;
          });
        const full = yield* deployed(files);
        const plain = yield* deployed([server, main, appsManifest]);
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.use("Pair the browser", (page) => page.goto(url));
        yield* browser.use("Pairing finished", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        const detail = (app: string) =>
          browser
            .use("Read the app's details", (page) =>
              page.request.get(`/dashboard/api/apps/${app}`).then((response) => response.json()),
            )
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Detail)));
        const fullDetail = yield* detail(full);
        expect(fullDetail).toMatchObject({ uiIcon: true, uiMenuBar: true });
        expect(yield* detail(plain)).toMatchObject({ uiIcon: false, uiMenuBar: false });
        const ui = fullDetail.uiUrl;
        if (ui === null) return yield* Effect.die(new Error("Missing app URL"));
        yield* browser.use("Open the menu-bar page", (page) =>
          page.goto(new URL("/_executor/menubar", ui).href),
        );
        yield* browser.use("The menu-bar page runs its own entry", (page) =>
          page.locator("#menu").filter({ hasText: "local menu" }).waitFor(),
        );
        yield* browser.checkpoint("Local serves the menu-bar page after sign-in");
        const fetched = yield* browser.use("Read the icon", (page) =>
          page.evaluate(() =>
            fetch("/_executor/icon.svg").then((response) =>
              response.text().then((text) => ({
                status: response.status,
                type: response.headers.get("content-type"),
                policy: response.headers.get("content-security-policy"),
                body: text,
              })),
            ),
          ),
        );
        expect(fetched).toMatchObject({ status: 200, type: "image/svg+xml", body: icon });
        expect(fetched.policy).toContain("default-src 'none'");
      }),
    ),
  );
});
