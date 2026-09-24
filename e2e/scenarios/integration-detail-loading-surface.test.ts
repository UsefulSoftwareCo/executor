// Opening an integration from the list shows ONE loading surface, not four.
//
// ## What went wrong
//
// Clicking an integration in the list walked the detail page through a run of
// visually distinct placeholders, each alive for a few hundred milliseconds:
//
//   1. the header printed the raw URL slug (`postman-echo-9f2a`) and then
//      swapped it for the real name ("Postman Echo");
//   2. the Accounts pane rendered the generic section with ZERO auth methods,
//      which is the same render as "this integration has no way to connect" —
//      so the dashed empty card briefly said "Ask a workspace admin to
//      configure an authentication method";
//   3. a pulsing dot and the words "Loading accounts…" — a loading vocabulary
//      used nowhere else on the page;
//   4. the real accounts content, in a taller box than any of the above.
//
// Every one of those is an internal boundary of ours — the catalog row request,
// the plugin lookup that depends on it, the connections request — and none is a
// fact the person clicking an integration has any use for. What they produced
// was churn: several different things flashing in several different places, and
// one of them stating something false about the integration.
//
// ## What is asserted, and why it is asserted this way
//
// Same method as the artifact loading-surface scenario, for the same reason:
// the states in question were only ever on screen for a few hundred
// milliseconds, so a screenshot at one moment would miss them and pass against
// the old code too. The page is SAMPLED CONTINUOUSLY from before the click
// until the detail page is live, and the assertion is over everything that was
// ever on screen:
//
//   - none of the placeholder texts ever appeared, and the raw slug was never
//     shown as the page title;
//   - the detail body's box never changed size, so nothing was laid out twice.
//
// Both directions are covered, because they fail differently: warm (a click
// from the list, catalog already in the client's atom cache) and cold (a direct
// URL in a fresh context, where nothing is cached and the window is widest).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { AccountHttpApi } from "@executor-js/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** A display name that shares no substring with the slug, so "the header showed
 *  the slug" and "the header showed the name" are impossible to confuse. */
const DISPLAY_NAME = "Postman Echo";

/** A two-operation spec — enough that the Tools tab has real content to lay out
 *  once the page settles, which is what the steady-state box is measured at. */
const echoSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: DISPLAY_NAME, version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The current account",
          responses: { "200": { description: "ok" } },
        },
      },
      "/echo": {
        get: {
          operationId: "getEcho",
          summary: "Echo the request back",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

/** A real node:http upstream on 127.0.0.1 so discovery and health probes have
 *  something that answers. Closed by the scope's finalizer. */
const serveEchoApi = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, url: request.url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${port}`,
          close: () => {
            server.close();
            server.closeAllConnections();
          },
        }),
      );
    });
  }),
  (server) => Effect.sync(server.close),
);

type Sample = {
  readonly text: string;
  readonly title: string | null;
  readonly body: {
    readonly w: number;
    readonly h: number;
  } | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __detailSamples: Array<Sample> | undefined;
}

/**
 * Watch the console document continuously for the whole open.
 *
 * Installed as an init script so it is running before the first byte of the
 * page, and polls on an animation frame — fast enough that a placeholder
 * visible for even one paint is recorded. The header title and the detail
 * body's box are sampled alongside the text, because a placeholder that came
 * and went without changing any WORDS would still have moved the layout, and a
 * layout that jumps is the same defect wearing a different hat.
 */
const startSampling = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    globalThis.__detailSamples = [];
    const sample = () => {
      const body = document.querySelector<HTMLElement>('[data-testid="integration-detail-body"]');
      const box = body?.getBoundingClientRect();
      const title = document.querySelector<HTMLElement>('[data-testid="integration-detail-title"]');
      globalThis.__detailSamples?.push({
        text: document.body?.innerText ?? "",
        title: title?.innerText ?? null,
        body: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
};

const readSamples = (page: Page): Promise<ReadonlyArray<Sample>> =>
  page.evaluate(() => globalThis.__detailSamples ?? []);

const resetSamples = (page: Page): Promise<void> =>
  page.evaluate(() => {
    globalThis.__detailSamples = [];
  });

/**
 * Assert the whole open was one surface.
 *
 * Three independent properties over the same recording — no placeholder words,
 * no raw slug in the title, and a body box that never changed — because any one
 * alone would let the churn back in through another door.
 */
const expectSingleLoadingSurface = (
  samples: ReadonlyArray<Sample>,
  slug: string,
  label: string,
): void => {
  expect(samples.length, `${label}: the sampler actually ran`).toBeGreaterThan(3);

  // The exact strings the superseded placeholders rendered. Named literally
  // rather than by testid: the point is that these WORDS are gone from the
  // experience, and a rename that kept the churn should not pass.
  const forbidden = [
    "Loading accounts",
    // The empty-state copy for "this integration declares no auth method". It
    // is a true sentence for such an integration and a false one here, so it
    // must never appear for an integration that has connections.
    "Ask a workspace admin to configure an authentication method",
    "No connections yet",
  ] as const;

  for (const text of forbidden) {
    const hit = samples.findIndex((entry) => entry.text.includes(text));
    expect(
      hit,
      `${label}: "${text}" was on screen at sample ${hit} of ${samples.length} — the open still walks through more than one loading state`,
    ).toBe(-1);
  }

  // The title is the integration's name or nothing at all — never the raw slug
  // from the URL, which is a machine identifier the reader did not ask to see.
  const slugTitle = samples.findIndex((entry) => entry.title?.includes(slug) === true);
  expect(
    slugTitle,
    `${label}: the header printed the raw slug "${slug}" at sample ${slugTitle} of ${samples.length} before the name arrived`,
  ).toBe(-1);

  // The body's geometry, over every frame in which a body existed at all. The
  // skeleton and the settled content share one box by construction, so a change
  // here means the content was laid out differently from the skeleton that held
  // its place.
  const boxes = samples.map((entry) => entry.body).filter(Predicate.isNotNull);
  expect(boxes.length, `${label}: the detail body was on screen at some point`).toBeGreaterThan(0);

  const first = boxes[0];
  if (!first) return;
  for (const [index, box] of boxes.entries()) {
    // A pixel of tolerance for sub-pixel rounding as the scrollbar settles.
    expect(
      Math.abs(box.w - first.w) <= 1 && Math.abs(box.h - first.h) <= 1,
      `${label}: the detail body changed size mid-load at sample ${index} (${JSON.stringify(box)} vs ${JSON.stringify(first)}) — the content appeared in a different box than the skeleton held`,
    ).toBe(true);
  }
};

scenario(
  "Integrations · opening an integration shows one loading surface",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const upstream = yield* serveEchoApi;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);

    const slug = IntegrationSlug.make(`postman-echo-${randomBytes(4).toString("hex")}`);

    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: echoSpec(upstream.url) },
        slug,
        baseUrl: upstream.url,
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });

    // A real connection, so the settled Accounts pane is the POPULATED one —
    // the state whose height the loading surface has to hold open.
    yield* client.connections.create({
      payload: {
        owner: "org",
        name: ConnectionName.make("primary"),
        integration: slug,
        template: TEMPLATE,
        value: "tok_echo",
      },
    });

    const accountClient = yield* apiClient(AccountHttpApi, identity);
    const me = yield* accountClient.account.me();
    const orgSlug = me.organization?.slug;
    const listPath = orgSlug ? `/${orgSlug}` : "/";
    const detailPath = orgSlug
      ? `/${orgSlug}/integrations/${String(slug)}`
      : `/integrations/${String(slug)}`;

    // ------------------------------------------------------------------
    // WARM: the journey a user actually takes — the list, then a click.
    // ------------------------------------------------------------------
    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the integrations list", async () => {
        await startSampling(page);
        await visit(page, `${target.baseUrl}${listPath}`);
        await page.getByTestId(`integration-entry-${String(slug)}`).waitFor({ timeout: 30_000 });
        // Discard everything from the list's own load: this scenario is about
        // the OPEN, and the list has a loading state of its own.
        await resetSamples(page);
      });

      await step("Click through to the integration", async () => {
        await page.getByTestId(`integration-entry-${String(slug)}`).click();
        await page.getByTestId("connection-row-primary").waitFor({ timeout: 60_000 });
      });

      await step("The whole open was one surface", async () => {
        expectSingleLoadingSurface(await readSamples(page), String(slug), "warm open");
      });

      await step("The settled page is the real integration", async () => {
        await expect
          .poll(async () => await page.getByTestId("integration-detail-title").innerText(), {
            timeout: 10_000,
            message: "the header carries the integration's display name",
          })
          .toContain(DISPLAY_NAME);
      });
    });

    // ------------------------------------------------------------------
    // COLD: the deep link, in a context that has never loaded the console.
    //
    // The harder case: nothing is cached, so the catalog row and the
    // connections both start from zero and the loading window is at its widest.
    // ------------------------------------------------------------------
    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the integration by URL, cold", async () => {
        await startSampling(page);
        await page.goto(`${target.baseUrl}${detailPath}`, { waitUntil: "commit" });
        await page.getByTestId("connection-row-primary").waitFor({ timeout: 60_000 });
      });

      await step("The cold open was one surface too", async () => {
        expectSingleLoadingSurface(await readSamples(page), String(slug), "cold open");
      });
    });
  }),
);
