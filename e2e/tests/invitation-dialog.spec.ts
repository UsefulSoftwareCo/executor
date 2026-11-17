/** Sending an invitation turns the dialog into a success view instead of leaving the form in place. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { freeSeat } from "../support/seats.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Invitation dialog", (it) => {
  it.effect(scenarios.invitationDialog.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const email = `invite-${randomUUID().slice(0, 8)}@example.test`;
        const seat = yield* freeSeat;
        yield* browser.login(actors.owner);
        yield* browser.use("Open organization settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("The membership list has loaded", (page) =>
          page.getByRole("table", { name: "Members", exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the invitation form", (page) =>
          page.getByRole("button", { name: "Add member", exact: true }).click(),
        );
        yield* browser.use("Enter the invitee", (page) =>
          page.getByRole("textbox", { name: "Email", exact: true }).fill(email),
        );
        yield* browser.checkpoint("Invitation form");
        yield* browser.use("Submit the invitation", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: /^(Send invitation|Create invite link)$/ })
            .click(),
        );
        const dialog = (page: Page) => page.getByRole("dialog");
        yield* browser.use("The dialog shows the sent invitation", (page) =>
          dialog(page)
            .getByRole("heading", { name: /^(Invitation sent|Invite link ready)$/ })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("The form is replaced by the success view", (page) =>
          Promise.all([
            dialog(page).getByRole("textbox", { name: "Email", exact: true }).waitFor({
              state: "detached",
            }),
            dialog(page).getByRole("button", { name: "Copy link", exact: true }).waitFor(),
          ]),
        );
        expect(
          yield* browser.use("The success view names the invitee", (page) =>
            dialog(page).textContent(),
          ),
        ).toContain(email);
        expect(
          yield* browser.use("The success view shows the invitation link", (page) =>
            dialog(page)
              .getByRole("textbox", { name: "Invitation link", exact: true })
              .inputValue(),
          ),
        ).toMatch(/\/invite\?invitation=/);
        yield* browser.checkpoint("Invitation sent");
        yield* browser.use("Invite another person", (page) =>
          dialog(page).getByRole("button", { name: "Invite another", exact: true }).click(),
        );
        expect(
          yield* browser.use("The form returns empty", (page) =>
            dialog(page).getByRole("textbox", { name: "Email", exact: true }).inputValue(),
          ),
        ).toBe("");
        yield* browser.use("Close the dialog", (page) =>
          dialog(page).getByRole("button", { name: "Cancel", exact: true }).click(),
        );
        yield* browser.use("The dialog closes", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        const row = (page: Page) =>
          page.locator(".membership-table tbody tr").filter({ hasText: email });
        yield* browser.use("Resend from the pending row", (page) =>
          row(page)
            .getByRole("button", { name: /^(Resend|Get invite link)$/ })
            .click(),
        );
        yield* browser.use("Resending reopens the success view", (page) =>
          dialog(page)
            .getByRole("heading", { name: /^(Invitation resent|Invite link ready)$/ })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Invitation resent");
        yield* browser.use("Finish", (page) =>
          dialog(page).getByRole("button", { name: "Done", exact: true }).click(),
        );
        yield* browser.use("The dialog closes after Done", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("No invitation link is left below the members table", (page) =>
            page.getByRole("textbox", { name: "Invitation link", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Members after the invitation");
        yield* browser.use("Revoke the invitation", (page) =>
          row(page)
            .getByRole("button", { name: `Revoke invitation to ${email}`, exact: true })
            .click(),
        );
        yield* browser.use("Confirm the revocation", (page) =>
          page.getByRole("button", { name: "Revoke invitation", exact: true }).click(),
        );
        yield* browser.use("The invitation row is removed", (page) =>
          row(page).waitFor({ state: "detached" }),
        );
        // The member is invited back and accepts while the list still shows the invitation.
        const api = yield* Api;
        const sent = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/organization/invite-member",
          {
            organizationId: actors.organization.id,
            email: seat.email,
            role: "member",
          },
        );
        expect(sent.status).toBe(200);
        const returning = yield* body(Resource, sent);
        const revoke = (page: Page) =>
          page.getByRole("button", { name: `Revoke invitation to ${seat.email}`, exact: true });
        yield* browser.use("Reload the members list", (page) =>
          page.reload().then(() => revoke(page).waitFor({ state: "visible" })),
        );
        expect(
          (yield* api.request(actors.member, "POST", "/api/auth/organization/accept-invitation", {
            invitationId: returning.id,
          })).status,
        ).toBe(200);
        yield* browser.use("Revoke the accepted invitation", (page) => revoke(page).click());
        yield* browser.use("Confirm revoking it", (page) =>
          page.getByRole("button", { name: "Revoke invitation", exact: true }).click(),
        );
        expect(
          yield* browser.use("The dialog says the person has joined", (page) =>
            dialog(page)
              .getByRole("alert")
              .waitFor({ state: "visible" })
              .then(() => dialog(page).getByRole("alert").textContent()),
          ),
        ).toBe(
          "This person has already accepted the invitation and joined. Change their role or remove them in the members list.",
        );
        yield* browser.checkpoint("Revoking an accepted invitation");
      }),
    ),
  );
});
