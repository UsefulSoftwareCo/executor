/** Account-dependent discovery is exercised through real app factories and public routes. */
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "./browser.ts";
import { holdQuery, refreshVisiblePage } from "./query-transition.ts";

/** Distinct synthetic credentials expose different tools; a collection exposes their combined catalog. */
export const accountToolSource = `import { defineApp, defineProvider, secrets, object, string, query } from "apps";
const service = defineProvider({ name: "Workspace fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { workspaces: service.many() } }, async ctx => {
  const work = ctx.accounts.workspaces.some(account => account.fields.token === "work");
  const personal = ctx.accounts.workspaces.some(account => account.fields.token === "personal");
  return { queries: {
    ...(work ? { work: query({ input: object({}), description: "Search work items" }, async () => "work"), admin: query({ input: object({}), description: "Read work settings" }, async () => "admin") } : {}),
    ...(personal ? { personal: query({ input: object({}), description: "Search personal items" }, async () => "personal") } : {}),
  } };
});`;

/** A held replacement catalog must never display tools from the previous account under the new label. */
export const checkToolAccountContext = <E, R>(input: {
  readonly url: string;
  readonly catalogs: readonly string[];
  readonly work: string;
  readonly personal: string;
  readonly select: (ids: readonly string[]) => Effect.Effect<unknown, E, R>;
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* input.select([input.work]);
    yield* browser.use("Open work tools", (page) => page.goto(`${input.url}?view=tools`));
    yield* browser.use("Work context is explicit", (page) =>
      page
        .getByLabel("Tool account context")
        .getByRole("link", { name: "Work GitHub", exact: true })
        .waitFor({ state: "visible" }),
    );
    yield* browser.use("Work account exposes its own tools", (page) =>
      page
        .getByRole("navigation", { name: "App tools" })
        .getByRole("button", { name: "queries.work", exact: true })
        .waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("Personal tools are absent from the work catalog", (page) =>
        page
          .getByRole("navigation", { name: "App tools" })
          .getByRole("button", { name: "queries.personal", exact: true })
          .count(),
      ),
    ).toBe(0);
    yield* browser.checkpoint("Tools for the work account");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const held = yield* holdQuery(input.catalogs, "continue", { allRequests: true });
        yield* input.select([input.personal]);
        yield* refreshVisiblePage;
        yield* held.requested;
        yield* browser.use("The new account context is visible during discovery", (page) =>
          page
            .getByLabel("Tool account context")
            .getByRole("link", { name: "Personal GitHub", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Old tools are not labeled as belonging to the new account", (page) =>
            page
              .getByRole("navigation", { name: "App tools" })
              .getByRole("button", { name: "queries.work", exact: true })
              .count(),
          ),
        ).toBe(0);
        yield* held.release;
        yield* browser.use("Personal account discovers a different tool", (page) =>
          page
            .getByRole("navigation", { name: "App tools" })
            .getByRole("button", { name: "queries.personal", exact: true })
            .waitFor({ state: "visible" }),
        );
      }),
    );
    yield* browser.use("Open Overview for the selected account", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Overview", exact: true })
        .click(),
    );
    yield* browser.use("Overview previews the available tool", (page) =>
      page
        .getByRole("region", { name: "App tools preview", exact: true })
        .getByRole("link", { name: /queries.personal/ })
        .waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("Overview has no repeated account context", (page) =>
        page
          .getByRole("region", { name: "App tools preview" })
          .getByLabel("Tool account context")
          .count(),
      ),
    ).toBe(0);
    yield* browser.use("Account details stay in the Accounts card", (page) =>
      page
        .getByRole("region", { name: "App accounts", exact: true })
        .getByRole("link", { name: "Personal GitHub", exact: true })
        .waitFor({ state: "visible" }),
    );
    yield* input.select([input.work, input.personal]);
    yield* refreshVisiblePage;
    for (const name of ["queries.work", "queries.admin", "queries.personal"])
      yield* browser.use(`Overview includes ${name}`, (page) =>
        page
          .getByRole("region", { name: "App tools preview", exact: true })
          .getByRole("link", { name: new RegExp(name) })
          .waitFor({ state: "visible" }),
      );
    yield* browser.use("Open the combined catalog", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Tools", exact: true })
        .click(),
    );
    yield* browser.use("The catalog is labeled as combined", (page) =>
      page
        .getByLabel("Tool account context")
        .getByText("· Combined catalog", { exact: true })
        .waitFor({ state: "visible" }),
    );
    for (const name of ["queries.work", "queries.admin", "queries.personal"])
      yield* browser.use(`Combined catalog includes ${name}`, (page) =>
        page
          .getByRole("navigation", { name: "App tools" })
          .getByRole("button", { name, exact: true })
          .waitFor({ state: "visible" }),
      );
    yield* browser.checkpoint("Combined account tool catalog");
    yield* browser.use("Use the existing account controls", (page) =>
      page.getByRole("link", { name: "Manage accounts", exact: true }).click(),
    );
    yield* browser.use("Account management is selected", (page) =>
      page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("link", { name: "Accounts", exact: true })
        .waitFor({ state: "visible" }),
    );
    expect(
      yield* browser.use("Account management link preserves app identity", (page) =>
        Promise.resolve(page.url()),
      ),
    ).toContain("view=accounts");
  });
