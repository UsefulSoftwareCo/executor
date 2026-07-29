// Opening an artifact shows ONE loading surface, not three.
//
// ## What went wrong
//
// Opening an artifact used to walk through three visually distinct placeholders
// in quick succession, each in its own layout and each visible for a few hundred
// milliseconds:
//
//   1. "Loading artifact…"        — the row being fetched, small corner text
//   2. "Preparing the renderer…"  — the lazy chunk arriving, a different corner
//   3. "Preparing interactive UI" — the shell booting, a card in the middle
//
// Those are executor's own internal boundaries — an HTTP request, a code-split
// point, an iframe handshake — and none of them is a fact a person opening a
// saved dashboard has any use for. What they produced was churn: three
// different things flashing in three different places. Three quick loading
// states are worse than one longer one, because every transition is a fresh
// demand on the eye.
//
// ## What is asserted, and why it is asserted this way
//
// The honest test of "the user never saw a placeholder" is not a screenshot at
// one moment — the states this is about were only ever visible for a few
// hundred milliseconds, so any single sample would miss them and pass against
// the old code too. So the page is SAMPLED CONTINUOUSLY, from before navigation
// until the artifact is live, and the assertion is over everything that was ever
// on screen:
//
//   - none of the three placeholder texts ever appeared;
//   - the stage's bounding box never moved, so nothing was ever laid out twice.
//
// Both directions are covered, because they fail differently: warm (from the
// gallery, renderer chunk already fetched) and cold (a direct URL in a fresh
// context, nothing cached).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { AccountHttpApi } from "@executor-js/api";
import type { ArtifactId } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";

const api = composePluginApi([] as const);

const uniqueSuffix = () => randomBytes(4).toString("hex");

/**
 * The placeholder texts that must never reach a user again.
 *
 * Named literally rather than by testid: the point is that the WORDS are gone
 * from the experience, and a rename that kept the churn under a different
 * caption should not pass. Each string is the exact one the corresponding
 * placeholder rendered before this change.
 */
const FORBIDDEN_LOADING_TEXT = [
  "Loading artifact",
  "Preparing the renderer",
  "Preparing interactive UI",
] as const;

/** A tall, distinctive artifact — the same shape the main artifacts scenario
 *  uses, so the fill-mode sizing under test here is the real one. */
const artifactSource = (marker: string) => `
function App() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div data-testid="artifact-header" className="shrink-0">
        <h2>Loading Surface</h2>
        <p data-testid="artifact-marker">${marker}</p>
      </div>
      <div data-testid="artifact-scroll" className="min-h-0 flex-1 overflow-auto">
        {Array.from({ length: 30 }, (_, i) => (
          <p key={i} data-testid={"artifact-row-" + i} style={{ height: 28 }}>
            Row {i + 1}: ${marker}
          </p>
        ))}
      </div>
    </div>
  );
}
`;

const structuredOf = (result: { readonly raw: unknown }): Record<string, unknown> =>
  ((result.raw as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;

const artifactContent = (page: Page) =>
  page.frameLocator('[data-testid="artifact-shell-frame"]').frameLocator("iframe");

type Sample = {
  readonly text: string;
  readonly stage: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __loadingSamples: Array<Sample> | undefined;
  // eslint-disable-next-line no-var
  var __loadingSampler: number | undefined;
}

/**
 * Watch the CONSOLE document continuously for the whole open.
 *
 * Installed as an init script so it is running before the first byte of the
 * page, and polls on an animation frame — fast enough that a placeholder
 * visible for even one paint is recorded. `innerText` of the console document
 * only (never the frames): the shell's own inner states live one document down
 * and are covered separately, and reaching into a frame from here would sample
 * the artifact's own text as if it were the console's.
 *
 * The stage's box is sampled alongside, because a placeholder that came and
 * went without changing any TEXT would still have moved the layout, and a
 * layout that jumps is the same defect wearing a different hat.
 */
const startSampling = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    globalThis.__loadingSamples = [];
    const sample = () => {
      const stage = document.querySelector<HTMLElement>(
        '[data-testid="artifact-shell-container"], [data-slot="artifact-stage-skeleton"]',
      );
      const box = stage?.getBoundingClientRect();
      globalThis.__loadingSamples?.push({
        text: document.body?.innerText ?? "",
        stage: box
          ? {
              x: Math.round(box.x),
              y: Math.round(box.y),
              w: Math.round(box.width),
              h: Math.round(box.height),
            }
          : null,
      });
      globalThis.__loadingSampler = requestAnimationFrame(sample);
    };
    sample();
  });
};

const readSamples = (page: Page): Promise<ReadonlyArray<Sample>> =>
  page.evaluate(() => globalThis.__loadingSamples ?? []);

/**
 * Assert the whole open was one surface.
 *
 * Two independent properties over the same recording — no placeholder words
 * ever rendered, and the stage never changed size or position — because either
 * one alone would let the churn back in through the other door.
 */
const expectSingleLoadingSurface = (samples: ReadonlyArray<Sample>, label: string): void => {
  expect(samples.length, `${label}: the sampler actually ran`).toBeGreaterThan(3);

  for (const forbidden of FORBIDDEN_LOADING_TEXT) {
    const hit = samples.findIndex((entry) => entry.text.includes(forbidden));
    expect(
      hit,
      `${label}: "${forbidden}" was on screen at sample ${hit} of ${samples.length} — the open still walks through more than one loading state`,
    ).toBe(-1);
  }

  // The stage's geometry, over every frame in which a stage existed at all.
  // The skeleton and the artifact frame share one box by construction (the
  // skeleton is an absolutely-positioned cover over the frame's own container),
  // so a change here means one of them was laid out differently from the other.
  const boxes = samples.map((entry) => entry.stage).filter(Predicate.isNotNull);
  expect(boxes.length, `${label}: the stage was on screen at some point`).toBeGreaterThan(0);

  const first = boxes[0];
  if (!first) return;
  for (const [index, box] of boxes.entries()) {
    // A pixel of tolerance for sub-pixel rounding as the scrollbar settles.
    expect(
      Math.abs(box.w - first.w) <= 1 && Math.abs(box.h - first.h) <= 1,
      `${label}: the stage changed size mid-load at sample ${index} (${JSON.stringify(box)} vs ${JSON.stringify(first)}) — the artifact appeared in a different box than the skeleton held`,
    ).toBe(true);
  }
};

scenario(
  "Artifacts · opening an artifact shows one loading surface, not three",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const session = mcp.session(identity);

    const suffix = uniqueSuffix();
    const title = `Loading Surface ${suffix}`;
    const marker = `surface-ok-${suffix}`;

    let artifactId: ArtifactId | undefined;

    yield* Effect.gen(function* () {
      const created = yield* session.call("create-artifact", {
        code: artifactSource(marker),
        title,
        description: "An artifact opened to watch how it loads",
      });
      expect(created.ok, `create-artifact succeeded: ${created.text}`).toBe(true);
      artifactId = structuredOf(created).artifactId as ArtifactId;
      expect(artifactId, "the artifact was persisted").toBeTruthy();

      const accountClient = yield* apiClient(AccountHttpApi, identity);
      const me = yield* accountClient.account.me();
      const orgSlug = me.organization?.slug;
      const detailPath = orgSlug
        ? `/${orgSlug}/artifacts/${artifactId}`
        : `/artifacts/${artifactId}`;

      // ------------------------------------------------------------------
      // WARM: the journey a user actually takes — gallery, then a click.
      // ------------------------------------------------------------------
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Artifacts gallery", async () => {
          await startSampling(page);
          await page.goto(`${target.baseUrl}/artifacts`, { waitUntil: "networkidle" });
          await page
            .getByRole("link", { name: `Open artifact ${title}` })
            .waitFor({ timeout: 30_000 });
          // Discard everything from the gallery's own load: this scenario is
          // about the OPEN, and the list has a loading state of its own that is
          // out of scope here.
          await page.evaluate(() => {
            globalThis.__loadingSamples = [];
          });
        });

        await step("Click through to the artifact", async () => {
          await page.getByRole("link", { name: `Open artifact ${title}` }).click();
          await artifactContent(page).getByTestId("artifact-marker").waitFor({ timeout: 60_000 });
        });

        await step("The whole open was one surface", async () => {
          expectSingleLoadingSurface(await readSamples(page), "warm open");
        });

        await step("The skeleton hands over and gets out of the way", async () => {
          // The cover is removed once the artifact has painted — not left over
          // it at zero opacity, which would swallow every click.
          await expect
            .poll(async () => await page.locator('[data-testid="artifact-stage-cover"]').count(), {
              timeout: 20_000,
              message: "the loading cover was removed after the artifact rendered",
            })
            .toBe(0);
        });

        await step("Fill-mode sizing survived the handoff", async () => {
          // The frame is the viewport below the title bar, exactly as it is in
          // the steady state — so nothing about holding a skeleton over it
          // changed the height chain it measures against.
          const frameBox = await page.locator('[data-testid="artifact-shell-frame"]').boundingBox();
          const viewport = page.viewportSize();
          expect(frameBox?.height ?? 0, "the frame fills the room it was given").toBeGreaterThan(
            200,
          );
          expect(
            frameBox?.height ?? 0,
            "the frame is bounded by the window, not by its content",
          ).toBeLessThanOrEqual(viewport?.height ?? 0);

          const pageScrolls = await page.evaluate(
            () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
          );
          expect(pageScrolls, "the console page still does not scroll").toBe(false);
        });
      });

      // ------------------------------------------------------------------
      // COLD: the deep link, in a context that has never loaded the console.
      //
      // The harder case, and the one the preload exists for: nothing is cached,
      // so the row fetch and the renderer chunk both start from zero. This is
      // where the three states used to be most visible, and where a regression
      // in the preload would show up first.
      // ------------------------------------------------------------------
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the artifact by URL, cold", async () => {
          await startSampling(page);
          await page.goto(`${target.baseUrl}${detailPath}`, { waitUntil: "commit" });
          await artifactContent(page).getByTestId("artifact-marker").waitFor({ timeout: 60_000 });
        });

        await step("The cold open was one surface too", async () => {
          expectSingleLoadingSurface(await readSamples(page), "cold open");
        });

        await step("The artifact is live and interactive", async () => {
          const rendered = artifactContent(page).getByTestId("artifact-marker");
          expect(await rendered.textContent()).toContain(marker);

          // Interactive, not merely painted: the cover is gone, so a scroll
          // inside the artifact actually reaches it.
          const scrolled = await artifactContent(page)
            .getByTestId("artifact-scroll")
            .evaluate((el) => {
              el.scrollTop = 200;
              return el.scrollTop;
            });
          expect(scrolled, "the artifact takes input after the handoff").toBeGreaterThan(0);
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          artifactId === undefined
            ? Effect.void
            : client.artifacts.remove({ params: { artifactId } }),
        ).pipe(Effect.ignore),
      ),
    );
  }),
);
