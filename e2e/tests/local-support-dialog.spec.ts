import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Local support dialog", (it) => {
  it.effect(scenarios.localSupportDialog.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, {
            authorization: `Bearer ${Redacted.value(target.apiKey)}`,
          }),
        );
        yield* browser.use("Pair the local dashboard", (page) => page.goto(url));
        yield* browser.use("Wait for apps", (page) =>
          page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor(),
        );
        expect(
          yield* browser.use("Read the Feedback link", (page) =>
            page
              .locator("aside.sidebar")
              .getByRole("link", { name: "Feedback" })
              .getAttribute("href"),
          ),
        ).toBe("https://github.com/UsefulSoftwareCo/executor/issues");
        expect(
          yield* browser.use("Check the rail has no support entry", (page) =>
            page.getByRole("button", { name: "Get support" }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Local rail without support");
        yield* browser.use("Open the phone menu", (page) =>
          page
            .setViewportSize({ width: 390, height: 844 })
            .then(() => page.getByRole("button", { name: "Menu", exact: true }).click())
            .then(() => page.getByRole("dialog", { name: "Menu" }).waitFor()),
        );
        expect(
          yield* browser.use("Check the phone menu has no support entry", (page) =>
            page.getByRole("dialog", { name: "Menu" }).getByText("Get support").count(),
          ),
        ).toBe(0);
      }),
    ),
  );
});
