// The sidebar "INTEGRATIONS" section heading used to be inert text. It is now a
// live link to the integrations page, and a plus button beside it opens the
// same Connect dialog the integrations page uses. This drives the browser path:
//   1. Land on a non-integrations route so navigation is observable.
//   2. Click the sidebar Integrations heading and assert we arrive on the
//      integrations page (its own "Integrations" <h1> renders).
//   3. Click the plus button and assert the "Connect an integration" dialog
//      opens, without leaving the current page.
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Sidebar · the Integrations heading links to the page and its plus button opens the Connect dialog",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the app on the Secrets route", async () => {
        await page.goto("/secrets", { waitUntil: "domcontentloaded" });
        await page.getByTestId("sidebar-integrations-heading").waitFor();
      });

      await step(
        "Clicking the sidebar Integrations heading opens the integrations page",
        async () => {
          await page.getByTestId("sidebar-integrations-heading").click();
          // The integrations page renders its own title as an <h1> inside <main>;
          // the sidebar copy is scoped out via getByRole("main").
          await page
            .getByRole("main")
            .getByRole("heading", { name: "Integrations", level: 1 })
            .waitFor({ timeout: 20_000 });
        },
      );

      await step("The sidebar plus button opens the Connect dialog", async () => {
        await page.getByTestId("sidebar-connect-integration").click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ timeout: 20_000 });
        await dialog
          .getByRole("heading", { name: "Connect an integration" })
          .waitFor({ state: "visible", timeout: 20_000 });
      });
    });
  }),
);
