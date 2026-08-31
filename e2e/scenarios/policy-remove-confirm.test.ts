// Cross-target (browser): removing a tool-access policy asks for confirmation
// first. Remove fires from a row's dropdown menu and is irreversible — the
// rule is gone and every tool it governed silently falls back to the default
// policy — so the menu item must open a confirm dialog rather than firing the
// mutation directly. Cancel keeps the rule; confirming removes it for real
// (asserted through the API, not just the rendered list).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies (UI) · Remove asks for confirmation; cancel keeps, confirm removes",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(coreApi, identity);

    // Selfhost scenarios share one workspace, so the pattern is unique to this
    // run and the row lookup below cannot match another scenario's rule.
    const pattern = `rmconfirm-${randomBytes(4).toString("hex")}.*`;

    const created = yield* client.policies.create({
      payload: { owner: "org", pattern, action: "block" },
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          const row = page.locator("[data-slot='card-stack-entry']").filter({ hasText: pattern });
          const menuTrigger = row.locator('button[aria-haspopup="menu"]');
          const confirm = page.getByRole("alertdialog");

          await step("Open the policies page", async () => {
            await visit(page, "/policies");
            await row.waitFor();
          });

          await step("Remove asks for confirmation instead of firing", async () => {
            await menuTrigger.click();
            await page.getByRole("menuitem", { name: "Remove" }).click();
            await confirm.getByText("Remove policy?").waitFor();
            // The dialog names the exact rule being destroyed.
            await confirm.getByText(pattern, { exact: false }).waitFor();
          });

          await step("Cancel keeps the policy", async () => {
            await confirm.getByRole("button", { name: "Cancel" }).click();
            await confirm.waitFor({ state: "detached" });
            await row.waitFor();
          });

          await step("Confirming actually removes it", async () => {
            await menuTrigger.click();
            await page.getByRole("menuitem", { name: "Remove" }).click();
            await confirm.getByRole("button", { name: "Remove policy" }).click();
            await confirm.waitFor({ state: "detached" });
            await row.waitFor({ state: "detached" });
          });
        });

        // Cancel left the removal un-fired and confirm fired it for real: the
        // rule is gone from the API, not merely from the rendered list.
        const remaining = yield* client.policies.list();
        expect(
          remaining.map((policy) => policy.pattern),
          "the removed policy is gone from the API",
        ).not.toContain(pattern);
      }),
      client.policies
        .remove({ params: { policyId: created.id }, payload: { owner: "org" } })
        .pipe(Effect.ignore),
    );
  }),
);
