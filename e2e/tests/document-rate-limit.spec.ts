import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const navigation = { accept: "text/html" };

layer(HostedLive, { excludeTestServices: true })("Document rate limit", (it) => {
  it.effect(scenarios.documentRateLimit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const load = (label: string, path: string) =>
          browser.use(label, (page) =>
            Promise.all(
              Array.from({ length: 60 }, () =>
                page
                  .context()
                  .request.get(path, { headers: navigation, maxRedirects: 0 })
                  .then((response) => response.status()),
              ),
            ),
          );
        const signedOutPages = yield* load("Load sign-in 60 times", "/login");
        yield* browser.login(actors.owner);
        const organizationPages = yield* load(
          "Load organization apps 60 times",
          `/org/${actors.organization.slug}/apps`,
        );
        expect(
          [...signedOutPages, ...organizationPages].filter((status) => status !== 200),
        ).toEqual([]);

        const signedOut = yield* api.session();
        const attempts = yield* Effect.forEach(
          Array.from({ length: 6 }),
          () =>
            api
              .request(signedOut, "POST", "/api/auth/sign-in/email", {
                email: "owner@example.test",
                password: "not-the-password",
              })
              .pipe(Effect.map((response) => response.status)),
          { concurrency: 1 },
        );
        expect(attempts).toContain(429);
      }),
    ),
  );
});
