// Cross-target (browser): MCP tool-catalog freshness, FILMED through the real
// web UI. The session video + per-step screenshots are the artifact: a user
// adds a live MCP server, sees its tool in the Tools tab, runs a tool that
// renames the server's catalog mid-call (the server pushes
// `notifications/tools/list_changed` on the open connection), and then WATCHES
// the Tools tab serve the renamed catalog on the next visit — no Refresh
// click anywhere in the journey. The old behavior freezes this UI on the
// stale tool forever.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeMutableCatalogMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "MCP catalog · the Tools tab follows a server-side rename after a list_changed notification",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;

      // A real MCP server whose `rename_greet` tool renames `greet` →
      // `greet_v2` mid-call and notifies the open connection. The server name
      // is unique per run (it derives the integration namespace) so runs can't
      // collide on targets whose identities share one tenant.
      const mutable = makeMutableCatalogMcpServer({
        name: `catalog-sync-${randomBytes(3).toString("hex")}`,
      });
      const server = yield* serveMcpServer(mutable.factory);
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the add-MCP flow pointed at the live server", async () => {
          await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`, {
            waitUntil: "networkidle",
          });
          // The URL auto-probes (debounced); the method list appears once the
          // probe lands — an open server seeds the detected no-auth method.
          await page.getByText("How does this server authenticate?").waitFor();
          await page.getByText("Method 1 · Detected").waitFor();
        });

        await step("Add the source", async () => {
          await page.getByRole("button", { name: "Add source" }).click();
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          await page.getByText("Connections").first().waitFor();
        });

        await step("Connect with no authentication", async () => {
          await page.getByRole("button", { name: "Add connection" }).first().click();
          await page.getByRole("tab", { name: "No authentication" }).waitFor();
          await page.getByRole("button", { name: "Add connection" }).last().click();
          // The connect flow dials the server and produces the tool catalog.
          await page.getByText("Connection added").waitFor();
        });

        // Tools render as a collapsed dotted-name tree (namespace → leaf);
        // typing in the filter box expands every match, so it is both the
        // reveal mechanism and a search the video shows off.
        const filterTools = async (query: string) => {
          const filter = page.getByPlaceholder(/^Filter \d+ tools/);
          await filter.waitFor();
          await filter.fill(query);
        };

        // A tool's tree row is a button whose accessible name is the full
        // leaf label — filter-highlight <mark> spans inside the label don't
        // fragment it, so exact role queries can't false-match a substring
        // (`greet` inside `greet_v2`).
        const toolRow = (name: string) => page.getByRole("button", { name, exact: true }).first();

        await step("The Tools tab lists the server's v1 catalog", async () => {
          await page.getByRole("tab", { name: "Tools" }).click();
          await filterTools("greet");
          await toolRow(mutable.initialToolName).waitFor();
          await toolRow("rename_greet").waitFor();
        });

        await step("Run rename_greet — the server renames its catalog mid-call", async () => {
          await toolRow("rename_greet").click();
          await page.getByRole("tab", { name: "Run" }).click();
          await page.getByRole("button", { name: "Run", exact: true }).click();
          // The result card proves the call reached the server (the payload
          // renders inside a highlighted code block, so assert the badge);
          // the server pushed list_changed on the same open connection.
          await page.getByText("Result").first().waitFor();
          await page.getByText("Success").first().waitFor();
        });

        await step("Revisit Tools — the catalog followed the rename by itself", async () => {
          // Re-enter the page: a fresh tools read. The list_changed the server
          // sent during the call marked the catalog stale, so THIS read
          // re-lists — the renamed tool appears with no Refresh click.
          await page.reload({ waitUntil: "networkidle" });
          await page.getByRole("tab", { name: "Tools" }).click();
          await filterTools("greet");
          await toolRow(mutable.renamedToolName).waitFor({ timeout: 30_000 });
        });

        const staleToolStillListed = await toolRow(mutable.initialToolName)
          .isVisible()
          .catch(() => false);
        expect(staleToolStillListed, "the retired tool left the catalog").toBe(false);
      });
    }),
  ),
);
