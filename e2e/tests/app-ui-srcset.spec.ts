/**
 * Every view of an app page rewrites its `srcset` candidates to the version's asset root. A long
 * run of commas inside one candidate costs no more than its length, so the page answers as fast
 * as a page of the same size whose commas are in an attribute nothing rewrites.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

/**
 * Commas inside one candidate URL. Rewriting them took time in the square of their count, about
 * 4 seconds a view at this count on a 16-vCPU machine, against tens of milliseconds for the same
 * page served without a rewrite.
 */
const commas = ",".repeat(100_000);
/**
 * How many times slower than the baseline the page may be. Both pages carry the same bytes
 * through the same parse, so a linear rewrite keeps them alike; a quadratic one is a hundred times
 * slower.
 */
const slowerThanBaseline = 4;
/** Reads of each page, alternated; the fastest of each is compared, so one stalled read is not. */
const reads = 3;

const page = (image: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, { tools: router({ ready: query({ input: object({}) }, async () => true) }) });`,
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Responsive images</title></head><body><main>${image}<p role="status">Loading</p></main><script type="module" src="./main.ts"></script></body></html>`,
  },
  {
    path: "ui/main.ts",
    content: `document.querySelector('[role="status"]').textContent = "Ready";`,
  },
  {
    path: "ui/public/mark.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="teal"/></svg>',
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("App page srcset", (it) => {
  it.effect(scenarios.appUiLongSrcset.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        yield* browser.login(actors.owner);
        /** Deploy a page and sign in to its origin on a public file, so the page is unread. */
        const deploy = (name: string, image: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: page(image),
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
            yield* openPrivateApp(`${url}/mark.svg`);
            return url;
          });
        const long = yield* deploy(
          "Long srcset",
          `<img alt="Responsive mark" srcset="a${commas}b 1x, mark.svg 2x">`,
        );
        const baseline = yield* deploy("Baseline", `<img alt="a${commas}b" srcset="mark.svg 2x">`);
        const read = (url: string) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const response = yield* browser.use("Read an app page", (page) =>
              page
                .context()
                .request.get(`${url}/`, { headers: { accept: "text/html" }, maxRedirects: 0 })
                .then((response) =>
                  response.text().then((text) => ({ status: response.status(), text })),
                ),
            );
            expect(response.status).toBe(200);
            return { ...response, ms: (yield* Clock.currentTimeMillis) - started };
          });
        const times = { long: [] as number[], baseline: [] as number[] };
        let text = "";
        for (let round = 0; round < reads; round++) {
          times.baseline.push((yield* read(baseline)).ms);
          const longRead = yield* read(long);
          times.long.push(longRead.ms);
          text = longRead.text;
        }
        const fastest = { long: Math.min(...times.long), baseline: Math.min(...times.baseline) };
        expect(
          fastest.long,
          `the long srcset page's fastest read, against the baseline's ${fastest.baseline} ms (${JSON.stringify(times)})`,
        ).toBeLessThanOrEqual(Math.max(fastest.baseline, 1) * slowerThanBaseline);
        // Both candidates point at the version's assets; the commas stay inside the first URL.
        const version = /srcset="\/_executor\/assets\/([^/"]+)\//.exec(text)?.[1];
        expect(version).toBeDefined();
        const root = `/_executor/assets/${version}/`;
        expect(text).toContain(`srcset="${root}a${commas}b 1x, ${root}mark.svg 2x"`);
      }),
    ),
  );
});
