/** Raw Tailwind source deploys through the product and styles real React components. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";

const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, query, object } from "apps";
export default defineApp({ accounts: {} }, {
  queries: { serverOnly: query({ input: object({}) }, async () => "z-[987654]") }
});`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "19.2.0", "react-dom": "19.2.0" } }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tailwind fixture</title><link rel="stylesheet" href="./plain.css"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { Card } from "./components/card";
import "./style.css";
const Badge = lazy(() => import("./lazy"));
createRoot(document.getElementById("root")).render(<main>
  <h1>Tailwind app</h1><Card />
  <Suspense fallback="Loading badge"><Badge /></Suspense>
  <p className="plain">Plain stylesheet</p>
  <p className="applied">Applied utility</p>
</main>);`,
  },
  {
    path: "ui/components/card.tsx",
    content:
      'export function Card() { return <button className="flex p-[13px] md:p-8 bg-brand hover:bg-[rgb(1,2,3)]">Styled card</button>; }',
  },
  {
    path: "ui/lazy.tsx",
    content:
      'export default function Badge() { return <p className="tracking-[3px]">Lazy badge</p>; }',
  },
  {
    path: "ui/style.css",
    content:
      '@import "tailwindcss"; @theme { --color-brand: #123456; } .applied { @apply font-bold; } @source inline("underline");',
  },
  {
    path: "ui/plain.css",
    content: '.plain { border-top: 3px solid rgb(9, 8, 7); background-image: url("./mark.svg"); }',
  },
  {
    path: "ui/mark.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle r="4" fill="red"/></svg>',
  },
];

layer(HostedLive, { excludeTestServices: true })("App Tailwind styles", (it) => {
  it.effect(scenarios.appTailwind.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Tailwind UI ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(response.status).toBe(200);
        const app = yield* body(Deployed, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Use a narrow viewport", (page) =>
          page.setViewportSize({ width: 500, height: 700 }),
        );
        yield* openPrivateApp(url);
        yield* browser.use("React and its lazy component mount", (page) =>
          page.getByText("Lazy badge", { exact: true }).waitFor(),
        );
        const styles = yield* browser.use("Read generated utilities and ordinary CSS", (page) =>
          page.evaluate(() => {
            const card = document.querySelector("button");
            const badge = document.querySelector("p.tracking-\\[3px\\]");
            const plain = document.querySelector(".plain");
            const applied = document.querySelector(".applied");
            if (!card || !badge || !plain || !applied) throw new Error("Fixture elements missing");
            return {
              display: getComputedStyle(card).display,
              padding: getComputedStyle(card).padding,
              background: getComputedStyle(card).backgroundColor,
              tracking: getComputedStyle(badge).letterSpacing,
              border: getComputedStyle(plain).borderTopWidth,
              image: getComputedStyle(plain).backgroundImage,
              weight: getComputedStyle(applied).fontWeight,
            };
          }),
        );
        expect(styles).toMatchObject({
          display: "flex",
          padding: "13px",
          background: "rgb(18, 52, 86)",
          tracking: "3px",
          border: "3px",
          weight: "700",
        });
        expect(styles.image).toContain(".svg");
        yield* browser.use("Activate the responsive utility", (page) =>
          page.setViewportSize({ width: 1000, height: 700 }),
        );
        expect(
          yield* browser.use("Read responsive padding", (page) =>
            page
              .getByRole("button", { name: "Styled card" })
              .evaluate((node) => getComputedStyle(node).padding),
          ),
        ).toBe("32px");
        yield* browser.use("Activate the hover utility", (page) =>
          page.getByRole("button", { name: "Styled card" }).hover(),
        );
        expect(
          yield* browser.use("Read hover color", (page) =>
            page
              .getByRole("button", { name: "Styled card" })
              .evaluate((node) => getComputedStyle(node).backgroundColor),
          ),
        ).toBe("rgb(1, 2, 3)");
        const urls = yield* browser.use("List retained stylesheets", (page) =>
          page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
            links.map((link) => {
              if (!(link instanceof HTMLLinkElement)) throw new Error("Expected a stylesheet link");
              return link.href;
            }),
          ),
        );
        const css = (yield* Effect.forEach(urls, (url) =>
          browser.use("Read retained stylesheet output", (page) =>
            page
              .context()
              .request.get(url)
              .then((response) => response.text()),
          ),
        )).join("\n");
        expect(css).toContain(".underline");
        expect(css).not.toContain("987654");
        expect(css).not.toMatch(/@(?:tailwind|theme|apply|source)\b/);
        for (const invalid of [
          '@import "tailwindcss"; .broken { @apply executor-nonexistent-utility; }',
          '@import "tailwindcss"; @source "./private-files";',
          '@import "tailwindcss"; @plugin "./custom-plugin.js";',
        ]) {
          const rejected = yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
            files: files.map((file) =>
              file.path === "ui/style.css" ? { ...file, content: invalid } : file,
            ),
          });
          expect(rejected.status).toBe(422);
          expect(rejected.body).toMatchObject({ _tag: "DeploymentBuildFailed" });
          const current = yield* body(
            Deployed,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`),
          );
          expect(current.activeDeployment).toBe(app.activeDeployment);
        }
        yield* browser.use("A failed stylesheet update keeps the working app", (page) =>
          page.reload(),
        );
        expect(
          yield* browser.use("The previous responsive style still renders", (page) =>
            page
              .getByRole("button", { name: "Styled card" })
              .evaluate((node) => getComputedStyle(node).padding),
          ),
        ).toBe("32px");
        yield* browser.checkpoint("Tailwind, custom components and plain CSS work together");
      }),
    ),
  );
});
