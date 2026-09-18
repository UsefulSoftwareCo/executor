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
//   6. A manually-authored `**.get*` rule matches generated tool names across
//      groups without catching a sibling `delete*` tool.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { clickToReveal, visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** Tagged groups render `records` category rules alongside generated
 *  `users.getV1User` / `users.deleteV1User` names for wildcard coverage and
 *  an unrelated `checks` category the rules must not touch. Tag → group
 *  segment and operationId → leaf segment. Never contacted over the network. */
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
    "/users/{id}": {
      get: {
        operationId: "getV1User",
        tags: ["users"],
        summary: "Get a user",
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "deleteV1User",
        tags: ["users"],
        summary: "Delete a user",
        responses: { "204": { description: "deleted" } },
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
    const getNamePattern = `${integration}.*.*.**.get*`;

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
        const internalError = JSON.stringify({ _tag: "InternalError", traceId: "policy-write" });

        await step("Open the integration's Tools tab", async () => {
          await visit(page, `/integrations/${integration}`);
          // The org-scoped redirect can replace the document between the tab
          // becoming visible and React receiving the click. Reveal a node that
          // exists only in the Tools panel so the Accounts panel's connection
          // sections cannot satisfy the readiness check.
          await clickToReveal(
            page.getByRole("tab", { name: "Tools" }),
            closedGroup(alpha, integration),
          );
          await closedGroup(beta, integration).waitFor();
        });

        await step("Expand the records category in the first account", async () => {
          await closedGroup(alpha, integration).click();
          await closedGroup(alpha, "records").click();
          await policyMenuFor(alpha, `${integration}.records.create`).waitFor();
        });

        await step("A rejected policy create reports the failure and writes nothing", async () => {
          await page.route("**/api/policies", async (route) => {
            if (route.request().method() !== "POST") {
              await route.continue();
              return;
            }
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: internalError,
            });
          });
          await policyMenuFor(alpha, `${integration}.records.create`).click();
          await page.getByText(leafPattern, { exact: true }).waitFor();
          await page.getByRole("menuitem", { name: "Block" }).click();
          await page.getByText("Failed to create policy", { exact: true }).waitFor();
          const afterFailure = await Effect.runPromise(client.policies.list());
          expect(
            afterFailure.map((policy) => policy.pattern),
            "a rejected create does not persist the optimistic policy",
          ).not.toContain(leafPattern);
          await page.unroute("**/api/policies");
        });

        await step("Block records.create from the per-tool menu", async () => {
          await policyMenuFor(alpha, `${integration}.records.create`).click();
          // The menu is headed by the exact pattern it will store.
          await page.getByText(leafPattern, { exact: true }).waitFor();
          await page.getByRole("menuitem", { name: "Block" }).click();
          await leafIndicator(alpha, "create", `Blocked (matched ${leafPattern})`).waitFor();
        });

        await step("A rejected clear reports the failure and keeps the policy active", async () => {
          await page.route("**/api/policies/*", async (route) => {
            if (route.request().method() !== "DELETE") {
              await route.continue();
              return;
            }
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: internalError,
            });
          });
          await policyMenuFor(alpha, `${integration}.records.create`).click();
          await page.getByRole("menuitem", { name: "Clear" }).click();
          await page.getByText("Failed to clear policy", { exact: true }).waitFor();
          await leafIndicator(alpha, "create", `Blocked (matched ${leafPattern})`).waitFor();
          const afterFailure = await Effect.runPromise(client.policies.list());
          expect(
            afterFailure.map((policy) => policy.pattern),
            "a rejected clear leaves the stored policy intact",
          ).toContain(leafPattern);
          await page.unroute("**/api/policies/*");
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
          await visit(page, "/policies");
          await page.getByText(leafPattern, { exact: true }).waitFor();
          await page.getByText(categoryPattern, { exact: true }).waitFor();
        });

        await step("Require approval for every generated get-prefixed tool", async () => {
          await page.getByLabel("Pattern").fill(getNamePattern);
          await page.getByRole("button", { name: "Add policy" }).click();
          await page.getByText(getNamePattern, { exact: true }).waitFor();
        });

        await step(
          "The name wildcard matches get tools without catching delete tools",
          async () => {
            await page.goto(`/integrations/${integration}`, { waitUntil: "networkidle" });
            await page.getByRole("tab", { name: "Tools" }).click();
            await closedGroup(alpha, integration).click();
            await closedGroup(alpha, "users").click();
            await leafIndicator(
              alpha,
              "getV1User",
              `Require approval (matched ${getNamePattern})`,
            ).waitFor();
            await leafIndicator(
              alpha,
              "deleteV1User",
              "Plugin default: Require approval",
            ).waitFor();
          },
        );
      });

      // Server-side truth, on a fresh read: exactly the three authored rules,
      // org-owned, with the more specific leaf rule placed above the later
      // category and tool-name wildcard rules so it keeps precedence.
      const policies = yield* client.policies.list();
      const mine = policies
        .filter((p) => p.pattern.startsWith(`${integration}.`))
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      expect(
        mine.map((p) => `${p.owner} ${p.pattern} ${p.action}`),
        "the UI-authored rules persisted in specificity order",
      ).toEqual([
        `org ${leafPattern} block`,
        `org ${categoryPattern} require_approval`,
        `org ${getNamePattern} require_approval`,
      ]);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
