import { expect, layer } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, freshOwnerSession, password } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

const CurrentSession = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ name: Schema.String, email: Schema.String }) }),
);

layer(HostedLive, { excludeTestServices: true })("Account settings", (it) => {
  it.effect(scenarios.accountSettings.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const current = (session: Session) =>
          api
            .request(session, "GET", "/api/auth/get-session")
            .pipe(Effect.flatMap((response) => body(CurrentSession, response)));
        const alive = (sessions: ReadonlyArray<Session>) =>
          Effect.forEach(sessions, current).pipe(
            Effect.map((results) => results.filter((result) => result !== null).length),
          );
        const mine = yield* freshOwnerSession;
        const other = yield* freshOwnerSession;
        const identity = yield* current(mine);
        if (identity === null) throw new Error("The fresh owner session has no identity.");
        const rotated = `${password}-rotated`;
        let renamed = false;
        let passwordRotated = false;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (renamed)
              yield* api.request(mine, "POST", "/api/auth/update-user", {
                name: identity.user.name,
              });
            if (passwordRotated)
              yield* api.request(mine, "POST", "/api/auth/change-password", {
                currentPassword: rotated,
                newPassword: password,
                revokeOtherSessions: false,
              });
          }).pipe(Effect.orDie),
        );

        yield* browser.omitNetworkTrace;
        yield* browser.login(mine);
        yield* browser.use("Open the organization dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Open the account menu", (page) =>
          page.getByRole("button", { name: /^Account: / }).click(),
        );
        yield* browser.use("Open account settings", (page) =>
          page.getByRole("menuitem", { name: "Account settings", exact: true }).click(),
        );
        yield* browser.use("Account settings open on the profile", (page) =>
          page.waitForURL((url) => url.pathname === "/account/profile"),
        );
        yield* browser.use("The account area links back to the organization", (page) =>
          page.getByRole("link", { name: /^Back to / }).waitFor(),
        );
        for (const label of ["Profile", "Security", "Tokens"])
          yield* browser.use(`The account navigation has ${label}`, (page) =>
            page.getByRole("link", { name: label, exact: true }).waitFor(),
          );

        expect(
          yield* browser.use("The profile shows the current name and email", (page) =>
            page
              .getByLabel("Email", { exact: true })
              .waitFor()
              .then(() =>
                Promise.all([
                  page.getByLabel("Name", { exact: true }).inputValue(),
                  page.getByLabel("Email", { exact: true }).inputValue(),
                ]),
              ),
          ),
        ).toEqual([identity.user.name, identity.user.email]);
        const newName = `Renamed ${randomBytes(3).toString("hex")}`;
        yield* browser.use("Save is unavailable until the name changes", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
        );
        yield* browser.use("Enter a new name", (page) =>
          page.getByLabel("Name", { exact: true }).fill(newName),
        );
        yield* browser.use("Save the name", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        renamed = true;
        yield* browser.use("The profile confirms the save", (page) =>
          page.getByRole("status").filter({ hasText: "Saved" }).waitFor(),
        );
        yield* browser.use("The sidebar shows the new name without a reload", (page) =>
          page.getByRole("button", { name: `Account: ${newName}` }).waitFor(),
        );
        yield* browser.use("Reload the profile", (page) => page.reload());
        expect(
          yield* browser.use("The new name persisted", (page) =>
            page
              .getByLabel("Name", { exact: true })
              .waitFor()
              .then(() => page.getByLabel("Name", { exact: true }).inputValue()),
          ),
        ).toBe(newName);
        expect((yield* current(mine))?.user.name).toBe(newName);

        yield* browser.use("Open Security", (page) =>
          page.getByRole("link", { name: "Security", exact: true }).click(),
        );
        yield* browser.use("Security lists active sessions", (page) =>
          page.waitForURL((url) => url.pathname === "/account/security"),
        );
        yield* browser.use("This browser's session is marked", (page) =>
          page.getByText("This browser", { exact: true }).waitFor(),
        );
        const rows = (page: Page) =>
          page.getByRole("list", { name: "Active sessions" }).getByRole("listitem");
        const listed = yield* browser.use("Count the listed sessions", (page) =>
          rows(page).count(),
        );
        expect(listed).toBeGreaterThanOrEqual(3);
        expect(yield* alive([other, actors.owner])).toBe(2);
        yield* browser.use("Sign out one other session", (page) =>
          page
            .getByRole("button", { name: /^Sign out / })
            .first()
            .click(),
        );
        yield* browser.use("The revoked session leaves the list", (page) =>
          page.waitForFunction(
            (expected) =>
              document.querySelectorAll('[aria-label="Active sessions"] > li').length === expected,
            listed - 1,
          ),
        );
        expect(yield* alive([other, actors.owner])).toBe(1);
        expect(yield* current(mine)).not.toBeNull();
        yield* browser.use("Sign out every other session", (page) =>
          page.getByRole("button", { name: "Sign out other sessions", exact: true }).click(),
        );
        yield* browser.use("Only this browser remains", (page) =>
          page.waitForFunction(
            () => document.querySelectorAll('[aria-label="Active sessions"] > li').length === 1,
          ),
        );
        yield* browser.use("Nothing else is left to sign out", (page) =>
          page
            .getByRole("button", { name: "Sign out other sessions", exact: true })
            .and(page.locator("[disabled], [aria-disabled='true']"))
            .waitFor(),
        );
        expect(yield* alive([other, actors.owner])).toBe(0);
        expect(yield* current(mine)).not.toBeNull();

        if (target.metadata.target === "self-host") {
          yield* browser.use("Enter the current password", (page) =>
            page.getByLabel("Current password", { exact: true }).fill(password),
          );
          yield* browser.use("Enter a new password", (page) =>
            page.getByLabel("New password", { exact: true }).fill(rotated),
          );
          yield* browser.use("Change the password", (page) =>
            page.getByRole("button", { name: "Change password", exact: true }).click(),
          );
          passwordRotated = true;
          yield* browser.use("The page confirms the change", (page) =>
            page.getByRole("status").filter({ hasText: "Password changed" }).waitFor(),
          );
          const signIn = (secret: string) =>
            Effect.flatMap(api.session(), (session) =>
              api.request(session, "POST", "/api/auth/sign-in/email", {
                email: identity.user.email,
                password: secret,
              }),
            );
          expect((yield* signIn(rotated)).status).toBe(200);
          yield* browser.use("A wrong current password is rejected", (page) =>
            page
              .getByLabel("Current password", { exact: true })
              .fill(password)
              .then(() => page.getByLabel("New password", { exact: true }).fill(rotated))
              .then(() =>
                page.getByRole("button", { name: "Change password", exact: true }).click(),
              ),
          );
          yield* browser.use("The rejection is explained", (page) =>
            page.getByRole("alert").filter({ hasText: "current password" }).waitFor(),
          );
        }

        yield* browser.use("Open the account root", (page) => page.goto("/account"));
        yield* browser.use("The account root opens the profile", (page) =>
          page.waitForURL((url) => url.pathname === "/account/profile"),
        );
      }),
    ),
  );
});
