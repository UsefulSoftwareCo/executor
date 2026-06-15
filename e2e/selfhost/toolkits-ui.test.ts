// Selfhost · Slice 2 (console UI): the Toolkits page renders through the real
// web console and its editor writes a toolkit — access modes, per-connection
// notes, and all — back to the toolkits API. This is the end-to-end proof of
// the client plugin wiring: the page only mounts if the Vite plugin bundled
// `@executor-js/plugin-toolkits/client`, the nav resolved, and the typed atom
// client reached `/api/toolkits`.
//
// We drive the real controls (the off/read/full segment + the note field),
// create the toolkit, then read it back through the typed API and assert the
// persisted slice — so the editor's access-map -> wire-entry transform (incl.
// note trimming) is covered through the UI, not a unit test. The personal
// connection we seed is owner-scoped to this fresh identity, so it is a
// deterministic anchor even though selfhost identities share one tenant.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin(), toolkitsPlugin()] as const);
const fresh = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

scenario(
  "Toolkits · the console editor creates a toolkit and persists its access slice",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Seed a PERSONAL connection (owner "user") so it shows only for this
      // identity — the editor's Access section should surface it.
      const slug = fresh("tkui");
      const connName = fresh("conn");
      const token = `tok-${randomBytes(6).toString("hex")}`;
      const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === `Bearer ${token}`),
        },
      });
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: `Greeting ${slug}`,
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [
            {
              type: "apiKey",
              headers: {
                Authorization: ["Bearer ", { type: "variable", name: "token" }],
              },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "user",
          name: ConnectionName.make(connName),
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("header"),
          value: token,
        },
      });

      const toolkitName = `Kit ${randomBytes(3).toString("hex")}`;
      const connTestId = `tk-conn ${slug} ${connName}`;

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Toolkits page", async () => {
          await page.goto("/plugins/toolkits/", { waitUntil: "networkidle" });
          await page.getByRole("heading", { name: "Toolkits", exact: true }).waitFor();
          await page.getByRole("heading", { name: "Workspace toolkits" }).waitFor();
          await page.getByRole("heading", { name: "Personal toolkits" }).waitFor();
        });

        await step("Start a new personal toolkit", async () => {
          // Two "New toolkit" buttons (workspace, personal); the second is the
          // personal section.
          await page.getByRole("button", { name: "New toolkit" }).nth(1).click();
          await page.getByRole("heading", { name: "Access" }).waitFor();
          // The personal connection appears (proves the personal scope tier +
          // connection wiring).
          await page.getByText(connName).first().waitFor();
        });

        await step("Name it, grant the connection full access, add a note", async () => {
          // The title is the first textbox in the editor (briefing is below it).
          await page.getByRole("textbox").first().fill(toolkitName);
          // Grant Full on this connection's row (testid keeps it unambiguous).
          const row = page.getByTestId(connTestId);
          await row.getByRole("button", { name: "Full", exact: true }).click();
          // The note field appears once access != off; padded to prove trimming.
          await row.getByRole("textbox").fill("  wiki only  ");
        });

        await step("Create it", async () => {
          await page.getByRole("button", { name: "Create toolkit" }).click();
          // Back on the list, the New toolkit buttons return and the card shows.
          await page.getByRole("button", { name: "New toolkit" }).first().waitFor();
          await page.getByText(toolkitName).first().waitFor();
        });

        let toolkitId = "";

        await step("Opening a toolkit card updates the URL to its id", async () => {
          await page.getByText(toolkitName).first().click();
          await page.getByRole("heading", { name: "Access" }).waitFor();
          await page.waitForURL((url) => {
            const segments = url.pathname.split("/").filter(Boolean);
            const last = segments[segments.length - 1];
            return last !== undefined && last !== "toolkits";
          });
          toolkitId = new URL(page.url()).pathname.split("/").filter(Boolean).pop() ?? "";
          expect(toolkitId.length, "card open exposes the toolkit id in the URL").toBeGreaterThan(
            0,
          );
          await page.getByRole("button", { name: "← Toolkits" }).click();
          await page.getByRole("heading", { name: "Workspace toolkits" }).waitFor();
        });

        await step("Deep-linking to a toolkit opens the editor with its name", async () => {
          await page.goto(`/plugins/toolkits/${toolkitId}`, {
            waitUntil: "networkidle",
          });
          await page.getByRole("heading", { name: "Access" }).waitFor();
          expect(
            await page.getByRole("textbox").first().inputValue(),
            "deep link opens the editor with the toolkit name",
          ).toBe(toolkitName);
        });

        await step("Browser back returns to the toolkit list", async () => {
          await page.goBack({ waitUntil: "networkidle" });
          await page.waitForURL(
            (url) =>
              url.pathname.endsWith("/plugins/toolkits/") ||
              url.pathname.endsWith("/plugins/toolkits"),
          );
          await page.getByRole("heading", { name: "Workspace toolkits" }).waitFor();
        });

        await step("New toolkit navigates to /new/workspace", async () => {
          await page.getByRole("button", { name: "New toolkit" }).first().click();
          await page.waitForURL((url) => url.pathname.endsWith("/new/workspace"));
          await page.getByRole("heading", { name: "Access" }).waitFor();
        });
      });

      // Read the toolkit back through the typed API: the editor's write carried
      // the scope, access mode, and trimmed note.
      const all = yield* client.toolkits.list();
      const created = all.find((t) => t.name === toolkitName);
      expect(created, "the toolkit the UI created is persisted").toBeDefined();
      expect(created?.scope).toBe("personal");
      expect(created?.connections).toEqual([
        {
          integration: slug,
          connection: connName,
          access: "full",
          note: "wiki only",
        },
      ]);
    }),
  ),
);
