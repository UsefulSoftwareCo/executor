import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const gmailSpecUrl = "https://integrations.sh/specs/google/google-gmail.json";
const outlookSpecUrl = "https://integrations.sh/specs/microsoft-graph/mail.json";

// Provider products are ordinary integrations.sh results now. Stub both the
// search response and the per-domain surface documents so this scenario proves
// the full registry-card-to-add-flow journey without depending on the service.
scenario(
  "Google and Microsoft products are registry cards that resolve into prefilled add flows",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Stub the Google and Microsoft registry products", async () => {
        await page.route("https://integrations.sh/api/search*", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              results: [
                {
                  domain: "gmail.com",
                  name: "Gmail",
                  description: "Email from Google.",
                  kinds: ["openapi"],
                  url: "https://integrations.sh/gmail.com/",
                },
                {
                  domain: "graph.microsoft.com",
                  name: "Outlook Mail",
                  description: "Email from Microsoft.",
                  kinds: ["openapi"],
                  url: "https://integrations.sh/graph.microsoft.com/",
                },
              ],
            },
          }),
        );
        await page.route("https://integrations.sh/api/gmail.com/surface", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              version: 3,
              domain: "gmail.com",
              surfaces: [{ type: "http", slug: "google-gmail", spec: gmailSpecUrl }],
            },
          }),
        );
        await page.route("https://integrations.sh/api/graph.microsoft.com/surface", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              version: 3,
              domain: "graph.microsoft.com",
              surfaces: [{ type: "http", slug: "outlook-mail", spec: outlookSpecUrl }],
            },
          }),
        );
      });

      await step("Search for Gmail and see its registry card and domain", async () => {
        await visit(page, "/integrations/browse");
        const search = page.getByPlaceholder(/Search integrations, or paste a URL/);
        await search.fill("gmail");
        const card = page.getByTestId("catalog-gmail.com-openapi");
        await card.waitFor();
        await card.getByText("gmail.com").waitFor();
      });

      await step("Add Gmail with its registry URL and namespace prefilled", async () => {
        await page
          .getByTestId("catalog-gmail.com-openapi")
          .getByRole("button", { name: "Add Gmail API" })
          .click();
        await page.waitForURL(/\/integrations\/add\/openapi/);
        const url = new URL(page.url());
        expect(url.searchParams.get("url")).toBe(gmailSpecUrl);
        expect(url.searchParams.get("namespace")).toBe("google-gmail");
      });

      await step("Search for Outlook and see its separate registry card and domain", async () => {
        await visit(page, "/integrations/browse");
        await page.getByPlaceholder(/Search integrations, or paste a URL/).fill("outlook");
        const card = page.getByTestId("catalog-graph.microsoft.com-openapi");
        await card.waitFor();
        await card.getByText("graph.microsoft.com").waitFor();
      });
    });
  }),
);
