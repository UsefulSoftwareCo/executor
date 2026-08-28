// The add-MCP flow probes the Server URL as it is typed. Every keystroke is a
// prefix of the next one, so a probe on a half-typed value dials something the
// user never meant to submit and drops the field into a loading and then an
// error state. This guards that an incomplete URL is left alone and that a
// finished one is still probed without being submitted.
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const urlField = "https://mcp.example.com";
const retry = "Try again";

scenario(
  "MCP add flow · a half-typed Server URL is not probed",
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

      await step("A URL still being typed is left alone", async () => {
        // Well past the 400ms debounce. The field must stay editable — the
        // probing state replaces it with a skeleton — and report no failure.
        for (const partial of ["h", "http://", "http://a", "https://mcp"]) {
          await page.getByPlaceholder(urlField).fill(partial);
          await page.waitForTimeout(700);
          await page.getByPlaceholder(urlField).waitFor({ state: "visible" });
          await page.getByRole("button", { name: retry }).waitFor({ state: "hidden" });
        }
      });

      await step("A finished URL is still probed", async () => {
        // `.invalid` is reserved and never resolves, so the probe fails and the
        // retry affordance appears. That it appears at all is the assertion:
        // the shape gate lets a complete URL through.
        await page.getByPlaceholder(urlField).fill("https://mcp.notareal.invalid/mcp");
        await page.getByRole("button", { name: retry }).waitFor();
      });
    });
  }),
);
