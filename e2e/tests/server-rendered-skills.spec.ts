import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { noPageErrors } from "../support/page-errors.ts";

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;

layer(HostedLive, { excludeTestServices: true })("Server-rendered skills", (it) => {
  it.effect(scenarios.serverRenderedSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        yield* browser.login(yield* freshOwnerSession);
        const failures: string[] = [];
        yield* browser.use("Watch hydration", (page) => {
          page.on("console", (message) => {
            if (message.type() === "error" && hydrationFailure.test(message.text()))
              failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          return Promise.resolve();
        });
        // An editable app's skills read its working source and its deployed catalog while the
        // page renders. Both reach the browser with the page, so neither loads again.
        yield* browser.use("Open the apps page", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The Executor app is installed", (page) =>
          page.getByText("Executor", { exact: true }).first().waitFor({ state: "visible" }),
        );
        const inventory = yield* browser.use("Find the installed Executor app", (page) =>
          page
            .context()
            .request.get(`/api/organizations/${actors.organization.id}/inventory`)
            .then((value) => value.json()),
        );
        const installed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
          }),
        )(inventory);
        const executor = installed.apps.find((app) => app.name === "Executor");
        if (executor === undefined) throw new Error("The Executor app is not installed");
        const skillReads: string[] = [];
        yield* browser.use("Watch the skills page's own reads", (page) => {
          page.on("request", (request) => {
            const path = new URL(request.url()).pathname;
            if (/^\/api\/organizations\/[^/]+\/apps\/[^/]+\/(workspace|skill-bundle)$/.test(path))
              skillReads.push(path);
          });
          return Promise.resolve();
        });
        yield* browser.use("Open the Executor app's skills", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${executor.id}?view=skills`),
        );
        yield* browser.use("The server's skills are shown", (page) =>
          page
            .getByRole("heading", { name: "Build an Executor app", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Let the skills region hydrate", (page) => page.waitForTimeout(1500));
        yield* noPageErrors(failures);
        expect(skillReads).toEqual([]);
        // Each skill in the list and the open file show their size in lines and estimated tokens.
        const size = /^[\d,]+ lines? · ~[\d.]+K? tokens$/;
        const sizes = yield* browser.use("Read the skill sizes", (page) =>
          Promise.all([
            page.getByRole("navigation", { name: "Skill files" }).getByText(size).allTextContents(),
            page.locator(".sticky").getByText(size).allTextContents(),
          ]),
        );
        expect(sizes[0].length).toBeGreaterThan(0);
        expect(sizes[1]).toHaveLength(1);
        yield* browser.use("Hovering the token count explains the estimate", (page) =>
          page
            .locator(".sticky")
            .getByText(/^~[\d.]+K? tokens$/)
            .hover()
            .then(() =>
              page
                .getByRole("tooltip")
                .getByText("Estimated at four characters per token", { exact: false })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Server-rendered skills after hydration");
      }),
    ),
  );
});
