import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { freeSeat } from "../support/seats.ts";
import { scenarios } from "../test-plan.ts";

const Refusal = Schema.Struct({ code: Schema.Literal("ORGANIZATION_MEMBERSHIP_LIMIT_REACHED") });

layer(HostedLive, { excludeTestServices: true })("Member limit", (it) => {
  it.effect(scenarios.memberLimit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const organizationId = actors.organization.id;
        const limitPath = `/api/organizations/${organizationId}/billing/member-limit`;
        const invite = (actor: typeof actors.owner, email: string, resend = false) =>
          api.request(actor, "POST", "/api/auth/organization/invite-member", {
            organizationId,
            email,
            role: "member",
            resend,
          });

        const limit = yield* api.request(actors.owner, "GET", limitPath);
        expect(limit.status).toBe(200);
        expect(limit.body).toEqual({ limit: 3 });
        expect((yield* api.request(actors.admin, "GET", limitPath)).status).toBe(200);
        expect((yield* api.request(actors.member, "GET", limitPath)).status).toBe(403);
        for (const actor of [actors.owner, actors.admin]) {
          const refused = yield* invite(actor, "over-limit@example.test");
          expect(refused.status).toBe(403);
          yield* body(Refusal, refused);
        }
        const denied = yield* invite(actors.member, "over-limit@example.test");
        expect(denied.status).toBe(403);
        expect(denied.body).not.toMatchObject({ code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED" });

        const pendingEmail = "pending-at-limit@example.test";
        const seat = yield* freeSeat;
        expect((yield* invite(actors.owner, pendingEmail)).status).toBe(200);
        yield* seat.rejoin;
        const resent = yield* invite(actors.owner, pendingEmail, true);
        expect(resent.status).toBe(403);
        yield* body(Refusal, resent);

        const dialog = (page: Page) => page.getByRole("dialog");
        const count = (page: Page) =>
          page
            .getByRole("heading", { name: /^Members/ })
            .locator(".membership-count")
            .first();
        yield* browser.login(actors.owner);
        yield* browser.use("Open organization settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("The heading shows the limit", (page) =>
          count(page)
            .filter({ hasText: /^3 of 3$/ })
            .waitFor(),
        );
        yield* browser.use("Add member at the limit", (page) =>
          page.getByRole("button", { name: "Add member", exact: true }).click(),
        );
        yield* browser.use("The dialog offers an upgrade instead of the form", (page) =>
          dialog(page).getByRole("heading", { name: "Member limit reached" }).waitFor(),
        );
        expect(
          yield* browser.use("The dialog states the limit", (page) => dialog(page).textContent()),
        ).toContain("3 of 3 members");
        expect(
          yield* browser.use("No invitation form is shown", (page) =>
            dialog(page).getByRole("textbox", { name: "Email", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Member limit reached");
        yield* browser.use("Dismiss the upgrade prompt", (page) =>
          dialog(page).getByRole("button", { name: "Cancel", exact: true }).click(),
        );
        yield* browser.use("The dialog closes", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        yield* browser.use("Resend the pending invitation at the limit", (page) =>
          page
            .locator(".membership-table tbody tr")
            .filter({ hasText: pendingEmail })
            .getByRole("button", { name: "Resend", exact: true })
            .click(),
        );
        yield* browser.use("Resending offers the upgrade too", (page) =>
          dialog(page).getByRole("heading", { name: "Member limit reached" }).waitFor(),
        );
        yield* browser.use("Follow the upgrade prompt", (page) =>
          dialog(page).getByRole("link", { name: "Upgrade plan", exact: true }).click(),
        );
        yield* browser.use("Billing shows the plans", (page) =>
          Promise.all([
            page.waitForURL((url) => url.pathname === `/org/${actors.organization.slug}/billing`),
            page.getByRole("heading", { name: "Team", exact: true }).waitFor(),
          ]),
        );
        yield* browser.checkpoint("Upgrade prompt opened billing");

        yield* browser.use("Return to organization settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("The members list is full", (page) =>
          count(page)
            .filter({ hasText: /^3 of 3$/ })
            .waitFor(),
        );
        yield* browser.use("Remove the member", (page) =>
          page
            .locator(".membership-table tbody tr")
            .filter({ hasText: seat.email })
            .getByRole("button", { name: /^Remove / })
            .click(),
        );
        yield* browser.use("Confirm the removal", (page) =>
          page.getByRole("button", { name: "Remove member", exact: true }).click(),
        );
        yield* browser.use("The heading shows a free seat", (page) =>
          count(page)
            .filter({ hasText: /^2 of 3$/ })
            .waitFor(),
        );
        yield* browser.use("Add member with a free seat", (page) =>
          page.getByRole("button", { name: "Add member", exact: true }).click(),
        );
        yield* browser.use("Enter the invitee", (page) =>
          dialog(page)
            .getByRole("textbox", { name: "Email", exact: true })
            .fill("free-seat@example.test"),
        );
        yield* browser.use("Send the invitation", (page) =>
          dialog(page).getByRole("button", { name: "Send invitation", exact: true }).click(),
        );
        yield* browser.use("The invitation is sent", (page) =>
          dialog(page).getByRole("heading", { name: "Invitation sent" }).waitFor(),
        );
        yield* browser.checkpoint("Invitation sent with a free seat");
      }),
    ),
  );
});
