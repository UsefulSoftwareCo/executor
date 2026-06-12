// Cross-target (browser): the UI side of per-call server selection. When a
// pasted spec declares more than one server, the Add OpenAPI source form turns
// the Base URL field into a picker over those servers and relabels it an
// optional override — the host is otherwise resolved per tool call. The session
// video + per-step screenshots are the artifact; this scenario skips on targets
// without a browser surface (selfhost today).
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

// Two servers — production and staging — so the form offers a base-URL picker
// instead of the single locked input a one-server spec gets.
const multiServerSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Regions API", version: "1.0.0" },
  servers: [
    { url: "https://api.example.com", description: "Production" },
    { url: "https://staging.example.com", description: "Staging" },
  ],
  paths: {
    "/ping": { get: { operationId: "ping", responses: { "200": { description: "pong" } } } },
  },
});

scenario(
  "OpenAPI · the add form offers a server picker and an optional base URL for a multi-server spec",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Add OpenAPI source form", async () => {
          await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
          await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
        });

        await step("Paste a spec that declares two servers", async () => {
          await page.getByPlaceholder("https://api.example.com/openapi.json").fill(multiServerSpec);
          // The form auto-analyzes (debounced) and renders the preview details,
          // where the base URL is now an OPTIONAL override.
          await page.getByText("Base URL override (optional)").waitFor({ timeout: 20_000 });
        });

        await step("The base URL is optional — the server is chosen per call", async () => {
          // The hint spells out that leaving it empty defers the host (and its
          // variables) to each tool call: the heart of per-call selection.
          await page.getByText(/leave empty to choose the server.*per tool call/i).waitFor();
        });

        await step("The field is a picker over the spec's two servers", async () => {
          // Opening the combobox reveals both declared servers as choices.
          await page.getByPlaceholder("https://api.example.com", { exact: true }).click();
          const options = page.getByRole("option");
          await options.filter({ hasText: "staging.example.com" }).waitFor({ timeout: 10_000 });
          const labels = await options.allInnerTexts();
          expect(
            labels.join(" | "),
            "both declared servers are offered as base-URL choices",
          ).toEqual(expect.stringContaining("https://staging.example.com"));
          expect(labels.join(" | "), "production is offered too").toEqual(
            expect.stringContaining("https://api.example.com"),
          );
        });
      });
    }),
  ),
);
