// Cross-target (browser): the row's Duplicate menu prefills the add form
// with the source row's pattern, action, and owner, and focuses the pattern
// input with its content selected so the user can tweak the pattern in one
// keystroke. Submitting the form then writes the duplicated rule as its own
// row. The product guarantees this scenario pins:
//
//   1. The Duplicate menu item exists on every row's overflow menu.
//   2. Clicking it copies the row's `pattern` and `action` into the add form
//      (the action select reflects the source row's verb label).
//   3. The pattern input is focused after the prefill, the UX promise that
//      "I can just type" instead of "I have to click the input first".
//   4. After editing the pattern and submitting, BOTH rows appear in the
//      list and the server-side `policies.list` reflects both.
//
// This is the only UI surface today that exercises the form's `prefill`
// prop. Regressions to the prefill nonce, the focus timing, or the field
// copy logic all surface as a `waitFor` timeout in this scenario.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · the row's Duplicate menu prefills the add form for a one-keystroke clone",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(coreApi, identity);

    const suffix = randomBytes(4).toString("hex");
    const prefix = `policies-dup-${suffix}.`;
    const originalPattern = `${prefix}alpha`;
    const copyPattern = `${prefix}beta`;

    const cleanup = Effect.gen(function* () {
      const policies = yield* client.policies.list().pipe(Effect.orElseSucceed(() => []));
      yield* Effect.forEach(
        policies.filter((p) => p.pattern.startsWith(prefix)),
        (p) =>
          client.policies
            .remove({ params: { policyId: p.id }, payload: { owner: p.owner } })
            .pipe(Effect.ignore),
      );
    }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* browser.session(identity, async ({ page, step }) => {
        const patternInput = page.getByPlaceholder("vercel.dns.* or *");
        const formActionSelect = page.locator("form").getByRole("combobox").first();
        const cardContent = page.locator('[data-slot="card-stack-content"]');
        const row = (text: string) =>
          cardContent.locator('[data-slot="card-stack-entry"]').filter({ hasText: text });

        await step("Open the policies page and add a Block rule", async () => {
          await page.goto("/policies", { waitUntil: "networkidle" });
          await page.getByRole("heading", { name: "Policies", exact: true }).waitFor();
          await patternInput.fill(originalPattern);
          // Switch the form's action to Block so the duplicate prefill has a
          // non-default action to verify.
          await formActionSelect.click();
          await page.getByRole("option", { name: "Block", exact: true }).click();
          await page.getByRole("button", { name: "Add policy", exact: true }).click();
          await row(originalPattern).waitFor();
        });

        await step("Open the row's overflow menu and click Duplicate", async () => {
          // Hover the row to materialize the opacity-0 overflow trigger, then
          // target it by data-slot rather than a positional `getByRole`,
          // the row also contains the badge's role="combobox" trigger, which
          // can change the last-button heuristic if the DOM order ever moves.
          await row(originalPattern).hover();
          const trigger = row(originalPattern).locator('[data-slot="dropdown-menu-trigger"]');
          // Wait for the trigger to be visible (group-hover transition is
          // opacity-based), then click without `force`, matching the
          // policies-round-trip overflow pattern. The selfhost dev server
          // boot can be slow enough that a force-click races the trigger's
          // opacity transition and the Radix open handler never fires.
          await trigger.waitFor({ state: "visible" });
          await trigger.click();
          // The DropdownMenuContent is portaled to body, not the row; wait
          // for it to mount before targeting the menu item, so a timeout
          // here means "the menu never opened", not "the item is missing".
          const menu = page.locator('[data-slot="dropdown-menu-content"]');
          await menu.waitFor();
          await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
        });

        await step("The form prefilled with the source pattern and action", async () => {
          expect(
            await patternInput.inputValue(),
            "the pattern input carries the source row's pattern verbatim",
          ).toBe(originalPattern);
          expect(
            await formActionSelect.textContent(),
            "the action select carries the source row's verb label",
          ).toContain("Block");
        });

        await step("The pattern input is focused, ready to be tweaked", async () => {
          // Asserting on the focused element's id rather than a boolean
          // identity check, a regression where focus lands on the wrong
          // element will print the actual id instead of bare `false`, which
          // is the e2e/AGENTS.md "values not booleans" rule.
          await expect
            .poll(
              () =>
                patternInput.evaluate(
                  () => (document.activeElement as HTMLElement | null)?.id ?? "",
                ),
              {
                message: "Duplicate focuses the pattern input by id",
                timeout: 2_000,
              },
            )
            .toBe("policy-pattern");
        });

        await step("Tweak the pattern and submit the copy", async () => {
          await patternInput.fill(copyPattern);
          await page.getByRole("button", { name: "Add policy", exact: true }).click();
          await row(copyPattern).waitFor();
        });

        await step("Both rows appear in the rendered list", async () => {
          await row(originalPattern).waitFor();
          await row(copyPattern).waitFor();
        });
      });

      // Server-side truth on a fresh read: both rules persisted, both
      // org-owned, both carrying the action the form was holding at submit
      // (Block was set before the first add and the prefill preserved it).
      const policies = yield* client.policies.list();
      const mine = policies
        .filter((p) => p.pattern.startsWith(prefix))
        .map((p) => `${p.owner} ${p.pattern} ${p.action}`)
        .sort();
      expect(mine, "both duplicated rules persisted with the source's action").toEqual(
        [`org ${originalPattern} block`, `org ${copyPattern} block`].sort(),
      );
    }).pipe(Effect.ensuring(cleanup));
  }),
);
