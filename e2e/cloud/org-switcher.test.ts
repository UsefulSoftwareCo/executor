// Cloud browser coverage for URL-driven organization switching. A user creates
// distinct resources in organization A and organization B, then switches back
// through the public menu. The route intent, request selector, visible data,
// and shared session cookie are all asserted at each boundary.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const policyResponse = (page: Page, method: "GET" | "POST") =>
  page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname === "/api/policies",
    { timeout: 30_000 },
  );

const createPolicy = async (page: Page, pattern: string) => {
  const responsePromise = policyResponse(page, "POST");
  await page.locator("#policy-pattern").fill(pattern);
  await page.getByRole("button", { name: "Add policy" }).click();
  const response = await responsePromise;
  expect(response.ok(), `creating ${pattern} succeeds`).toBe(true);
  await page.getByText(pattern, { exact: true }).waitFor();
  return response.request();
};

const sessionCookieValue = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === "wos-session")?.value ?? "";

scenario(
  "Organizations · A/B/A switching preserves route intent and isolates resources",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page, step }) => {
      const suffix = randomBytes(4).toString("hex");
      const organizationA = `Switcher A ${suffix}`;
      const organizationB = `Switcher B ${suffix}`;
      const policyA = `switcher-a-${suffix}.*`;
      const policyB = `switcher-b-${suffix}.*`;

      await step("Create organization A through onboarding", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByPlaceholder("Northwind Labs").fill(organizationA);
        await page.getByRole("button", { name: "Create organization" }).click();
        await page.getByText("Connect your MCP client").waitFor({ timeout: 30_000 });
        await page.getByRole("button", { name: "Continue to app" }).click();
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
      });

      const slugA = new URL(page.url()).pathname.split("/")[1]!;

      await step("Create an organization A policy on a deep route", async () => {
        await page.goto(`/${slugA}/policies?view=switcher#rules`, {
          waitUntil: "networkidle",
        });
        const request = await createPolicy(page, policyA);
        expect(
          request.headers()["x-executor-organization"],
          "organization A writes use its URL selector",
        ).toBe(slugA);
      });

      await step("Create organization B without losing the current route", async () => {
        await page.getByRole("button", { name: /Test User/ }).click();
        await page.getByRole("menuitem", { name: organizationA, exact: true }).click();
        const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]');
        await submenu.waitFor({ state: "visible" });
        await submenu.getByText("Create organization", { exact: true }).click();
        await page.getByText("Add another organization").waitFor();
        await page.getByPlaceholder("Northwind Labs").fill(organizationB);
        await page.getByRole("button", { name: "Create organization" }).click();
        await page.waitForURL(
          (url) =>
            url.pathname.endsWith("/policies") &&
            url.pathname !== `/${slugA}/policies` &&
            url.search === "?view=switcher" &&
            url.hash === "#rules",
          { timeout: 30_000 },
        );
        await page.getByRole("button", { name: new RegExp(organizationB) }).waitFor();
      });

      const slugB = new URL(page.url()).pathname.split("/")[1]!;
      expect(slugB, "organization B has a distinct URL slug").not.toBe(slugA);

      await step("Create an isolated organization B policy", async () => {
        const request = await createPolicy(page, policyB);
        expect(
          request.headers()["x-executor-organization"],
          "organization B writes use its URL selector",
        ).toBe(slugB);
        expect(await page.getByText(policyA, { exact: true }).count()).toBe(0);
      });

      const cookieWhileInB = await sessionCookieValue(page);
      expect(cookieWhileInB, "organization creation leaves a real browser session").not.toBe("");

      await step("Switch from organization B back to A through the public menu", async () => {
        const policiesResponse = policyResponse(page, "GET");
        await page.getByRole("button", { name: /Test User/ }).click();
        await page.getByRole("menuitem", { name: organizationB, exact: true }).click();
        const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]');
        await submenu.waitFor({ state: "visible" });
        await submenu.getByRole("menuitem", { name: organizationA, exact: true }).click();
        await page.waitForURL(
          (url) =>
            url.pathname === `/${slugA}/policies` &&
            url.search === "?view=switcher" &&
            url.hash === "#rules",
          { timeout: 30_000 },
        );

        const response = await policiesResponse;
        expect(response.ok(), "organization A policies reload successfully").toBe(true);
        expect(
          response.request().headers()["x-executor-organization"],
          "the first request after switching back uses organization A",
        ).toBe(slugA);
        await page.getByRole("button", { name: new RegExp(organizationA) }).waitFor();
        await page.getByText(policyA, { exact: true }).waitFor();
        expect(await page.getByText(policyB, { exact: true }).count()).toBe(0);
      });

      expect(
        await sessionCookieValue(page),
        "URL switching does not rewrite the shared session cookie",
      ).toBe(cookieWhileInB);
    });
  }),
);
