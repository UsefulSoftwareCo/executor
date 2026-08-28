// Cloud-specific (browser): the agent-connect panel defaults to Remote HTTP
// with an org-scoped /mcp URL, and the Standard I/O tab switches the install
// command. Driven through the Integrations page as a fresh user with an org.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit, settle } from "../src/surfaces/browser";

scenario(
  "Connect · the agent-connect panel gives working copy for both transports",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the Integrations page", async () => {
        await visit(page, "/");
        await page.getByText("Connect an agent").first().waitFor();
      });

      const command = () => page.locator("code").first().innerText();

      await step("Remote HTTP is the default transport", async () => {
        await page.getByText("Connect an agent").first().waitFor();
      });
      const httpCommand = await command();
      expect(httpCommand, "the default command adds the MCP server").toContain("npx add-mcp");
      // Org-scoped via the org's URL slug, not the raw org_ id.
      expect(httpCommand, "the HTTP command is org-scoped").toMatch(/\/[a-z0-9-]+\/mcp/);
      expect(httpCommand, "the slug form, not the org_ id").not.toMatch(/\/org_[^/]+\/mcp/);
      expect(httpCommand).toContain("--transport http");

      await step("Switch to Standard I/O", async () => {
        await page.getByRole("tab", { name: "Standard I/O" }).click();
        await settle(page);
      });
      const stdioCommand = await command();
      expect(stdioCommand, "the command changed for stdio").not.toBe(httpCommand);
      expect(stdioCommand, "stdio does not use the HTTP transport").not.toContain(
        "--transport http",
      );

      await step("Choose connection-specific install options", async () => {
        await page.getByRole("tab", { name: "Remote HTTP" }).click();
        await page.getByRole("button", { name: "Advanced" }).click();
        await page.getByRole("switch", { name: "Artifacts" }).click();
        await page.getByRole("switch", { name: "Integration search tools" }).click();
        await page.getByRole("combobox", { name: "Elicitation mode" }).selectOption("browser");
        await settle(page);
      });
      const customizedHttpCommand = await command();
      expect(customizedHttpCommand, "the HTTP command is restored").toContain("--transport http");
      expect(customizedHttpCommand, "disabled artifacts are encoded per connection").toContain(
        "artifacts=false",
      );
      expect(customizedHttpCommand, "integration search is encoded per connection").toContain(
        "search_tools=true",
      );
      expect(customizedHttpCommand, "browser approval is encoded per connection").toContain(
        "elicitation_mode=browser",
      );

      await step("Reload with the install options preserved", async () => {
        await page.reload({ waitUntil: "networkidle" });
        await page.getByText("Connect an agent").first().waitFor();
        await page.getByRole("button", { name: "Advanced" }).click();
      });
      expect(await page.getByRole("switch", { name: "Artifacts" }).isChecked()).toBe(false);
      expect(await page.getByRole("switch", { name: "Integration search tools" }).isChecked()).toBe(
        true,
      );
      expect(await page.getByRole("combobox", { name: "Elicitation mode" }).inputValue()).toBe(
        "browser",
      );
      expect(await command(), "the same customized command survives a reload").toBe(
        customizedHttpCommand,
      );

      await step("Preserve the selected transport across another reload", async () => {
        await page.getByRole("tab", { name: "Standard I/O" }).click();
        await settle(page);
        await page.reload({ waitUntil: "networkidle" });
        await page.getByText("Connect an agent").first().waitFor();
      });
      expect(
        await page.getByRole("tab", { name: "Standard I/O" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(await command(), "the persisted stdio command retains compatible options").toContain(
        "mcp --no-artifacts --search-tools",
      );
    });
  }),
);
