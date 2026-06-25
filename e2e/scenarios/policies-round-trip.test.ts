// Cross-target (browser): the full UI lifecycle of a policy. The user opens
// `/policies` on an empty workspace, submits a Require approval rule through
// the add form, flips its action to Always run via the row's inline badge
// select, then removes it via the row's overflow menu, and watches the
// empty state return. Covers the surfaces `policies-lifecycle` (API) and
// `policies-landing` (empty state) intentionally leave out: that the
// rendered page itself is the authoring surface, not just a read view.
//
// Selfhost shares one bootstrap-admin workspace, so the pattern carries a
// per-run suffix and the finalizer removes any row that survived a mid-test
// failure via the API.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · a user can add, re-target, and remove a rule from the policies page",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(coreApi, identity);

    const suffix = randomBytes(4).toString("hex");
    const prefix = `policies-rt-${suffix}.`;
    const pattern = `${prefix}alpha`;

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
        const cardContent = page.locator('[data-slot="card-stack-content"]');
        const row = () =>
          cardContent.locator('[data-slot="card-stack-entry"]').filter({ hasText: pattern });

        await step("Open the policies page on a fresh workspace", async () => {
          await page.goto("/policies", { waitUntil: "networkidle" });
          await page.getByRole("heading", { name: "Policies", exact: true }).waitFor();
          // The empty-state explainer guarantees this workspace has never
          // authored a rule, the precondition this scenario depends on.
          await cardContent
            .getByText(
              "No policies yet. Tools fall back to their plugin's default approval behavior.",
              { exact: true },
            )
            .waitFor();
        });

        await step("Submit a Require approval rule through the add form", async () => {
          await page.getByPlaceholder("vercel.dns.* or *").fill(pattern);
          // The form's action select defaults to Require approval, submit
          // the form as-is to also pin that default.
          await page.getByRole("button", { name: "Add policy", exact: true }).click();
        });

        await step("The new row appears with the pattern and Require approval badge", async () => {
          await row().waitFor();
          // The row's inline badge select is the first combobox inside the
          // card-stack content (the add form's combobox sits outside it).
          const rowBadge = row().getByRole("combobox");
          await rowBadge.waitFor();
          expect(
            await rowBadge.textContent(),
            "the row badge shows the rule's current action verbatim",
          ).toContain("Require approval");
        });

        await step("Flip the action to Always run via the row badge select", async () => {
          await row().getByRole("combobox").click();
          // "Always run" is the verb label for the `approve` action.
          await page.getByRole("option", { name: "Always run", exact: true }).click();
        });

        await step("The badge reflects the new Always run action", async () => {
          const rowBadge = row().getByRole("combobox");
          // Wait for the badge to actually flip (optimistic updates can
          // take a frame); reading textContent at the right moment is the
          // assertion.
          await expect
            .poll(async () => rowBadge.textContent(), {
              message: "the row badge flipped to the new action",
              timeout: 5_000,
            })
            .toContain("Always run");
        });

        await step("Remove the rule via the row's overflow menu", async () => {
          // Hover the row to materialize the opacity-0 overflow trigger, what
          // a real user does, then click without `force`. The menu content
          // is portaled to body, so wait for it explicitly before targeting
          // the menu item.
          await row().hover();
          await row().locator('[data-slot="dropdown-menu-trigger"]').click();
          const menu = page.locator('[data-slot="dropdown-menu-content"]');
          await menu.waitFor();
          await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
        });

        await step("The row disappears and the empty state returns", async () => {
          await row().waitFor({ state: "detached" });
          await cardContent
            .getByText(
              "No policies yet. Tools fall back to their plugin's default approval behavior.",
              { exact: true },
            )
            .waitFor();
        });
      });

      // Server-side: a fresh read shows zero rows carrying this scenario's
      // prefix. Pins that the UI's remove path actually deleted (vs. just
      // optimistic-updated the cache).
      const policies = yield* client.policies.list();
      expect(
        policies.filter((p) => p.pattern.startsWith(prefix)).map((p) => p.pattern),
        "no rows from this scenario survive on the server",
      ).toEqual([]);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
