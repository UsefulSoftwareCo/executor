import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openSignedOutLogin, retainedDraft } from "../support/sign-in-refresh.ts";
import { scenarios } from "../test-plan.ts";
import { Actors, password } from "../support/actors.ts";
import { refreshVisiblePage } from "../support/query-transition.ts";

layer(HostedLive, { excludeTestServices: true })("Password refresh", (it) => {
  it.effect(scenarios.passwordRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors;
        yield* browser.omitNetworkTrace;
        const destination = `/org/${actors.organization.slug}/groups`;
        yield* openSignedOutLogin(`/login?redirect=${encodeURIComponent(destination)}`);
        yield* browser.use("Type email", (page) =>
          page.getByLabel("Email", { exact: true }).fill("focus@example.test"),
        );
        yield* browser.use("Type password", (page) =>
          page.getByLabel("Password", { exact: true }).fill(password),
        );
        yield* retainedDraft("Password", password);
        yield* browser.login(actors.owner);
        yield* refreshVisiblePage;
        yield* browser.use("A newly authenticated session still redirects", (page) =>
          page.waitForURL((url) => url.pathname === destination),
        );
        yield* browser.checkpoint("Verified session redirects to the original destination");
      }),
    ),
  );
});
