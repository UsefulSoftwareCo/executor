// Cross-target: the artifacts journey, end to end.
//
// An agent on a client that cannot display MCP Apps calls `create-artifact`. The
// product promise under test is vision.md's delivery negotiation: the model
// behaves identically either way, and only DELIVERY changes — a client without
// MCP Apps gets a deep link into the web app instead of an embedded widget.
// Persistence is what makes that possible, so the same artifact must then be
// reachable three ways: the deep link, the Artifacts tab, and back through MCP
// by title.
//
// Two scenarios, split by what they prove:
//   1. create-artifact saves + delivers a working deep link, and the page renders
//      the component live (the fallback path a non-Apps client actually walks).
//   2. Rename and delete in the console are what MCP reads back afterwards
//      (the console and the agent share one store, not two caches).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { AccountHttpApi } from "@executor-js/api";
import type { ArtifactId } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";

const api = composePluginApi([] as const);

/**
 * The component `create-artifact` persists.
 *
 * It must declare none of the ~280 globals the shell puts in scope (`Card`,
 * `useState`, …) or the server's guard rejects it before it is ever saved, and
 * its rendered text must be distinctive enough to assert on inside the shell's
 * nested sandbox iframe.
 *
 * It is purely declarative, which is now the whole contract rather than a
 * stylistic choice: there is no `run()` in scope, and code that calls one is
 * rejected before it is saved. Rows come from `Array.from`, a display constant —
 * an artifact that needed live data would reach for
 * `useQuery(tools.<integration>.<tool>.queryOptions(...))`.
 *
 * It is also deliberately TALL — 40 rows at 28px, far more than fits on the
 * detail page — and laid out the way the `artifact-style` skill teaches: a
 * bounded flex column whose header stays put while one region scrolls. That is
 * what the detail page's fill mode exists to support, and what the steps below
 * assert: the frame is the viewport, the page itself does not scroll, and the
 * heading is still on screen after the rows have been scrolled.
 */
const ARTIFACT_ROW_COUNT = 40;

const artifactSource = (marker: string) => `
function App() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div data-testid="artifact-header" className="shrink-0">
        <h2>Release Readiness</h2>
        <p data-testid="artifact-marker">${marker}</p>
      </div>
      <div data-testid="artifact-scroll" className="min-h-0 flex-1 overflow-auto">
        {Array.from({ length: ${ARTIFACT_ROW_COUNT} }, (_, i) => (
          <p key={i} data-testid={"artifact-row-" + i} style={{ height: 28 }}>
            Check {i + 1}: ${marker}
          </p>
        ))}
      </div>
    </div>
  );
}
`;

/** Selfhost shares one workspace across scenarios, so every title is unique to
 *  this run and assertions look for "mine", never "the only one". */
const uniqueSuffix = () => randomBytes(4).toString("hex");

const structuredOf = (result: { readonly raw: unknown }): Record<string, unknown> =>
  ((result.raw as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;

/**
 * The generated component, two frames down.
 *
 * The artifact page hosts the shell DOCUMENT in a sandboxed iframe and speaks
 * the MCP-Apps protocol to it — the same way any MCP-Apps client loads
 * `ui://executor/shell.html`. The shell then compiles the stored JSX into its
 * own nested sandbox. Both hops are load-bearing, so tests descend through both.
 */
const artifactContent = (page: Page) =>
  page.frameLocator('[data-testid="artifact-shell-frame"]').frameLocator("iframe");

/**
 * A fingerprint of the CONSOLE document's styling.
 *
 * The shell ships its own Tailwind build and its own palette; the console's is
 * strictly grayscale. Sampling a token, a real rendered control, and the
 * stylesheet count catches the leak whether it arrives as a `<style>` element,
 * a variable override, or the runtime Tailwind JIT mutating the page.
 */
/**
 * Record, for every `window.addEventListener("message", …)` the CONSOLE document
 * makes, what the shell frame's document was at that instant.
 *
 * This is the handshake's ordering invariant made observable. `ui/initialize` is
 * posted once by the app with no retry, ext-apps buffers nothing, and the host
 * only starts listening inside `AppBridge.connect()` — so if the host registers
 * after the shell's scripts have run, the message is lost and both sides wait
 * forever on "Connecting".
 *
 * The host must therefore be listening while the frame is still its initial
 * `about:blank` document, before the shell document exists to run anything. That
 * is a property of WHERE the host connects, not of how fast the machine is:
 * connecting on the frame's `load` event cannot satisfy it (load fires only once
 * the document is complete), while connecting on the element's ref always does.
 *
 * Must be installed before any navigation.
 */
declare global {
  // eslint-disable-next-line no-var
  var __handshakeOrder: Array<string> | undefined;
}

const recordHandshakeOrdering = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    globalThis.__handshakeOrder = [];
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === "message" && this === window) {
        const frame = document.querySelector<HTMLIFrameElement>(
          '[data-testid="artifact-shell-frame"]',
        );
        // No frame yet is even earlier than about:blank, so it satisfies the
        // invariant too; "(none)" keeps that case distinguishable in a failure.
        globalThis.__handshakeOrder?.push(
          frame ? (frame.contentDocument?.URL ?? "(no document)") : "(none)",
        );
      }
      return original.call(this, type, listener, options as never);
    };
  });
};

const readHandshakeOrdering = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => globalThis.__handshakeOrder ?? []);

const readConsoleStyle = (
  page: Page,
): Promise<{ primary: string; buttonBg: string; styleSheets: number }> =>
  page.evaluate(() => {
    const button = document.querySelector("button");
    return {
      primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
      buttonBg: button ? getComputedStyle(button).backgroundColor : "",
      styleSheets: document.styleSheets.length,
    };
  });

scenario(
  "Artifacts · create-artifact hands a non-Apps client a deep link that renders the live component",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const session = mcp.session(identity);

    const suffix = uniqueSuffix();
    const title = `Release Readiness ${suffix}`;
    const marker = `artifact-ok-${suffix}`;

    // Tracked so cleanup runs even when an assertion below fails.
    let artifactId: ArtifactId | undefined;

    yield* Effect.gen(function* () {
      // `mcp.session` advertises no MCP-Apps capability — which is exactly the
      // client under test here, so no capability juggling is needed.
      const tools = yield* session.listTools();
      expect(tools, "create-artifact is advertised regardless of MCP-Apps support").toContain(
        "create-artifact",
      );

      // Artifact code is purely declarative `tools.*`. The `run()` escape hatch
      // is gone from the shell scope, so a model reaching for it — which is
      // exactly what one did to hand-roll a pagination loop — is turned around
      // here, with the declarative replacement named, rather than saving an
      // artifact that would die with a ReferenceError inside the iframe.
      const refused = yield* session.call("create-artifact", {
        code: `function App(){ const q = useQuery({ queryKey: ["x"], queryFn: () => run("return await tools.a.b({})") }); return null; }`,
        title: `Rejected ${suffix}`,
        description: "Should never be saved",
      });
      expect(refused.ok, "create-artifact refuses code that calls run()").toBe(false);
      expect(refused.text, "the model is told what to use instead").toContain(
        "infiniteQueryOptions",
      );

      const rendered = yield* session.call("create-artifact", {
        code: artifactSource(marker),
        title,
        description: "Whether the current release is ready to ship",
      });

      expect(rendered.ok, `create-artifact succeeded: ${rendered.text}`).toBe(true);

      const structured = structuredOf(rendered);
      // `fallback_unavailable` here would mean the host has no webBaseUrl
      // wired — a mis-wired deployment, not a passing test.
      expect(
        structured.status,
        `a non-Apps client gets a deep link, not an embedded widget: ${JSON.stringify(structured)}`,
      ).toBe("fallback_url");

      artifactId = structured.artifactId as ArtifactId;
      expect(artifactId, "the artifact was persisted and its id returned").toBeTruthy();

      const url = String(structured.url);
      expect(rendered.text, "the model is handed the URL to relay to the user").toContain(url);

      // The org this identity is bound to. Org-scoped hosts (cloud, self-host)
      // advertise a slug; local is unscoped and advertises none.
      const accountClient = yield* apiClient(AccountHttpApi, identity);
      const me = yield* accountClient.account.me();
      const orgSlug = me.organization?.slug;

      // The link must point at THIS deployment, at the artifact's own page, and
      // — this is the part that bit us — inside the right org. A bare
      // `/artifacts/:id` on an org-scoped host is resolved against whatever org
      // the browser was last in, so the emitted URL names the org itself.
      const parsed = new URL(url);
      expect(parsed.origin, `the deep link targets this deployment (${url})`).toBe(
        new URL(target.baseUrl).origin,
      );
      expect(parsed.pathname, `the deep link addresses the artifact (${url})`).toBe(
        orgSlug ? `/${orgSlug}/artifacts/${artifactId}` : `/artifacts/${artifactId}`,
      );

      yield* browser.session(identity, async ({ page, step }) => {
        // The console's own styling, sampled BEFORE any artifact is opened.
        // The shell ships its own Tailwind build and its own palette (a teal
        // `--primary` against the console's near-black), so if its stylesheet
        // ever reaches the top-level document again these values move.
        let consoleStyleBefore: { primary: string; buttonBg: string; styleSheets: number };

        await step("Open the artifact link the agent handed over", async () => {
          await recordHandshakeOrdering(page);
          await page.goto(url, { waitUntil: "networkidle" });
          consoleStyleBefore = await readConsoleStyle(page);
        });

        await step("The artifact page is titled with the artifact's name", async () => {
          await page.getByRole("heading", { name: title }).waitFor({ timeout: 20_000 });
          if (orgSlug) {
            // The link arrives already org-scoped and must LAND in that scope:
            // the console neither strips the segment nor rewrites it onto some
            // other org, and the artifact survives the trip through auth.
            await page.waitForURL(`**/${orgSlug}/artifacts/${artifactId}`, { timeout: 20_000 });
          }
          // Landing straight on the deep link (no list visit first) must still
          // offer the management affordances and the way back to the list.
          await page.getByRole("button", { name: "Rename" }).waitFor();
          await page.getByRole("button", { name: "Delete" }).waitFor();
          await page.getByRole("button", { name: "Artifacts" }).waitFor();
        });

        await step("The saved component renders live inside the shell", async () => {
          // TWO frames deep, deliberately. The page hosts the shell DOCUMENT in
          // a sandboxed iframe and speaks the MCP-Apps protocol to it; the shell
          // in turn compiles the stored JSX into its own nested sandbox. Finding
          // the marker at the bottom of that chain proves the whole path — the
          // host bridge delivered the code, and the sandbox compiled and ran it.
          // An unscoped lookup would still pass if either frame collapsed.
          const rendered = artifactContent(page).getByTestId("artifact-marker");
          await rendered.waitFor({ timeout: 30_000 });
          expect(await rendered.textContent()).toContain(marker);

          // Stuck on "Connecting" must fail loudly rather than time out at some
          // later, more confusing assertion. The shell shows that word only
          // while `ui/initialize` is unanswered.
          const shellBody = page
            .frameLocator('[data-testid="artifact-shell-frame"]')
            .locator("body");
          await expect
            .poll(async () => await shellBody.innerText(), {
              timeout: 10_000,
              message: "the shell completed the handshake rather than sitting on Connecting",
            })
            .not.toContain("Connecting");
        });

        await step("The host was listening before the shell could speak", async () => {
          // The regression guard for the handshake race. Asserting only that the
          // artifact rendered is not enough: the previous implementation
          // connected on the frame's `load` event and still rendered on a warm,
          // fast machine, winning by ~5ms — while the user's browser lost the
          // same race and sat on "Connecting" forever.
          //
          // So assert the ORDERING rather than the outcome. Every listener the
          // console registers must be registered while the shell frame is still
          // `about:blank` (or before the frame exists at all) — never once the
          // shell document has been navigated to, which is precisely what
          // connecting on `load` would show here.
          // `about:blank` specifically, rather than "every listener was early":
          // it is the only value that pins the BRIDGE's registration. A listener
          // recorded before the frame exists at all could belong to any unrelated
          // console code, and one recorded afterwards may legitimately be some
          // later feature's — but a registration made while the shell frame is
          // mounted and still unnavigated can only be the host attaching to it.
          //
          // Mutation-tested against the previous implementation, which connected
          // on `load` and recorded the shell document's URL here instead.
          const order = await readHandshakeOrdering(page);
          expect(
            order,
            `the host attached to the shell frame before it was navigated (saw ${JSON.stringify(order)})`,
          ).toContain("about:blank");
        });

        // ------------------------------------------------------------------
        // Regression guards for the two symptoms of mounting the shell inline.
        // ------------------------------------------------------------------

        await step("The shell's styles stay inside its own document", async () => {
          const after = await readConsoleStyle(page);

          // The console's design system is strictly grayscale. When the shell
          // was mounted inline, its stylesheet redefined `--primary` to a teal
          // and every button and avatar in the console picked it up — for the
          // rest of the session, on every page.
          expect(after.primary, "the console's --primary is untouched by the shell").toBe(
            consoleStyleBefore.primary,
          );
          expect(after.buttonBg, "a console button keeps its own background").toBe(
            consoleStyleBefore.buttonBg,
          );
          expect(
            after.styleSheets,
            "the shell injected no stylesheet into the console document",
          ).toBe(consoleStyleBefore.styleSheets);

          // And positively: the shell's stylesheet IS present, one document
          // down. Without this the assertions above would also pass if the
          // shell had simply failed to load.
          const shellHasOwnStyles = await page
            .frameLocator('[data-testid="artifact-shell-frame"]')
            .locator("html")
            .evaluate((html) => {
              const primary = getComputedStyle(html).getPropertyValue("--primary").trim();
              return { primary, sheets: html.ownerDocument.styleSheets.length };
            });
          expect(
            shellHasOwnStyles.sheets,
            "the shell document carries its own stylesheets",
          ).toBeGreaterThan(0);
          expect(
            shellHasOwnStyles.primary,
            "the shell keeps its own palette inside its own document",
          ).not.toBe("");
        });

        await step("The artifact fills the page and scrolls inside itself", async () => {
          // A tall artifact on its own page is an APP, not a document: the page
          // hands it the viewport below the title bar and holds it there, and
          // the artifact scrolls its own rows under its own header.
          //
          // Before fill mode the shell only ever grew to content, so this page
          // scrolled instead — and a user filtering a long table watched its
          // heading and search box disappear off the top of the screen.
          const lastRow = artifactContent(page).getByTestId(
            `artifact-row-${ARTIFACT_ROW_COUNT - 1}`,
          );
          await lastRow.waitFor({ timeout: 30_000 });

          const frame = page.locator('[data-testid="artifact-shell-frame"]');
          const frameBox = await frame.boundingBox();
          expect(frameBox, "the artifact frame is laid out").not.toBeNull();

          // The frame is the viewport below the title bar, not the content's
          // height. 40 rows at 28px is over 1100px of content, so a frame that
          // still matched its content would be far taller than the window.
          const viewport = page.viewportSize();
          expect(viewport, "the browser reports a viewport").not.toBeNull();
          expect(
            frameBox?.height ?? 0,
            "the frame is bounded by the window, not by its content",
          ).toBeLessThanOrEqual(viewport?.height ?? 0);
          expect(frameBox?.height ?? 0, "the frame fills the space it was given").toBeGreaterThan(
            200,
          );

          // The CONSOLE page does not scroll — that is the whole difference.
          const pageScrolls = await page.evaluate(
            () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
          );
          expect(pageScrolls, "the console page itself does not scroll").toBe(false);

          // The artifact's own region does, and its header stays put while it
          // happens. This is the user-visible symptom, asserted directly.
          const headerTopBefore = await artifactContent(page)
            .getByTestId("artifact-header")
            .evaluate((el) => el.getBoundingClientRect().top);

          const scrolled = await artifactContent(page)
            .getByTestId("artifact-scroll")
            .evaluate((el) => {
              el.scrollTop = 300;
              return { scrollTop: el.scrollTop, overflowing: el.scrollHeight > el.clientHeight };
            });
          expect(scrolled.overflowing, "the artifact's row region is a real scroll box").toBe(true);
          expect(scrolled.scrollTop, "the row region actually scrolled").toBeGreaterThan(0);

          const headerTopAfter = await artifactContent(page)
            .getByTestId("artifact-header")
            .evaluate((el) => el.getBoundingClientRect().top);
          expect(
            Math.abs(headerTopAfter - headerTopBefore),
            "the artifact's header stayed put while its rows scrolled",
          ).toBeLessThanOrEqual(1);
        });

        await step("The artifact is listed on the Artifacts tab", async () => {
          await page.getByRole("link", { name: "Artifacts" }).first().click();
          await page.getByRole("heading", { name: "Artifacts", level: 1 }).waitFor();
          await page.getByRole("link", { name: `Open artifact ${title}` }).waitFor({
            timeout: 20_000,
          });

          // The list is a preview gallery, not a row list: the card leads with a
          // preview that has real layout extent, and the grid lays cards out in
          // columns rather than stacking them full-width. Asserting the computed
          // column count (rather than a class name) is what actually proves the
          // user-visible shape at this viewport.
          const card = page.locator('[data-slot="artifact-card"]').filter({ hasText: title });
          const preview = card.locator('[data-slot="artifact-preview"]');
          await preview.waitFor({ timeout: 20_000 });
          const previewBox = await preview.boundingBox();
          expect(previewBox?.height ?? 0, "the card's preview has layout extent").toBeGreaterThan(
            80,
          );

          // And it is the artifact's REAL layout, not the id-seeded schematic.
          // The smoke render that validated this code at create time also
          // produced its loading-state markup, which is what the card draws —
          // so the artifact's own heading is present in the card itself.
          expect(
            await preview.getAttribute("data-preview-kind"),
            "the card shows the captured layout rather than the fallback schematic",
          ).toBe("layout");
          await expect
            .poll(async () => await preview.innerText(), {
              timeout: 10_000,
              message: "the preview carries the artifact's own rendered content",
            })
            .toContain("Release Readiness");

          // The preview is inert by construction: nothing in it may be clicked,
          // focused or read out, because it is a picture of a UI and not the UI.
          const inert = await preview.evaluate((node) => ({
            pointerEvents: globalThis.getComputedStyle(node).pointerEvents,
            hidden: node.getAttribute("aria-hidden"),
            scripts: node.querySelectorAll("script, iframe, img, form, button, a").length,
          }));
          expect(inert.pointerEvents, "the preview cannot be interacted with").toBe("none");
          expect(inert.hidden, "the preview is hidden from assistive technology").toBe("true");
          expect(
            inert.scripts,
            "the sanitizer left no script, frame, image, form or interactive element",
          ).toBe(0);

          const columns = await page.locator('[data-slot="artifact-grid"]').evaluate(
            (grid) =>
              globalThis
                .getComputedStyle(grid)
                .gridTemplateColumns.split(" ")
                .filter((track) => track.length > 0).length,
          );
          expect(columns, "the gallery lays out three cards per row when wide").toBe(3);
        });

        await step("Opening the artifact upgrades its card to the settled render", async () => {
          // The second layer. The create-time preview is the artifact's LOADING
          // state — it is captured with a transport that never settles, so it
          // has no data in it. Opening the artifact renders it for real, and
          // once that render goes quiet the shell hands the settled markup back
          // and the console stores it in place of the loading one.
          //
          // The observable difference is the DATA: this artifact's rows only
          // exist in a settled render, so finding one on the card proves the
          // upgrade landed rather than just that some preview exists.
          await page.getByRole("link", { name: `Open artifact ${title}` }).click();
          await artifactContent(page).getByTestId("artifact-marker").waitFor({ timeout: 30_000 });

          const card = page.locator('[data-slot="artifact-card"]').filter({ hasText: title });
          const preview = card.locator('[data-slot="artifact-preview"]');
          // Polled rather than slept on: the capture is debounced behind a
          // settle window, so the honest assertion is that it arrives, not when.
          await expect
            .poll(
              async () => {
                await page.getByRole("link", { name: "Artifacts" }).first().click();
                await card.waitFor({ timeout: 20_000 });
                return await preview.innerText();
              },
              {
                timeout: 90_000,
                interval: 3_000,
                message: "the settled render replaced the loading-state preview",
              },
            )
            .toContain(marker);

          expect(
            await preview.getAttribute("data-preview-kind"),
            "the upgraded preview is still rendered as a captured layout",
          ).toBe("layout");
          const box = await preview.boundingBox();
          expect(box?.height ?? 0, "the upgraded preview has layout extent").toBeGreaterThan(80);
        });
      });

      // The same row, read back through the agent's own surface.
      const listed = yield* session.call("list-artifacts", {});
      expect(listed.text, "the agent can find the artifact by title").toContain(title);

      const shown = yield* session.call("show-artifact", { id: artifactId });
      expect(shown.ok, `show-artifact returned the artifact: ${shown.text}`).toBe(true);
      expect(
        String(structuredOf(shown).url ?? shown.text),
        "show-artifact delivers the same deep link for a non-Apps client",
      ).toContain(String(artifactId));
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

scenario(
  "Artifacts · renaming and deleting in the console is what the agent sees next",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const session = mcp.session(identity);

    const suffix = uniqueSuffix();
    const originalTitle = `Draft Dashboard ${suffix}`;
    const renamedTitle = `Quarterly Dashboard ${suffix}`;

    let artifactId: ArtifactId | undefined;

    yield* Effect.gen(function* () {
      const rendered = yield* session.call("create-artifact", {
        code: artifactSource(`rename-${suffix}`),
        title: originalTitle,
        description: "A dashboard the user will rename",
      });
      expect(rendered.ok, `create-artifact succeeded: ${rendered.text}`).toBe(true);
      artifactId = structuredOf(rendered).artifactId as ArtifactId;
      expect(artifactId, "the artifact was persisted").toBeTruthy();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Artifacts tab", async () => {
          await page.goto("/artifacts", { waitUntil: "networkidle" });
          await page.getByRole("link", { name: `Open artifact ${originalTitle}` }).waitFor({
            timeout: 20_000,
          });
        });

        await step("Rename the artifact to something askable", async () => {
          // Card actions reveal on hover; the card is the link's enclosing tile.
          const card = page.locator('[data-slot="artifact-card"]').filter({
            hasText: originalTitle,
          });
          await card.hover();
          await card.getByRole("button", { name: "Rename" }).click();

          const dialog = page.getByRole("dialog");
          await dialog.getByRole("heading", { name: "Rename Artifact" }).waitFor();
          await dialog.getByRole("textbox").fill(renamedTitle);
          await dialog.getByRole("button", { name: "Save Title" }).click();
          await dialog.waitFor({ state: "hidden", timeout: 20_000 });
        });

        await step("The list shows the new name", async () => {
          await page.getByRole("link", { name: `Open artifact ${renamedTitle}` }).waitFor({
            timeout: 20_000,
          });
        });
      });

      // The rename is what the agent now matches against — the promise that
      // "show me my quarterly dashboard" works after a rename in the console.
      const afterRename = yield* session.call("list-artifacts", {});
      expect(afterRename.text, "the agent sees the new title").toContain(renamedTitle);
      expect(afterRename.text, "the old title is gone from the agent's view").not.toContain(
        originalTitle,
      );

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Delete the artifact from the list", async () => {
          await page.goto("/artifacts", { waitUntil: "networkidle" });
          const card = page.locator('[data-slot="artifact-card"]').filter({
            hasText: renamedTitle,
          });
          await card.waitFor({ timeout: 20_000 });
          await card.hover();
          await card.getByRole("button", { name: "Delete" }).click();

          const confirm = page.getByRole("alertdialog");
          await confirm.getByRole("heading", { name: `Delete ${renamedTitle}?` }).waitFor();
          await confirm.getByRole("button", { name: "Delete Artifact" }).click();
          await confirm.waitFor({ state: "hidden", timeout: 20_000 });
        });

        await step("The artifact is gone from the list", async () => {
          await page
            .getByRole("link", { name: `Open artifact ${renamedTitle}` })
            .waitFor({ state: "detached", timeout: 20_000 });
        });
      });

      const afterDelete = yield* session.call("list-artifacts", {});
      expect(afterDelete.text, "the agent no longer offers the deleted artifact").not.toContain(
        renamedTitle,
      );

      const missing = yield* session.call("show-artifact", { id: artifactId });
      expect(missing.ok, "fetching a deleted artifact is an error, not an empty render").toBe(
        false,
      );
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

// The iteration loop: a user asks for a tweak, and the agent updates the
// artifact it already made rather than minting a second one. What makes this a
// product promise rather than an implementation detail is the LINK — whoever
// holds the artifact's URL sees the new version, because it is the same row.
//
// The same scenario also covers the create-time render check, because the two
// meet in the same place: a tweak that would not render must not be able to
// replace a version that does.
scenario(
  "Artifacts · a tweak updates the artifact in place, and a tweak that cannot render is refused",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const session = mcp.session(identity);

    const suffix = uniqueSuffix();
    const title = `Iterated Dashboard ${suffix}`;
    const firstMarker = `first-${suffix}`;
    const secondMarker = `second-${suffix}`;

    let artifactId: ArtifactId | undefined;

    yield* Effect.gen(function* () {
      const created = yield* session.call("create-artifact", {
        code: artifactSource(firstMarker),
        title,
        description: "A dashboard the agent will tweak",
      });
      expect(created.ok, `create-artifact succeeded: ${created.text}`).toBe(true);
      artifactId = structuredOf(created).artifactId as ArtifactId;
      expect(artifactId, "the artifact was persisted").toBeTruthy();

      // The tweak the model would actually write: fetch the current source,
      // edit it, send the whole component back under the same id.
      const shown = yield* session.call("show-artifact", { id: artifactId });
      expect(shown.ok, "the current source came back").toBe(true);

      const updated = yield* session.call("create-artifact", {
        code: artifactSource(secondMarker),
        artifactId,
      });
      expect(updated.ok, `the update succeeded: ${updated.text}`).toBe(true);
      expect(
        structuredOf(updated).artifactId,
        "an update keeps the artifact's id, so the user's link still resolves",
      ).toBe(artifactId);

      // One artifact, not two — the failure this feature exists to prevent.
      const listed = yield* session.call("list-artifacts", {});
      const occurrences = listed.text.split(title).length - 1;
      expect(occurrences, "the tweak did not mint a second artifact").toBe(1);

      yield* browser.session(identity, async ({ page, step }) => {
        await step("The artifact's own URL shows the updated component", async () => {
          await page.goto(`/artifacts/${artifactId}`, { waitUntil: "networkidle" });
          const content = artifactContent(page);
          await content
            .locator('[data-testid="artifact-marker"]')
            .filter({ hasText: secondMarker })
            .waitFor({ timeout: 30_000 });
          // And the version it replaced is gone, rather than both being present.
          const stale = await content
            .locator('[data-testid="artifact-marker"]')
            .filter({ hasText: firstMarker })
            .count();
          expect(stale, "the replaced version is not still on the page").toBe(0);
        });
      });

      // A tweak that would throw on its first render is refused, and — the part
      // that matters — the artifact the user is looking at is left alone.
      const broken = yield* session.call("create-artifact", {
        code: `
function App() {
  return (
    <BarChart data={[{ day: "Mon", n: 1 }]}>
      <ChartTooltip content={<ChartTooltipContent />} />
      <Bar dataKey="n" />
    </BarChart>
  );
}
`,
        artifactId,
      });
      expect(broken.ok, "a chart with no ChartContainer is refused").toBe(false);
      expect(broken.text, "the refusal names the wrapper the model must add").toContain(
        "ChartContainer",
      );

      // Read the row itself rather than `show-artifact`: this client cannot
      // display MCP Apps, so the tool hands back a deep link rather than source.
      const afterRefusal = yield* client.artifacts.get({ params: { artifactId } });
      expect(afterRefusal.code, "the stored source is still the version that rendered").toContain(
        secondMarker,
      );
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

// The opt-out. Artifacts are on by default, but a user who does not want
// generated UI can say so on the endpoint URL — `?artifacts=false` — and that
// connection gets no artifact surface at all: no artifact tools, and no
// artifact entries in the `skills` inventory to point a model at tools it does
// not have. The proof is comparative: two sessions, same identity, same server,
// differing only in that query.
scenario(
  "Artifacts · a session connected with artifacts=false sees no artifact surface",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const optedOut = mcp.session(identity, { artifacts: false });
    const defaultSession = mcp.session(identity);

    const ARTIFACT_TOOLS = [
      "create-artifact",
      "list-artifacts",
      "show-artifact",
      "execute-action",
      "execute-action-resume",
    ] as const;

    const optedOutTools = yield* optedOut.listTools();
    for (const tool of ARTIFACT_TOOLS) {
      expect(optedOutTools, `${tool} is withheld from an opted-out session`).not.toContain(tool);
    }
    // Only artifacts are withheld — the connection is otherwise a normal one.
    expect(optedOutTools, "execute still works on an opted-out session").toContain("execute");
    expect(optedOutTools, "skills still works on an opted-out session").toContain("skills");

    const optedOutSkills = yield* optedOut.call("skills", {});
    expect(optedOutSkills.ok, `the skills index came back: ${optedOutSkills.text}`).toBe(true);
    expect(optedOutSkills.text, "the index still offers the execute skill").toContain("`execute`");
    expect(
      optedOutSkills.text,
      "the index does not advertise a how-to for a tool this session lacks",
    ).not.toContain("`create-artifact`");
    expect(optedOutSkills.text, "nor the artifact style guide").not.toContain("`artifact-style`");

    // The control: the same identity against the same server, without the
    // query, still gets everything. Without this the assertions above would
    // also pass on a server that had simply lost artifacts.
    const defaultTools = yield* defaultSession.listTools();
    for (const tool of ["create-artifact", "list-artifacts", "show-artifact"] as const) {
      expect(defaultTools, `${tool} is present by default`).toContain(tool);
    }
    const defaultSkills = yield* defaultSession.call("skills", {});
    expect(defaultSkills.text, "the default index offers the create-artifact skill").toContain(
      "`create-artifact`",
    );
  }),
);
