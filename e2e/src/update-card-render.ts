// Shared body for the per-host "the update card renders" browser scenarios
// (selfhost + selfhost-docker + cloudflare). Each host serves the same web
// shell, so the only thing worth proving per host is that the card actually
// paints on THAT deployment's real, served UI. The published-version signal is
// forced with a Playwright route mock so the screenshot is deterministic and
// offline (reachability of the real `/v1/app/npm/dist-tags` route is pinned
// separately by the `update-endpoint` scenarios).
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "./scenario";
import { Browser, Target } from "./services";

export const FORCED_LATEST = "99.0.0";

export const registerUpdateCardRenderScenario = (name: string): void =>
  scenario(
    name,
    { timeout: 120_000 },
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        // Force a newer published version regardless of the registry, so the
        // card is deterministic on this host's real UI.
        await page.route("**/v1/app/npm/dist-tags", (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ latest: FORCED_LATEST, beta: `${FORCED_LATEST}-beta.1` }),
          }),
        );

        await step("Open the console", async () => {
          await page.goto("/", { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "Integrations" }).waitFor({ timeout: 60_000 });
        });

        await step("The sidebar surfaces the update-available card", async () => {
          await page.getByText("Update available").waitFor({ timeout: 30_000 });
          await page.getByText(`v${FORCED_LATEST}`).waitFor({ timeout: 5_000 });
          // Self-host and Cloudflare upgrade via their own deploy (image pull /
          // rebuild / redeploy), not npm: the card links to the host's upgrade
          // guide and shows NO npm command.
          const guide = page.getByRole("link", { name: "Upgrade guide" });
          await guide.waitFor({ timeout: 5_000 });
          expect(await guide.getAttribute("href"), "links to the hosted upgrade docs").toContain(
            "/docs/hosted/",
          );
          expect(
            await page.getByText("npm i -g", { exact: false }).count(),
            "the self-host / Cloudflare card shows no npm command",
          ).toBe(0);
        });
      });
    }),
  );

// Regression for the "card always shows on Docker even on the latest version"
// report: a placeholder build version (0.0.0-selfhost / 0.0.0-cloudflare) made
// the comparison permanently "behind". With the real version baked in, a
// published version that is NOT newer must leave the card hidden, and the
// sidebar footer must show the running version (the other half of the report).
export const registerUpdateCardCurrentScenario = (name: string): void =>
  scenario(
    name,
    { timeout: 120_000 },
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        // Report a published version OLDER than this build, i.e. the build is
        // current. With the placeholder version this still showed the card.
        await page.route("**/v1/app/npm/dist-tags", (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ latest: "0.0.1", beta: "0.0.1-beta.1" }),
          }),
        );

        await step("Open the console", async () => {
          await page.goto("/", { waitUntil: "networkidle" });
          await page.getByRole("heading", { name: "Integrations" }).waitFor({ timeout: 60_000 });
        });

        await step("No update card, and the footer shows the running version", async () => {
          // The footer version proves the build injects a real semver, not a
          // placeholder, which is what makes the comparison correct.
          const version = page
            .locator("aside")
            .getByText(/^v\d+\.\d+\.\d+/)
            .first();
          await version.waitFor({ timeout: 10_000 });
          // The mocked update check resolves on mount; give the state a beat to
          // settle, then assert the card stayed hidden.
          await page.waitForTimeout(750);
          expect(
            await page.getByText("Update available").count(),
            "no update card when the build is current",
          ).toBe(0);
        });
      });
    }),
  );
