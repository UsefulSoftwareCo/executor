// Cross-target (browser): authoring tool policies from the integration's tool
// tree. An OpenAPI integration with two connected accounts renders the
// account-grouped tree; the per-tool row menu writes an exact-tool rule and
// the category (group) row menu writes a subtree rule. The product promises
// under test:
//
//   1. Both menus surface the REAL stored pattern (connection-wildcarded
//      `integration.*.*.tool`) before anything is written.
//   2. A leaf rule and a category rule coexist: the more specific leaf rule
//      keeps precedence over the later category rule, which covers the rest
//      of its group.
//   3. Rules are connection-agnostic: set from one account's section, they
//      govern the other account's rows too, and the menu there shows the
//      active rule with a Clear option.
//   4. The tool detail header's policy badge is the same authoring surface:
//      it writes the same stored pattern, recognizes its own rule afterward
//      (the Clear affordance), and Clear really removes the rule.
//   5. The rules materialize as manageable rows on /policies and persist
//      server-side with exactly the owner/pattern/action the UI promised.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** Two tagged groups so the tree renders a `records` category (two leaves)
 *  next to an unrelated `checks` category the rules must not touch. Tag →
 *  group segment, operationId → leaf segment: `records.list`,
 *  `records.create`, `checks.ping`. Never contacted over the network. */
const recordsSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Records API", version: "1.0.0" },
  paths: {
    "/records": {
      get: {
        operationId: "list",
        tags: ["records"],
        summary: "List records",
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "create",
        tags: ["records"],
        summary: "Create a record",
        responses: { "200": { description: "ok" } },
      },
    },
    "/checks": {
      get: {
        operationId: "ping",
        tags: ["checks"],
        summary: "Ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

scenario(
  "Policies · the tool tree's per-tool menu and category menu both author working rules",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);

    const suffix = randomBytes(4).toString("hex");
    const integration = IntegrationSlug.make(`polui${suffix}`);
    const alpha = ConnectionName.make(`alpha${suffix}`);
    const beta = ConnectionName.make(`beta${suffix}`);
    const accounts = [alpha, beta] as const;

    // The UI hides owner/connection segments; a rule authored on a node is
    // stored connection-wildcarded so it spans every account.
    const leafPattern = `${integration}.*.*.records.create`;
    const categoryPattern = `${integration}.*.*.records.*`;
    const listLeafPattern = `${integration}.*.*.records.list`;

    // Selfhost scenarios share one workspace — remove everything this one
    // made (policies, connections, the integration) even on failure.
    const cleanup = Effect.gen(function* () {
      const policies = yield* client.policies.list();
      yield* Effect.forEach(
        policies.filter((p) => p.pattern.startsWith(`${integration}.`)),
        (p) =>
          client.policies
            .remove({ params: { policyId: p.id }, payload: { owner: p.owner } })
            .pipe(Effect.ignore),
      );
      yield* Effect.forEach(accounts, (name) =>
        client.connections
          .remove({ params: { owner: "org", integration, name } })
          .pipe(Effect.ignore),
      );
      yield* client.openapi.removeSpec({ params: { slug: integration } });
    }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      // An integration plus two connected accounts: tools materialize per
      // connection, so the Tools tab groups the tree by account.
      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: recordsSpec },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999", // never contacted — tools derive from the spec
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* Effect.forEach(accounts, (name) =>
        client.connections.create({
          payload: {
            owner: "org",
            name,
            integration,
            template: TEMPLATE_API_KEY,
            identityLabel: `${name} key`,
            value: `sk-${name}`,
          },
        }),
      );

      yield* browser.session(identity, async ({ page, step }) => {
        // The Accounts tab also lists connection names; scope all tree
        // lookups to the active tab panel so locators stay strict.
        const sectionFor = (connection: string) =>
          page.getByRole("tabpanel").locator("section").filter({ hasText: connection });
        // Group rows are the only tree buttons carrying aria-expanded.
        const closedGroup = (connection: string, text: string) =>
          sectionFor(connection).locator('button[aria-expanded="false"]').filter({ hasText: text });
        const policyMenuFor = (connection: string, node: string) =>
          sectionFor(connection).getByRole("button", {
            name: `Set policy for ${node}`,
            exact: true,
          });
        // A leaf's policy dot, scoped to ITS row — the same effective policy
        // (and thus the same indicator label) can legitimately sit on several
        // rows at once, so an unscoped label lookup would not be unique.
        const leafIndicator = (connection: string, leaf: string, label: string) =>
          sectionFor(connection)
            .getByRole("button")
            .filter({ hasText: leaf })
            .getByLabel(label, { exact: true });

        await step("Open the integration's Tools tab", async () => {
          await page.goto(`/integrations/${integration}`, { waitUntil: "networkidle" });
          await page.getByRole("tab", { name: "Tools" }).click();
          await sectionFor(alpha).waitFor();
          await sectionFor(beta).waitFor();
        });

        await step("Expand the records category in the first account", async () => {
          await closedGroup(alpha, integration).click();
          await closedGroup(alpha, "records").click();
          await policyMenuFor(alpha, `${integration}.records.create`).waitFor();
        });

        await step("Block records.create from the per-tool menu", async () => {
          await policyMenuFor(alpha, `${integration}.records.create`).click();
          // The menu is headed by the exact pattern it will store.
          await page.getByText(leafPattern, { exact: true }).waitFor();
          await page.getByRole("menuitem", { name: "Block" }).click();
          await leafIndicator(alpha, "create", `Blocked (matched ${leafPattern})`).waitFor();
        });

        await step("Require approval for the whole records category", async () => {
          await policyMenuFor(alpha, `${integration}.records.*`).click();
          await page.getByText(categoryPattern, { exact: true }).waitFor();
          await page.getByRole("menuitem", { name: "Require approval" }).click();
        });

        await step(
          "The category rule covers the sibling leaf; the leaf rule keeps winning",
          async () => {
            await leafIndicator(
              alpha,
              "list",
              `Require approval (matched ${categoryPattern})`,
            ).waitFor();
            await leafIndicator(alpha, "create", `Blocked (matched ${leafPattern})`).waitFor();
          },
        );

        await step("The same rules govern the second account's rows", async () => {
          await closedGroup(beta, integration).click();
          await closedGroup(beta, "records").click();
          await leafIndicator(beta, "create", `Blocked (matched ${leafPattern})`).waitFor();
          await leafIndicator(
            beta,
            "list",
            `Require approval (matched ${categoryPattern})`,
          ).waitFor();
        });

        await step("Reopening the menu offers to clear the active rule", async () => {
          await policyMenuFor(beta, `${integration}.records.create`).click();
          await page.getByRole("menuitem", { name: "Clear" }).waitFor();
          await page.keyboard.press("Escape");
        });

        await step("Open the tool detail for records.list", async () => {
          await sectionFor(beta).getByRole("button").filter({ hasText: "list" }).click();
          // The header badge reflects the inherited category rule.
          await page.getByRole("button", { name: `Matched policy: ${categoryPattern}` }).waitFor();
        });

        await step("The detail badge authors an Always run rule for the exact tool", async () => {
          await page.getByRole("button", { name: `Matched policy: ${categoryPattern}` }).click();
          // The badge menu is headed by the exact pattern it will store.
          await page.getByText(listLeafPattern, { exact: true }).waitFor();
          await page.getByRole("menuitem", { name: "Always run" }).click();
          // The written rule must actually match this tool: the badge flips
          // to the new, more specific rule.
          await page.getByRole("button", { name: `Matched policy: ${listLeafPattern}` }).waitFor();
        });

        await step("The badge recognizes its own rule and Clear removes it", async () => {
          await page.getByRole("button", { name: `Matched policy: ${listLeafPattern}` }).click();
          await page.getByRole("menuitem", { name: "Clear" }).click();
          // Back to inheriting the category rule.
          await page.getByRole("button", { name: `Matched policy: ${categoryPattern}` }).waitFor();
        });

        await step("Both rules are manageable rows on the Policies page", async () => {
          await page.goto("/policies", { waitUntil: "networkidle" });
          await page.getByText(leafPattern, { exact: true }).waitFor();
          await page.getByText(categoryPattern, { exact: true }).waitFor();
        });
      });

      // Server-side truth, on a fresh read: exactly the two authored rules,
      // org-owned, with the more specific leaf rule placed above the later
      // category rule so it keeps precedence.
      const policies = yield* client.policies.list();
      const mine = policies
        .filter((p) => p.pattern.startsWith(`${integration}.`))
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      expect(
        mine.map((p) => `${p.owner} ${p.pattern} ${p.action}`),
        "the UI-authored rules persisted with the leaf rule above the category rule",
      ).toEqual([`org ${leafPattern} block`, `org ${categoryPattern} require_approval`]);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
