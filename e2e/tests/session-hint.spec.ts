import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { dashboardLoadingProbe } from "../support/dashboard-loading.ts";
import { scenarios } from "../test-plan.ts";
import { SessionHint } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";

layer(HostedLive, { excludeTestServices: true })("Session hints", (it) => {
  it.effect(scenarios.sessionHint.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const target = yield* Target;
        const loginTitle = target.metadata.target === "cloud" ? "Sign in" : "Sign in to Executor";
        const destination = `/org/${actors.organization.slug}/apps?view=accounts`;
        yield* browser.login(yield* freshOwnerSession);
        const pageResponse = yield* browser.use("Open the static dashboard", (page) =>
          page.goto(destination),
        );
        expect(pageResponse?.status()).toBe(200);
        if (pageResponse === null) throw new Error("The dashboard did not return a document");
        const html = yield* browser.use("The HTML contains no embedded identity", () =>
          pageResponse.text(),
        );
        expect(html).not.toContain("executor-session");
        yield* browser.use("Wait for the first confirmed session", (page) =>
          page.getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ }).waitFor({ state: "visible" }),
        );
        const cookies = yield* browser.use("Inspect the display cookie", (page) =>
          page.context().cookies(),
        );
        const cookie = cookies.find((item) => item.name.startsWith("executor-ui"));
        if (cookie === undefined)
          throw new Error("The confirmed session did not save a display hint");
        expect(cookie.httpOnly).toBe(false);
        expect(cookie.sameSite).toBe("Lax");
        const decoded: unknown = JSON.parse(decodeURIComponent(cookie.value));
        const parsed = Schema.decodeUnknownSync(SessionHint)(decoded);
        expect(decoded).toEqual(parsed);
        expect(parsed.expiresAt).toBeGreaterThan(Date.now());
        for (const credential of cookies.filter((item) => item.httpOnly))
          expect(cookie.value).not.toContain(credential.value);
        yield* browser.use("Sign out", (page) =>
          page.getByRole("button", { name: "Sign out", exact: true }).click(),
        );
        yield* browser.use("The signed-in page closes", (page) =>
          page.getByRole("button", { name: "Sign out", exact: true }).waitFor({ state: "hidden" }),
        );
        yield* browser.use("Sign-out navigation finishes before restoring a stale hint", (page) =>
          page.waitForURL(
            (url) => url.pathname === (target.metadata.target === "cloud" ? "/" : "/login"),
            { waitUntil: "domcontentloaded" },
          ),
        );
        const signedOut = yield* browser.use("Sign-out clears the display hint", (page) =>
          page.context().cookies(),
        );
        expect(signedOut.some((item) => item.name === cookie.name)).toBe(false);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const probe = yield* dashboardLoadingProbe;
            yield* browser.use("Remove all authentication cookies", (page) =>
              page.context().clearCookies(),
            );
            yield* browser.use("Restore only the expired session's display metadata", (page) =>
              page.context().addCookies([cookie]),
            );
            const response = yield* browser.use("Open the original deep link", (page) =>
              page.goto(destination),
            );
            expect(response?.status()).toBe(200);
            yield* probe.sessionRequested;
            yield* probe.resourcesRequested;
            yield* browser.use("The hint paints the shell before verification", (page) =>
              page
                .getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ })
                .waitFor({ state: "visible" }),
            );
            const denied = yield* browser.use("The hint cannot authorize an API", (page) =>
              page.context().request.get("/api/viewer"),
            );
            expect(denied.status()).toBe(401);
            yield* browser.checkpoint("Hint visible while the real session check is held");
            yield* probe.releaseContent;
            yield* probe.releaseMetadata;
            yield* probe.releaseSession;
            yield* browser.use("The live result returns to login", (page) =>
              page.waitForURL((url) => url.pathname === "/login"),
            );
            const url = yield* browser.use("Read the preserved destination", (page) =>
              Promise.resolve(page.url()),
            );
            expect(new URL(url).searchParams.get("redirect")).toBe(destination);
            const expired = yield* browser.use("The expired hint is gone", (page) =>
              page.context().cookies(),
            );
            expect(expired.some((item) => item.name === cookie.name)).toBe(false);
            yield* browser.use("Login stays visible without a redirect loop", (page) =>
              page
                .getByRole("heading", { name: loginTitle, exact: true })
                .waitFor({ state: "visible" }),
            );
          }),
        );
        yield* browser.use("Supply malformed display metadata", (page) =>
          page.context().addCookies([{ ...cookie, value: "%not-json" }]),
        );
        yield* browser.use("Reload login", (page) => page.reload());
        yield* browser.use("Malformed metadata does not redirect login", (page) =>
          page
            .getByRole("heading", { name: loginTitle, exact: true })
            .waitFor({ state: "visible" }),
        );
        const malformed = yield* browser.use("Malformed metadata is removed", (page) =>
          page.context().cookies(),
        );
        expect(malformed.some((item) => item.name === cookie.name)).toBe(false);
      }),
    ),
  );
});
