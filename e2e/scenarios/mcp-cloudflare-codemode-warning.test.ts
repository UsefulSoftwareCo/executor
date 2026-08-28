// Cloudflare's MCP server defaults to code mode, which hides the tool catalog
// behind a single code-execution tool. Executor already provides the
// code-execution surface, so the add-MCP flow warns when a Cloudflare URL
// misses the `?codemode=false` opt-out. This guards the warning and that it
// clears once the opt-out is added; the probe's outcome is irrelevant to it.
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const urlField = "https://mcp.example.com";
const warning = "Cloudflare code mode is on";

scenario(
  "MCP add flow · a Cloudflare URL without codemode=false gets the opt-out warning",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the add-MCP flow", async () => {
        await page.goto("/integrations/add/mcp", { waitUntil: "networkidle" });
        await page.getByPlaceholder(urlField).waitFor();
      });

      await step("Typing the Cloudflare URL without the opt-out shows the warning", async () => {
        await page.getByPlaceholder(urlField).fill("https://mcp.cloudflare.com/mcp");
        await page.getByText(warning).waitFor();
      });

      await step("Appending ?codemode=false clears the warning", async () => {
        // The same placeholder survives the probe's re-render, so this resolves
        // in both the bare-URL and probed layouts.
        await page.getByPlaceholder(urlField).fill("https://mcp.cloudflare.com/mcp?codemode=false");
        await page.getByText(warning).waitFor({ state: "hidden" });
      });
    });
  }),
);
