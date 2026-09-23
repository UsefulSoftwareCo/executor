import { layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { retainedDraft } from "../support/sign-in-refresh.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Email code refresh", (it) => {
  it.effect(scenarios.emailCodeRefresh.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open Cloud's server-confirmed sign-in document", (page) =>
          page.goto("/login"),
        );
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
