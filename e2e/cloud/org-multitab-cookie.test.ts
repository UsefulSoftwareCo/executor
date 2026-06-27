// Cloud browser coverage for two tabs sharing one cookie jar while their URLs
// select different organizations. Distinct persisted policies make accidental
// cross-tab re-scoping visible in both the network and the rendered page.
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
  "Org tabs · two URL-scoped organizations retain independent resources",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page: tab1, step }) => {
      const suffix = randomBytes(4).toString("hex");
      const organizationA = `Multitab A ${suffix}`;
      const organizationB = `Multitab B ${suffix}`;
      const policyA = `multitab-a-${suffix}.*`;
      const policyB = `multitab-b-${suffix}.*`;

      await step("Create organization A and its policy in tab 1", async () => {
        await tab1.goto("/", { waitUntil: "networkidle" });
        await tab1.getByPlaceholder("Northwind Labs").fill(organizationA);
        await tab1.getByRole("button", { name: "Create organization" }).click();
        await tab1.getByText("Connect your MCP client").waitFor({ timeout: 30_000 });
        await tab1.getByRole("button", { name: "Continue to app" }).click();
        await tab1.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
      });

      const slugA = new URL(tab1.url()).pathname.split("/")[1]!;

      await step("Persist organization A data with an A selector", async () => {
        await tab1.goto(`/${slugA}/policies`, { waitUntil: "networkidle" });
        const request = await createPolicy(tab1, policyA);
        expect(
          request.headers()["x-executor-organization"],
          "organization A policy writes use the A URL selector",
        ).toBe(slugA);
      });

      await step("Create organization B and its distinct policy in tab 1", async () => {
        await tab1.getByRole("button", { name: /Test User/ }).click();
        await tab1.getByRole("menuitem", { name: organizationA, exact: true }).click();
        const submenu = tab1.locator('[data-slot="dropdown-menu-sub-content"]');
        await submenu.waitFor({ state: "visible" });
        await submenu.getByText("Create organization", { exact: true }).click();
        await tab1.getByText("Add another organization").waitFor();
        await tab1.getByPlaceholder("Northwind Labs").fill(organizationB);
        await tab1.getByRole("button", { name: "Create organization" }).click();
        await tab1.waitForURL(
          (url) => url.pathname.endsWith("/policies") && url.pathname !== `/${slugA}/policies`,
          { timeout: 30_000 },
        );
      });

      const slugB = new URL(tab1.url()).pathname.split("/")[1]!;
      expect(slugB, "organization B has a distinct URL slug").not.toBe(slugA);

      await step("Persist organization B data with a B selector", async () => {
        const request = await createPolicy(tab1, policyB);
        expect(
          request.headers()["x-executor-organization"],
          "organization B policy writes use the B URL selector",
        ).toBe(slugB);
        expect(await tab1.getByText(policyA, { exact: true }).count()).toBe(0);
      });

      const cookieWhileInB = await sessionCookieValue(tab1);
      expect(cookieWhileInB, "organization creation leaves a real browser session").not.toBe("");

      const tab2 = await tab1.context().newPage();

      await step("Tab 2 renders organization A data from the A URL", async () => {
        const responsePromise = policyResponse(tab2, "GET");
        await tab2.goto(`/${slugA}/policies`, { waitUntil: "networkidle" });
        const response = await responsePromise;
        expect(response.ok(), "organization A policies load in tab 2").toBe(true);
        expect(
          response.request().headers()["x-executor-organization"],
          "tab 2 requests remain scoped to organization A",
        ).toBe(slugA);
        await tab2.getByText(policyA, { exact: true }).waitFor();
        expect(await tab2.getByText(policyB, { exact: true }).count()).toBe(0);
      });

      await step("Tab 1 still renders organization B data from the B URL", async () => {
        const responsePromise = policyResponse(tab1, "GET");
        await tab1.reload({ waitUntil: "networkidle" });
        const response = await responsePromise;
        expect(new URL(tab1.url()).pathname, "tab 1 stays on organization B").toBe(
          `/${slugB}/policies`,
        );
        expect(
          response.request().headers()["x-executor-organization"],
          "tab 1 requests remain scoped to organization B",
        ).toBe(slugB);
        await tab1.getByRole("button", { name: new RegExp(organizationB) }).waitFor();
        await tab1.getByText(policyB, { exact: true }).waitFor();
        expect(await tab1.getByText(policyA, { exact: true }).count()).toBe(0);
      });

      expect(
        await sessionCookieValue(tab1),
        "opening organization A in tab 2 does not rewrite the shared cookie",
      ).toBe(cookieWhileInB);
    });
  }),
);

scenario(
  "Org scope · plugin API requests carry the URL organization selector",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Header Probe", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the OpenAPI add form", async () => {
        await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
        await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
      });

      const organizationSlug = new URL(page.url()).pathname.split("/")[1];
      expect(organizationSlug, "the add form lands on an organization URL").toBeTruthy();

      await step("Paste an inline spec", async () => {
        const previewRequest = page.waitForRequest(
          (request) => request.url().includes("/api/openapi/preview"),
          { timeout: 15_000 },
        );

        await page.getByPlaceholder("https://api.example.com/openapi.json").fill(spec);

        expect(
          (await previewRequest).headers()["x-executor-organization"],
          "plugin preview requests use the URL organization selector",
        ).toBe(organizationSlug);
      });
    });
  }),
);
