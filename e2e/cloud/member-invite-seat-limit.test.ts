// Cloud-only (billing): the free plan advertises "Up to 3 members", 3
// INCLUSIVE. A fresh org's admin holds seat 1, so two invites fill seats 2 and
// 3; at that point "Invite member" opens an upgrade prompt (linking to billing)
// instead of the invite form, and a direct call to the invite endpoint is
// refused with a message that names the real reason.
//
// Regression for a Replo report: an admin (sole member, one invite already
// pending) could not invite another teammate and got the generic "Failed to
// send invitation. Please try again." Root cause: the seat count summed
// `listOrganizationMemberships` (which includes the invited user as a PENDING
// membership) and `listInvitations` (the SAME invited user), double-counting
// every outstanding invite, so a 1-member org with 1 pending invite read as 3
// seats used. Two UI gaps compounded it: the invite button stayed enabled at
// the cap, and the 403 was masked behind a generic, retry-implying message.
//
// The dedupe itself is unit-tested in `apps/cloud/src/extensions/billing/
// plans.test.ts`. This scenario covers the user-facing flow end to end: invited
// people appear as pending members, the cap turns "Invite member" into an
// upgrade prompt, and the endpoint refuses with a reason.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Billing, Browser, Target } from "../src/services";

// apps/cloud/src/extensions/billing/plans.ts → MEMBER_LIMITS.free
const FREE_MEMBER_SEATS = 3;

scenario(
  "Billing · a free org fills its 3 member seats, then invites are blocked with a reason",
  {},
  Effect.gen(function* () {
    // Gate: billing limits are enforced on this target.
    yield* Billing;
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    // A fresh user who owns a brand-new free org: the admin holds seat 1.
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(AccountHttpApi, identity);

    yield* browser.session(identity, async ({ page, step }) => {
      let slug = "";

      await step("Land in the app and canonicalize onto the org slug", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
        slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
        expect(slug, "the URL settled on an org slug").not.toBe("");
      });

      await step("Open the organization members page", async () => {
        await page.goto(`/${slug}/org`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Invite member" }).waitFor();
      });

      const submitInvite = async (email: string) => {
        await page.getByRole("button", { name: "Invite member" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await page.waitForTimeout(500);
        await dialog.getByPlaceholder("colleague@company.com").fill(email);
        await page.waitForTimeout(800);
        await dialog.getByRole("button", { name: "Send invite" }).click();
        await dialog.waitFor({ state: "hidden", timeout: 15_000 });
      };

      // The owner already holds seat 1, so two invites fill seats 2 and 3.
      for (let seat = 2; seat <= FREE_MEMBER_SEATS; seat++) {
        await step(`Invite a teammate (fills seat ${seat} of ${FREE_MEMBER_SEATS})`, async () => {
          await submitInvite(`teammate-${seat}@example.com`);
          // The invited person shows up in the members list as a pending
          // ("Invited") member, and the header seat counter reflects the seat.
          await page
            .getByText(`teammate-${seat}@example.com`, { exact: true })
            .waitFor({ timeout: 10_000 });
          await page.getByText(`${seat} of ${FREE_MEMBER_SEATS} seats used`).waitFor({
            timeout: 10_000,
          });
          await page.waitForTimeout(700);
        });
      }

      await step("At the cap, Invite member opens an upgrade prompt", async () => {
        // The seat counter reflects the cap, so the button now opens the
        // upgrade prompt (it stays clickable, not disabled).
        await page
          .getByText(`${FREE_MEMBER_SEATS} of ${FREE_MEMBER_SEATS} seats used`)
          .waitFor({ timeout: 10_000 });
        await page.getByRole("button", { name: "Invite member" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText(/at your member limit/i).waitFor();
        await page.waitForTimeout(1500);
        // The upgrade call to action takes the admin to the billing plans page.
        await dialog.getByText("Upgrade plan", { exact: true }).click();
        await page.waitForURL(/\/billing\/plans/, { timeout: 15_000 });
        await page.waitForTimeout(1000);
      });
    });

    // The seat math: the plan grants 3 and the org is exactly full (owner + 2
    // invites), NOT 4 (which the old double-count would have produced).
    const { seats } = yield* client.account.listMembers();
    expect(seats?.granted, "the free plan advertises 3 member seats").toBe(FREE_MEMBER_SEATS);
    expect(seats?.used, "owner + 2 invites = 3, with no double-counting").toBe(FREE_MEMBER_SEATS);

    // The endpoint itself fails closed at the cap, with a reason (not the
    // generic retry copy), even if a client bypasses the disabled button.
    const refused = yield* Effect.promise(() =>
      fetch(new URL("/api/account/members/invite", target.baseUrl), {
        method: "POST",
        headers: { ...(identity.headers ?? {}), "content-type": "application/json" },
        body: JSON.stringify({ email: "over-the-cap@example.com" }),
      }),
    );
    expect(refused.status, "the over-cap invite is refused").toBe(403);
    const body = (yield* Effect.promise(() => refused.json())) as { message?: string };
    expect(body.message ?? "", "the refusal names the real reason").toMatch(
      /seat|limit|plan|upgrade|member/i,
    );
    expect(body.message ?? "", "it is not the opaque generic retry message").not.toMatch(
      /try again/i,
    );
  }),
);
