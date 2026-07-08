// Local-only: custom tool local-directory sources can browse the user's own
// filesystem through the local app. The shared self-host target intentionally
// does not expose this source kind.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { withLocalServer } from "./local-server";

scenario(
  "Local custom tools · the directory picker selects a local source path",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();
    const fixtureRoot = mkdtempSync(join(homedir(), ".executor-picker-e2e-"));
    const fixtureDir = join(fixtureRoot, "picked-tools");
    mkdirSync(join(fixtureDir, "tools"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({
        name: "picked-tools",
        version: "0.0.0",
        private: true,
        dependencies: { zod: "^4.1.13" },
      }),
    );
    writeFileSync(
      join(fixtureDir, "tools", "echo.ts"),
      `
import { z } from "zod";
import { defineTool } from "executor:app";

export default defineTool({
  description: "Echo a picker message.",
  input: z.object({ message: z.string() }),
  handler(input) {
    return { echoed: \`local-picker:\${input.message}\` };
  },
});
`,
    );

    yield* withLocalServer(cli, runDir, ({ url }) =>
      browser.session(identity, async ({ page, step }) => {
        await step("Open custom tools from the local console", async () => {
          const addSourceUrl = new URL(url);
          addSourceUrl.pathname = "/integrations/add/apps";
          await page.goto(addSourceUrl.toString(), {
            waitUntil: "domcontentloaded",
          });
          await page.getByRole("heading", { name: "Add custom tools" }).waitFor({
            timeout: 60_000,
          });
        });

        await step("Browse to a local directory and select it", async () => {
          await page.getByRole("button", { name: "Directory path" }).click();
          const pathInput = page.getByPlaceholder("/Users/me/tools");
          await pathInput.fill(fixtureRoot);
          await page.getByRole("button", { name: "Browse" }).click();
          const dialog = page.getByRole("dialog", { name: "Choose directory" });
          await dialog.getByRole("button", { name: "picked-tools" }).click();
          await dialog.getByRole("button", { name: "Select" }).click();
          expect(await pathInput.inputValue()).toBe(fixtureDir);
        });

        await step("Sync the picked directory as a custom tools source", async () => {
          await page.getByRole("button", { name: "Sync source" }).click();
          await page.waitForURL(/\/integrations\/picked-tools(?:\?|$)/, { timeout: 90_000 });
          await page.getByLabel("Source").getByText("1 tool").waitFor({ timeout: 90_000 });
        });

        await step("Run the published local tool from the console", async () => {
          await page.getByRole("tab", { name: "Tools" }).click();
          await page.getByRole("button", { name: /picked-tools\s+1/ }).click();
          await page.getByRole("button", { name: "echo", exact: true }).click();
          await page.getByRole("tab", { name: "Run" }).click();
          await page.getByLabel("message").fill("from directory picker");
          await page.getByRole("button", { name: "Run", exact: true }).click();
          await page
            .locator("pre")
            .filter({ hasText: "local-picker:from directory picker" })
            .last()
            .waitFor({ timeout: 90_000 });
        });

        await step("Remove the local directory source", async () => {
          await page.goto(new URL("/integrations/picked-tools?tab=source", url).toString(), {
            waitUntil: "networkidle",
          });
          await page.getByRole("button", { name: "Remove" }).click();
          await page.getByRole("button", { name: "Remove source" }).click();
          await page.waitForURL(/\/integrations(?:\?|$)/, { timeout: 90_000 });
        });
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(fixtureRoot, { recursive: true, force: true }))),
    );
  }),
);
