import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "./browser.ts";
import { holdQuery, refreshVisiblePage } from "./query-transition.ts";

/** Keep the first live session check neutral, then show the confirmed signed-out form. */
export const openSignedOutLogin = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Browser;
      const initial = yield* holdQuery(["/api/auth/get-session"], "continue");
      yield* browser.use("Open sign-in with the first session check held", (page) =>
        page.goto(path),
      );
      yield* initial.requested;
      expect(
        yield* browser.use("An unknown session does not display a sign-in form", (page) =>
          page.getByLabel("Email", { exact: true }).count(),
        ),
      ).toBe(0);
      yield* browser.checkpoint("Initial unknown session stays neutral");
      yield* initial.release;
      yield* browser.use("Confirmed sign-out displays the form", (page) =>
        page.getByLabel("Email", { exact: true }).waitFor({ state: "visible" }),
      );
    }),
  );

/** Carry a synthetic sign-in draft through pending, failed and recovered session checks. */
export const retainedDraft = (field: "Password" | "Sign-in code", value: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const assertDraft = () =>
      Effect.gen(function* () {
        expect(
          yield* browser.use("Email input stays mounted", (page) =>
            page.getByLabel("Email", { exact: true }).count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("Email draft is retained", (page) =>
            page.getByLabel("Email", { exact: true }).inputValue(),
          ),
        ).toBe("focus@example.test");
        expect(
          yield* browser.use(`${field} draft is retained`, (page) =>
            page.getByLabel(field, { exact: true }).inputValue(),
          ),
        ).toBe(value);
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const held = yield* holdQuery(["/api/auth/get-session"], "continue");
        yield* refreshVisiblePage;
        yield* held.requested;
        yield* assertDraft();
        yield* browser.checkpoint("Sign-in draft remains while session check is pending");
        yield* held.release;
      }),
    );
    yield* assertDraft();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const failed = yield* holdQuery(["/api/auth/get-session"], "fail");
        yield* refreshVisiblePage;
        yield* failed.requested;
        yield* failed.release;
        yield* browser.use("Session failure is shown beside the draft", (page) =>
          page
            .getByText("Unable to check your session.", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* assertDraft();
        yield* browser.checkpoint("Sign-in draft remains after session-check failure");
      }),
    );
    yield* browser.use("Retry the session check", (page) =>
      page.getByRole("button", { name: "Try again", exact: true }).click(),
    );
    yield* browser.use("Session check recovers", (page) =>
      page.getByText("Unable to check your session.", { exact: true }).waitFor({ state: "hidden" }),
    );
    yield* assertDraft();
  });
