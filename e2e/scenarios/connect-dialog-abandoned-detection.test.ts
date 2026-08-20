import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { clickToReveal, visit } from "../src/surfaces/browser";

const DETECT_ROUTE = "**/integrations/detect";

const DETECTED_OPENAPI = JSON.stringify([
  {
    kind: "openapi",
    confidence: "high",
    endpoint: "https://example.com/openapi.json",
    name: "Example",
    slug: "example",
  },
]);

// The connect dialog owns in-flight work: pasting a URL asks the server to
// detect what it is. Closing the dialog is the user withdrawing that question,
// so the answer has to land nowhere — not as an error banner waiting in the
// next open, and above all not as a navigation that moves the app under them.
scenario(
  "Connect dialog · a detection the user walked away from lands nowhere",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      const dialog = page.getByRole("dialog", { name: "Connect an integration" });
      const connect = page.getByRole("button", { name: "Connect" });
      const search = () => dialog.getByPlaceholder(/Search or paste a URL/);
      const catalog = () => dialog.getByRole("button", { name: /^Google\b.*services$/s });
      const detectError = dialog.getByText(/Detection failed|Could not detect/);

      /** Paste a URL, start detecting, and abandon the dialog mid-flight.
       *  Resolves the held request with `body` and waits for it to land. */
      const abandonDetection = async (status: number, body: string) => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route(DETECT_ROUTE, async (route) => {
          await held;
          await route.fulfill({ status, contentType: "application/json", body });
        });

        await search().fill("https://example.com/openapi.json");
        await dialog.getByRole("button", { name: "Detect" }).click();
        await dialog.getByRole("button", { name: "Detecting..." }).waitFor();

        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        const answered = page.waitForResponse(DETECT_ROUTE);
        release();
        await answered;
        await page.unroute(DETECT_ROUTE);
      };

      await step("Open the connect picker", async () => {
        await visit(page, "/integrations");
        await clickToReveal(connect, dialog);
        await catalog().waitFor();
      });

      await step("Abandon a detection, then let it fail", async () => {
        await abandonDetection(500, JSON.stringify({ _tag: "InternalError" }));
      });

      await step("Reopening offers a clean dialog, not the abandoned failure", async () => {
        await clickToReveal(connect, dialog);
        await catalog().waitFor();
        expect(await detectError.count(), "the abandoned failure is not waiting here").toBe(0);
        expect(await search().inputValue()).toBe("");
      });

      await step("Abandon a second detection, then let it succeed", async () => {
        await abandonDetection(200, DETECTED_OPENAPI);
      });

      await step("The successful answer does not steer the app to an add flow", async () => {
        expect(page.url(), "a withdrawn detection must not navigate").not.toMatch(
          /\/integrations\/add\//,
        );
        // Reopening is the settle point: if the abandoned detection had steered
        // the app, this page (and its Connect button) would already be gone.
        await clickToReveal(connect, dialog);
        await catalog().waitFor();
        expect(page.url()).not.toMatch(/\/integrations\/add\//);
      });
    });
  }),
);
