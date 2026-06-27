// Cloud browser coverage for the first paint of an organization URL when the
// shared WorkOS session cookie is pinned to a different organization.
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
const RenameBody = Schema.Struct({ name: Schema.String });

const decodeOrganization = Schema.decodeUnknownSync(Organization);
const decodeSelectedAccount = Schema.decodeUnknownSync(SelectedAccount);
const decodeRenameBody = Schema.decodeUnknownSync(RenameBody);

const sessionCookiePair = (response: Response) => {
  const headers = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return headers.find((header) => header.startsWith("wos-session="))?.split(";")[0] ?? "";
};

const accountRequest = (baseUrl: string, cookie: string, organizationSlug: string) =>
  fetch(new URL("/api/account/me", baseUrl), {
    headers: {
      cookie,
      [EXECUTOR_ORG_SELECTOR_HEADER]: organizationSlug,
    },
  });

scenario(
  "Org first paint · the URL organization wins over a stale cookie organization",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const originalCookie = identity.headers?.cookie ?? "";
    const suffix = randomBytes(4).toString("hex");
    const urlOrganizationName = `URL Organization B ${suffix}`;
    const cookieOrganizationName = `Cookie Organization A ${suffix}`;

    const originalAccountResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/me", target.baseUrl), {
        headers: { cookie: originalCookie },
      }),
    );
    expect(originalAccountResponse.ok, "the original organization resolves").toBe(true);
    const originalAccount = decodeSelectedAccount(
      yield* Effect.promise(() => originalAccountResponse.json()),
    );

    const renameOriginalResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/account/name", target.baseUrl), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: new URL(target.baseUrl).origin,
          cookie: originalCookie,
          [EXECUTOR_ORG_SELECTOR_HEADER]: originalAccount.organization.slug,
        },
        body: JSON.stringify({ name: urlOrganizationName }),
      }),
    );
    expect(renameOriginalResponse.ok, "the URL organization receives its distinct name").toBe(true);

    const createCookieOrganizationResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/create-organization", target.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(target.baseUrl).origin,
          cookie: originalCookie,
        },
        body: JSON.stringify({ name: cookieOrganizationName }),
      }),
    );
    expect(
      createCookieOrganizationResponse.ok,
      "the second organization is created and selected in the session",
    ).toBe(true);
    const cookieOrganization = decodeOrganization(
      yield* Effect.promise(() => createCookieOrganizationResponse.json()),
    );
    const cookiePair = sessionCookiePair(createCookieOrganizationResponse);
    expect(cookiePair, "organization creation returns a refreshed session cookie").not.toBe("");
    const cookieValue = cookiePair.slice("wos-session=".length);
    const pinnedToCookieOrganization = {
      ...identity,
      headers: { ...identity.headers, cookie: cookiePair },
      cookies: [{ name: "wos-session", value: cookieValue }],
    } satisfies Identity;

    yield* browser.session(pinnedToCookieOrganization, async ({ page, step }) => {
      await step("Render URL organization B before account hydration completes", async () => {
        let releaseAccountRequests = () => {};
        let releaseMemberRequests = () => {};
        const accountRequestGate = new Promise<void>((resolve) => {
          releaseAccountRequests = resolve;
        });
        const memberRequestGate = new Promise<void>((resolve) => {
          releaseMemberRequests = resolve;
        });
        await page.route("**/api/account/me", async (route) => {
          await accountRequestGate;
          await route.continue();
        });
        await page.route("**/api/account/members", async (route) => {
          await memberRequestGate;
          await route.continue();
        });
        const hydratedAccountResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/account/me",
          { timeout: 30_000 },
        );
        const hydratedMemberResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/account/members",
          { timeout: 30_000 },
        );

        await page.goto(`/${originalAccount.organization.slug}/org`, { waitUntil: "commit" });
        const nameInput = page.getByLabel("Organization name");
        try {
          await page
            .getByTestId("organization-name-permission-loading")
            .waitFor({ timeout: 30_000 });
          await page.getByRole("button", { name: new RegExp(urlOrganizationName) }).waitFor();
          expect(
            await page.getByTestId("organization-member-actions-loading").count(),
            "the member action slot is reserved while permissions load",
          ).toBe(1);
          expect(
            await page.getByTestId("organization-domain-actions-loading").count(),
            "the domain action slot is reserved while permissions load",
          ).toBe(1);
          expect(await page.getByTestId("organization-members-loading").count()).toBe(1);
          expect(await nameInput.count(), "admin inputs do not render before role resolution").toBe(
            0,
          );
          expect(
            await page.getByTestId("organization-permission-read-only").count(),
            "loading is not presented as denied access",
          ).toBe(0);
          expect(
            await page.getByText(cookieOrganizationName, { exact: true }).count(),
            "the cookie organization is absent from the URL organization page",
          ).toBe(0);

          releaseAccountRequests();
          const response = await hydratedAccountResponse;
          expect(response.ok(), "account hydration succeeds for the URL organization").toBe(true);
          expect(
            response.request().headers()[EXECUTOR_ORG_SELECTOR_HEADER],
            "account hydration uses the URL organization selector",
          ).toBe(originalAccount.organization.slug);
          await page.getByTestId("organization-name-permission-loading").waitFor();
          expect(
            await nameInput.count(),
            "account hydration alone cannot reveal management controls",
          ).toBe(0);

          releaseMemberRequests();
          const membersResponse = await hydratedMemberResponse;
          expect(membersResponse.ok(), "the member role request succeeds").toBe(true);
          expect(
            membersResponse.request().headers()[EXECUTOR_ORG_SELECTOR_HEADER],
            "the permission request uses the URL organization selector",
          ).toBe(originalAccount.organization.slug);
        } finally {
          releaseAccountRequests();
          releaseMemberRequests();
        }

        await page.unroute("**/api/account/me");
        await page.unroute("**/api/account/members");
        await nameInput.waitFor({ timeout: 30_000 });
        expect(
          await nameInput.inputValue(),
          "the resolved admin form belongs to the URL organization",
        ).toBe(urlOrganizationName);
      });

      const renamedUrlOrganization = `${urlOrganizationName} Renamed`;

      await step("Rename URL organization B without mutating cookie organization A", async () => {
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "PATCH" &&
            new URL(response.url()).pathname === "/api/account/name",
          { timeout: 30_000 },
        );
        await page.getByLabel("Organization name").fill(renamedUrlOrganization);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const response = await responsePromise;
        expect(response.ok(), "the URL organization rename succeeds").toBe(true);
        expect(
          response.request().headers()[EXECUTOR_ORG_SELECTOR_HEADER],
          "the rename targets the URL organization",
        ).toBe(originalAccount.organization.slug);
        expect(
          decodeRenameBody(response.request().postDataJSON()).name,
          "the submitted name comes from the current URL organization form",
        ).toBe(renamedUrlOrganization);
      });

      const browserCookie = `wos-session=${
        (await page.context().cookies()).find((cookie) => cookie.name === "wos-session")?.value ??
        ""
      }`;
      expect(browserCookie, "the browser remains authenticated").not.toBe("wos-session=");

      const urlOrganizationResponse = await accountRequest(
        target.baseUrl,
        browserCookie,
        originalAccount.organization.slug,
      );
      const cookieOrganizationResponse = await accountRequest(
        target.baseUrl,
        browserCookie,
        cookieOrganization.slug,
      );
      expect(urlOrganizationResponse.ok, "URL organization B still resolves").toBe(true);
      expect(cookieOrganizationResponse.ok, "cookie organization A still resolves").toBe(true);
      const urlOrganizationAccount = decodeSelectedAccount(await urlOrganizationResponse.json());
      const cookieOrganizationAccount = decodeSelectedAccount(
        await cookieOrganizationResponse.json(),
      );
      expect(urlOrganizationAccount.organization.name).toBe(renamedUrlOrganization);
      expect(cookieOrganizationAccount.organization.name).toBe(cookieOrganizationName);
    });
  }),
);

scenario(
  "Org permissions · loading and request failure stay distinct before admin controls render",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const cookie = identity.headers?.cookie ?? "";
    const accountResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/me", target.baseUrl), {
        headers: { cookie },
      }),
    );
    expect(accountResponse.ok, "the administrator organization resolves").toBe(true);
    const account = decodeSelectedAccount(yield* Effect.promise(() => accountResponse.json()));

    yield* browser.session(identity, async ({ page, step }) => {
      await step(
        "Hold the first permission request on the server-rendered loading state",
        async () => {
          let failFirstRequest = () => {};
          let releaseRetryRequest = () => {};
          const firstRequestGate = new Promise<void>((resolve) => {
            failFirstRequest = resolve;
          });
          const retryRequestGate = new Promise<void>((resolve) => {
            releaseRetryRequest = resolve;
          });
          let memberRequestAttempt = 0;

          await page.route("**/api/account/members", async (route) => {
            memberRequestAttempt += 1;
            if (memberRequestAttempt === 1) {
              await firstRequestGate;
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ message: "permission lookup unavailable" }),
              });
              return;
            }
            await retryRequestGate;
            await route.continue();
          });
          const failedResponsePromise = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/account/members" &&
              response.status() === 503,
            { timeout: 30_000 },
          );

          await page.goto(`/${account.organization.slug}/org`, { waitUntil: "commit" });
          try {
            await page
              .getByTestId("organization-name-permission-loading")
              .waitFor({ timeout: 30_000 });
            expect(await page.getByTestId("organization-members-loading").count()).toBe(1);
            expect(await page.getByLabel("Organization name").count()).toBe(0);
            expect(await page.getByRole("button", { name: "Invite member" }).count()).toBe(0);
            expect(await page.getByTestId("organization-permission-read-only").count()).toBe(0);

            failFirstRequest();
            const failedResponse = await failedResponsePromise;
            expect(failedResponse.status(), "the first permission request fails visibly").toBe(503);
            await page.getByTestId("organization-permission-failed").waitFor({ timeout: 30_000 });
            await page.getByRole("button", { name: "Retry permissions" }).waitFor();
            expect(await page.getByTestId("organization-name-permission-loading").count()).toBe(0);
            expect(await page.getByLabel("Organization name").count()).toBe(0);
            expect(await page.getByRole("button", { name: "Invite member" }).count()).toBe(0);

            const retryResponsePromise = page.waitForResponse(
              (response) => new URL(response.url()).pathname === "/api/account/members",
              { timeout: 30_000 },
            );
            await page.getByRole("button", { name: "Retry permissions" }).click();
            await page
              .getByTestId("organization-name-permission-loading")
              .waitFor({ timeout: 30_000 });
            expect(await page.getByTestId("organization-members-loading").count()).toBe(1);
            expect(await page.getByTestId("organization-permission-failed").count()).toBe(0);
            expect(await page.getByLabel("Organization name").count()).toBe(0);

            releaseRetryRequest();
            const retryResponse = await retryResponsePromise;
            expect(retryResponse.ok(), "retrying the permission request succeeds").toBe(true);
            expect(
              retryResponse.request().headers()[EXECUTOR_ORG_SELECTOR_HEADER],
              "the retried permission request keeps the URL organization selector",
            ).toBe(account.organization.slug);

            await page.getByLabel("Organization name").waitFor({ timeout: 30_000 });
            expect(await page.getByLabel("Organization name").inputValue()).toBe(
              account.organization.name,
            );
            await page.getByRole("button", { name: "Invite member" }).waitFor();
            expect(await page.getByTestId("organization-permission-failed").count()).toBe(0);
          } finally {
            failFirstRequest();
            releaseRetryRequest();
            await page.unroute("**/api/account/members");
          }
        },
      );
    });
  }),
);
