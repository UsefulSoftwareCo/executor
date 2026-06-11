// Cross-target (browser): the multi-method auth add flow, end to end through
// the real web UI against a live loopback MCP test server (the target's dev
// server probes it). A no-auth server gets an API key declared at add time —
// the case where the server advertises nothing but the user knows better.
// The session video + per-step screenshots are the artifact.
//
// The OAuth-detected and connect-modal variants are selfhost-only (see
// selfhost/auth-methods-ui.test.ts): the cloud dev harness (workerd) cannot
// shape-probe loopback servers and its vault stub takes no pasted credentials.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Auth methods · the add flow declares an API key alongside the detected method",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      // An OPEN server: the probe connects without auth, so the method list
      // seeds with the detected "no authentication" row. The server name is
      // unique per run — the derived integration namespace must not collide
      // on targets whose identities share one tenant (selfhost admin).
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({ name: `open-mcp-${randomBytes(3).toString("hex")}` }),
      );
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the add-MCP flow pointed at the server", async () => {
          await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`, {
            waitUntil: "networkidle",
          });
          // The URL auto-probes (debounced); the method list appears once
          // the probe lands.
          await page.getByText("How does this server authenticate?").waitFor();
        });

        await step("The probe seeded the detected method", async () => {
          await page.getByText("Method 1 · Detected").waitFor();
        });

        await step("Declare an API key method alongside it", async () => {
          await page.getByRole("button", { name: "Add method" }).click();
          await page.getByText("Method 2").waitFor();
          // The new row opens on the API key editor with the standard
          // Authorization-header placement prefilled.
          const headerName = page.getByPlaceholder("Authorization").last();
          await headerName.waitFor();
        });

        await step("Add the source with both methods", async () => {
          await page.getByRole("button", { name: "Add source" }).click();
          // onComplete routes to the new integration's detail hub.
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          await page.getByText("Connections").first().waitFor();
        });

        await step("The connect modal offers both methods", async () => {
          await page.getByRole("button", { name: "Add connection" }).first().click();
          await page.getByRole("tab", { name: "No authentication" }).waitFor();
          await page.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
        });

        const tabs = await page.getByRole("tab").allInnerTexts();
        expect(tabs.join(", "), "both declared methods are selectable").toContain(
          "No authentication",
        );
        expect(tabs.join(", ")).toContain("API key (Authorization)");
      });
    }),
  ),
);
