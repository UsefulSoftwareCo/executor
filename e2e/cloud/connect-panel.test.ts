// Cloud-specific (browser): the agent-connect panel defaults to Remote HTTP
// with an org-scoped /mcp URL, and the Standard I/O tab switches the install
// command. Driven through the Integrations page as a fresh user with an org.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Connect · the agent-connect panel gives working copy for both transports",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the Integrations page", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByText("Connect an agent").first().waitFor();
      });

      const command = () => page.locator("code").first().innerText();

      await step("Remote HTTP is the default transport", async () => {
        await page.getByText("Connect an agent").first().waitFor();
      });
      const httpCommand = await command();
      expect(httpCommand, "the default command adds the MCP server").toContain("npx add-mcp");
      expect(httpCommand, "the HTTP command is org-scoped").toMatch(/\/org_[^/]+\/mcp/);
      expect(httpCommand).toContain("--transport http");

      await step("Switch to Standard I/O", async () => {
        await page.getByRole("tab", { name: "Standard I/O" }).click();
        await page.waitForLoadState("networkidle");
      });
      const stdioCommand = await command();
      expect(stdioCommand, "the command changed for stdio").not.toBe(httpCommand);
      expect(stdioCommand, "stdio does not use the HTTP transport").not.toContain(
        "--transport http",
      );

      await step("Switch back to Remote HTTP", async () => {
        await page.getByRole("tab", { name: "Remote HTTP" }).click();
        await page.waitForLoadState("networkidle");
      });
      expect(await command(), "the HTTP command is restored").toContain("--transport http");
    });
  }),
);
