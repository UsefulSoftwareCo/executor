// Cross-target (browser): the Add OpenAPI source form's floating action bar.
// Rohil (shared-tcc) reported the "Add integration" button rendering doubled /
// ghosted on click. This pins the flow: paste a spec, click Add integration,
// land on the created integration. The trace's DOM snapshots are the artifact
// we use to confirm the bar is a single node (a paint artifact, not a
// double-render). Skips on targets without a browser surface (selfhost today).
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

// One server so "Add integration" is enabled straight from the preview (no
// base-URL picker to resolve first).
const singleServerSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com", description: "Production" }],
  paths: {
    "/ping": { get: { operationId: "ping", responses: { "200": { description: "pong" } } } },
  },
});

scenario(
  "OpenAPI · Add integration commits the source and the action bar is a single node",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Add OpenAPI source form", async () => {
          await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
          await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
        });

        await step("Paste a single-server spec so Add integration is enabled", async () => {
          await page.getByPlaceholder("https://api.example.com/openapi.json").fill(singleServerSpec);
          await page.getByRole("button", { name: "Add integration" }).waitFor({ timeout: 20_000 });
        });

        await step("Exactly one action bar / Add integration button is in the DOM", async () => {
          // The reported ghosting looked like two overlapping bars. If that were
          // a real double-render the DOM would carry two buttons; assert it does
          // not (so the artifact is paint-level, fixed by isolating the layer).
          const count = await page.getByRole("button", { name: "Add integration" }).count();
          expect(count, "a single Add integration button is rendered").toBe(1);
        });

        await step("Submitting does not reflow the bar, then lands on the integration", async () => {
          // The reported ghost was the bar painting doubled when the submit
          // button changed width on click. With a stable-width loading button the
          // row must not move: Cancel stays put while the add is in flight.
          const cancel = page.getByRole("button", { name: "Cancel" });
          const before = await cancel.boundingBox();
          await page.getByRole("button", { name: "Add integration" }).click();
          // The submit button marks itself data-loading synchronously on click.
          await page.locator('[data-slot="button"][data-loading]').first().waitFor({ timeout: 5_000 });
          const during = await cancel.boundingBox();
          expect(Math.round(during?.x ?? -1), "Cancel does not move when submitting").toBe(
            Math.round(before?.x ?? -2),
          );
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          await page.getByText("Connections").first().waitFor();
        });

        await step("The empty connections state renders", async () => {
          await page.getByText("No connections yet").waitFor({ timeout: 20_000 });
        });

        await step("The empty state shows a single add-connection CTA", async () => {
          // Regression cover for the doubled-button report: the empty state used
          // to render both a header "Add connection" and a card "Add a
          // connection". Match either label so a regression is actually counted.
          const count = await page
            .getByRole("button", { name: /^Add (a )?connection$/i })
            .count();
          expect(count, "empty state shows exactly one add-connection button").toBe(1);
        });
      });
    }),
  ),
);
