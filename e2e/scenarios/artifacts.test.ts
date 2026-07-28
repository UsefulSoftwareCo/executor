// Cross-target: the artifacts journey, end to end.
//
// An agent on a client that cannot display MCP Apps calls `render-ui`. The
// product promise under test is vision.md's delivery negotiation: the model
// behaves identically either way, and only DELIVERY changes — a client without
// MCP Apps gets a deep link into the web app instead of an embedded widget.
// Persistence is what makes that possible, so the same artifact must then be
// reachable three ways: the deep link, the Artifacts tab, and back through MCP
// by title.
//
// Two scenarios, split by what they prove:
//   1. render-ui saves + delivers a working deep link, and the page renders
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
 * The component `render-ui` persists.
 *
 * It must declare none of the ~280 globals the shell puts in scope (`Card`,
 * `useState`, …) or the server's guard rejects it before it is ever saved, and
 * its rendered text must be distinctive enough to assert on inside the shell's
 * nested sandbox iframe.
 *
 * It is also deliberately TALL — 40 rows, well past the frame's initial height.
 * The shell reports its content height over the MCP-Apps resize protocol and the
 * artifact page, as host, grows the iframe to match. When the shell was mounted
 * inline there was no host to consume those notifications and tall artifacts
 * clipped mid-viewport, so the last row is what proves the frame grew.
 */
const ARTIFACT_ROW_COUNT = 40;

const artifactSource = (marker: string) => `
function App() {
  return (
    <div>
      <h2>Release Readiness</h2>
      <p data-testid="artifact-marker">${marker}</p>
      {Array.from({ length: ${ARTIFACT_ROW_COUNT} }, (_, i) => (
        <p key={i} data-testid={"artifact-row-" + i} style={{ height: 28 }}>
          Check {i + 1}: ${marker}
        </p>
      ))}
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
  "Artifacts · render-ui hands a non-Apps client a deep link that renders the live component",
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
      expect(tools, "render-ui is advertised regardless of MCP-Apps support").toContain(
        "render-ui",
      );

      const rendered = yield* session.call("render-ui", {
        code: artifactSource(marker),
        title,
        description: "Whether the current release is ready to ship",
      });

      expect(rendered.ok, `render-ui succeeded: ${rendered.text}`).toBe(true);

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

      // The link must point at THIS deployment and at the artifact's own page —
      // a bare `/artifacts/:id`, which the console canonicalizes onto the
      // active org slug after landing.
      const parsed = new URL(url);
      expect(parsed.origin, `the deep link targets this deployment (${url})`).toBe(
        new URL(target.baseUrl).origin,
      );
      expect(parsed.pathname, `the deep link addresses the artifact (${url})`).toBe(
        `/artifacts/${artifactId}`,
      );

      // The org the console will canonicalize to, so the landing URL can be
      // asserted rather than guessed.
      const accountClient = yield* apiClient(AccountHttpApi, identity);
      const me = yield* accountClient.account.me();
      const orgSlug = me.organization?.slug;

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
            // A bare deep link canonicalizes onto the active org in place,
            // keeping the path — the artifact must not be lost in the rewrite.
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

        await step("A tall artifact is fully visible, not clipped", async () => {
          // The shell reports content height; the page, as host, grows the
          // iframe. Inline there was no host to consume those notifications, so
          // the frame stayed at its initial height and tall artifacts were cut
          // off. The LAST row is the one that only exists if the frame grew.
          const lastRow = artifactContent(page).getByTestId(
            `artifact-row-${ARTIFACT_ROW_COUNT - 1}`,
          );
          await lastRow.waitFor({ timeout: 30_000 });

          const frame = page.locator('[data-testid="artifact-shell-frame"]');
          const frameBox = await frame.boundingBox();
          expect(frameBox, "the artifact frame is laid out").not.toBeNull();
          // 40 rows at 28px plus the shell's own chrome cannot fit in the
          // 320px the frame starts at; anything near that means no resize.
          expect(
            frameBox?.height ?? 0,
            "the host grew the iframe past its initial height",
          ).toBeGreaterThan(600);

          // And the row itself is rendered with real extent inside it, rather
          // than laid out beyond a clipped frame.
          const rowBox = await lastRow.boundingBox();
          expect(rowBox?.height ?? 0, "the last row has real layout extent").toBeGreaterThan(0);
        });

        await step("The artifact is listed on the Artifacts tab", async () => {
          await page.getByRole("link", { name: "Artifacts" }).first().click();
          await page.getByRole("heading", { name: "Artifacts", level: 1 }).waitFor();
          await page.getByRole("link", { name: `Open artifact ${title}` }).waitFor({
            timeout: 20_000,
          });
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
      const rendered = yield* session.call("render-ui", {
        code: artifactSource(`rename-${suffix}`),
        title: originalTitle,
        description: "A dashboard the user will rename",
      });
      expect(rendered.ok, `render-ui succeeded: ${rendered.text}`).toBe(true);
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
          // Row actions reveal on hover; the row is the link's enclosing entry.
          const row = page.locator('[data-slot="card-stack-entry"]').filter({
            hasText: originalTitle,
          });
          await row.hover();
          await row.getByRole("button", { name: "Rename" }).click();

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
          const row = page.locator('[data-slot="card-stack-entry"]').filter({
            hasText: renamedTitle,
          });
          await row.waitFor({ timeout: 20_000 });
          await row.hover();
          await row.getByRole("button", { name: "Delete" }).click();

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
