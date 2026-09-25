import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQzbsDAAJDAXhPdYSTAAAAAElFTkSuQmCC",
  "base64",
);

// A valid ancillary text chunk keeps this synthetic PNG above the browser's
// 64 KiB keepalive request limit without depending on a large binary fixture.
const metadata = Buffer.from("fixture\0" + "x".repeat(128 * 1024));
const chunk = Buffer.alloc(metadata.length + 12);
chunk.writeUInt32BE(metadata.length, 0);
chunk.write("tEXt", 4);
metadata.copy(chunk, 8);
chunk.writeUInt32BE(0x5c6f59eb, chunk.length - 4);
const png = Buffer.concat([pixel.subarray(0, -12), chunk, pixel.subarray(-12)]);

layer(HostedLive, { excludeTestServices: true })("Organization icon", (it) => {
  it.effect(scenarios.organizationIcon.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Open organization settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("Choose a PNG icon", (page) =>
          page.getByLabel("Choose image file", { exact: true }).setInputFiles({
            name: "icon.png",
            mimeType: "image/png",
            buffer: png,
          }),
        );
        yield* browser.use("Save the selected icon through the real upload route", (page) =>
          page
            .locator("form")
            .filter({ has: page.getByRole("heading", { name: "Organization icon", exact: true }) })
            .getByRole("button", { name: "Save", exact: true })
            .click(),
        );
        yield* browser.use("Wait for the upload outcome", (page) =>
          page
            .locator("form")
            .filter({ has: page.getByRole("heading", { name: "Organization icon", exact: true }) })
            .locator('[role="status"], [role="alert"]')
            .filter({ hasText: /^Saved$|Unable to upload/ })
            .waitFor({ state: "visible" }),
        );
        const outcome = yield* browser.use("Read the upload outcome", (page) =>
          page
            .locator("form")
            .filter({ has: page.getByRole("heading", { name: "Organization icon", exact: true }) })
            .locator('[role="status"], [role="alert"]')
            .filter({ hasText: /^Saved$|Unable to upload/ })
            .textContent(),
        );
        expect(outcome).toBe("Saved");
        yield* browser.checkpoint("Organization icon saved");
        yield* browser.use("Reload the persisted settings", (page) => page.reload());
        yield* browser.use("The stored icon loads after reload", (page) =>
          page
            .locator('button[aria-label="Upload organization icon"] img[src*="/icons/"]')
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Organization icon retained after reload");
      }),
    ),
  );
});
