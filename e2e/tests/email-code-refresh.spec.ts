import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { retainedDraft } from "../support/sign-in-refresh.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Email code refresh", (it) => {
  it.effect(scenarios.emailCodeRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        const response = yield* browser.use("Open server-prepared Cloud sign-in", (page) =>
          page.goto("/login"),
        );
        const document = yield* browser.use("Read the prepared sign-in state", () => {
          if (response === null) throw new Error("Sign-in document did not load");
          return response.text().then((html) => ({
            html,
            private: response.headers()["cache-control"]?.includes("no-store"),
          }));
        });
        expect(document.html).toContain('id="executor-entry"');
        expect(document.html).toContain('"session":null');
        expect(document.private).toBe(true);
        yield* browser
          .use("Cloud verifies sign-out before rendering the form", (page) =>
            page.locator("#executor-entry").textContent(),
          )
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    kind: Schema.Literal("page"),
                    path: Schema.Literal("/login"),
                    session: Schema.Null,
                  }),
                ),
              ),
            ),
          );
        yield* browser.use("Type email", (page) =>
          page.getByLabel("Email", { exact: true }).fill("focus@example.test"),
        );
        yield* browser.use("Request a code from the test email service", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Start typing the code", (page) =>
          page.getByLabel("Sign-in code", { exact: true }).fill("123456"),
        );
        yield* retainedDraft("Sign-in code", "123456");
      }),
    ),
  );
});
