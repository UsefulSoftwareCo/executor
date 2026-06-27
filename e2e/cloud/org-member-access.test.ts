// Cloud browser and API coverage for a regular organization member. The UI
// stays read-only, while the same mutations remain forbidden at the server.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import type { Identity } from "../src/target";

const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
const SelectedAccount = Schema.Struct({ organization: Organization });
const Invitation = Schema.Struct({ id: Schema.String });

const decodeSelectedAccount = Schema.decodeUnknownSync(SelectedAccount);
const decodeInvitation = Schema.decodeUnknownSync(Invitation);

const sessionCookiePair = (response: Response) => {
  const headers = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return headers.find((header) => header.startsWith("wos-session="))?.split(";")[0] ?? "";
};

scenario(
  "Organization access · members see read-only controls and mutations stay forbidden",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const admin = yield* target.newIdentity();
    const member = yield* target.newIdentity({ org: false });
    const adminCookie = admin.headers?.cookie ?? "";
    const memberCookie = member.headers?.cookie ?? "";
    const memberEmail = member.credentials?.email ?? "";

    const adminAccountResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/me", target.baseUrl), {
        headers: { cookie: adminCookie },
      }),
    );
    expect(adminAccountResponse.ok, "the admin organization resolves").toBe(true);
    const adminAccount = decodeSelectedAccount(
      yield* Effect.promise(() => adminAccountResponse.json()),
    );

    const inviteResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/account/members/invite", target.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(target.baseUrl).origin,
          cookie: adminCookie,
          [EXECUTOR_ORG_SELECTOR_HEADER]: adminAccount.organization.slug,
        },
        body: JSON.stringify({ email: memberEmail }),
      }),
    );
    expect(inviteResponse.ok, "the admin can invite the member").toBe(true);
    const invitation = decodeInvitation(yield* Effect.promise(() => inviteResponse.json()));

    const acceptResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/accept-invitation", target.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(target.baseUrl).origin,
          cookie: memberCookie,
        },
        body: JSON.stringify({ invitationId: invitation.id }),
      }),
    );
    expect(acceptResponse.ok, "the invited user accepts the membership").toBe(true);
    const acceptedCookie = sessionCookiePair(acceptResponse);
    expect(acceptedCookie, "acceptance returns a refreshed member session").not.toBe("");
    const memberIdentity = {
      ...member,
      headers: { ...member.headers, cookie: acceptedCookie },
      cookies: [
        {
          name: "wos-session",
          value: acceptedCookie.slice("wos-session=".length),
        },
      ],
    } satisfies Identity;

    yield* browser.session(memberIdentity, async ({ page, step }) => {
      await step("Resolve permission loading into explicit read-only access", async () => {
        let releaseMemberRequest = () => {};
        const memberRequestGate = new Promise<void>((resolve) => {
          releaseMemberRequest = resolve;
        });
        await page.route("**/api/account/members", async (route) => {
          await memberRequestGate;
          await route.continue();
        });
        const membersResponsePromise = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/account/members",
          { timeout: 30_000 },
        );

        await page.goto(`/${adminAccount.organization.slug}/org`, { waitUntil: "commit" });
        try {
          await page
            .getByTestId("organization-name-permission-loading")
            .waitFor({ timeout: 30_000 });
          expect(await page.getByTestId("organization-member-actions-loading").count()).toBe(1);
          expect(await page.getByTestId("organization-domain-actions-loading").count()).toBe(1);
          expect(await page.getByTestId("organization-members-loading").count()).toBe(1);
          expect(await page.getByTestId("organization-permission-read-only").count()).toBe(0);
          expect(await page.getByLabel("Organization name").count()).toBe(0);
          expect(await page.getByRole("button", { name: "Invite member" }).count()).toBe(0);

          releaseMemberRequest();
          const membersResponse = await membersResponsePromise;
          expect(membersResponse.ok(), "the member permission request succeeds").toBe(true);
          expect(
            membersResponse.request().headers()[EXECUTOR_ORG_SELECTOR_HEADER],
            "the member permission request uses the URL organization selector",
          ).toBe(adminAccount.organization.slug);
        } finally {
          releaseMemberRequest();
          await page.unroute("**/api/account/members");
        }

        await page.getByRole("heading", { name: "Organization", exact: true }).waitFor();
        await page.getByText(memberEmail, { exact: true }).waitFor({ timeout: 30_000 });
        await page.getByTestId("organization-permission-read-only").waitFor({ timeout: 30_000 });
      });

      await step("Verify administrative controls are absent", async () => {
        await page.getByText(adminAccount.organization.name, { exact: true }).first().waitFor();
        expect(await page.getByTestId("organization-permission-read-only").count()).toBe(1);
        expect(await page.getByTestId("organization-permission-failed").count()).toBe(0);
        expect(await page.getByLabel("Organization name").count()).toBe(0);
        expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Invite member" }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Add domain" }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Upgrade" }).count()).toBe(0);
      });

      const browserCookie = `wos-session=${
        (await page.context().cookies()).find((cookie) => cookie.name === "wos-session")?.value ??
        ""
      }`;
      const scopedHeaders = {
        "content-type": "application/json",
        origin: new URL(target.baseUrl).origin,
        cookie: browserCookie,
        [EXECUTOR_ORG_SELECTOR_HEADER]: adminAccount.organization.slug,
      };

      const renameResponse = await fetch(new URL("/api/account/name", target.baseUrl), {
        method: "PATCH",
        headers: scopedHeaders,
        body: JSON.stringify({ name: `Forbidden ${randomBytes(3).toString("hex")}` }),
      });
      const secondInviteResponse = await fetch(
        new URL("/api/account/members/invite", target.baseUrl),
        {
          method: "POST",
          headers: scopedHeaders,
          body: JSON.stringify({ email: `forbidden-${randomBytes(3).toString("hex")}@e2e.test` }),
        },
      );
      expect(renameResponse.status, "the API rejects a member organization rename").toBe(403);
      expect(secondInviteResponse.status, "the API rejects a member invitation").toBe(403);
    });
  }),
);
