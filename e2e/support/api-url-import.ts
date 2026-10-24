/** Drive the ordinary browser import, account connection and tool-call APIs. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { Browser } from "./browser.ts";
import { Inventory, Resource } from "./contracts.ts";
import { connectionsPath } from "./app-accounts.ts";

const Source = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.optional(Schema.String) }),
  ),
});
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
const User = Schema.Struct({ login: Schema.String });

export const apiUrlImports = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const apps: string[] = [],
    accounts: string[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.forEach(apps, (path) => api.request(actors.owner, "DELETE", path));
      yield* Effect.forEach(accounts, (id) =>
        api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`),
      );
    }).pipe(Effect.orDie),
  );
  const importInBrowser = (input: {
    readonly kind: "OpenAPI" | "GraphQL";
    readonly name: string;
    readonly url: string;
    readonly baseUrl?: string;
    readonly auth?: "Bearer token" | "API key header";
  }) =>
    Effect.gen(function* () {
      yield* browser.use("Open Connect a service", (page) =>
        page.goto(`/org/${actors.organization.slug}/apps/add/custom`),
      );
      yield* browser.use("Open service types", (page) =>
        page.getByRole("combobox", { name: "Service type", exact: true }).click(),
      );
      yield* browser.use(`Choose ${input.kind}`, (page) =>
        page.getByRole("option", { name: input.kind, exact: true }).click(),
      );
      yield* browser.use("Name the API app", (page) =>
        page.getByLabel("App name", { exact: true }).fill(input.name),
      );
      yield* browser.use("Enter the API URL", (page) =>
        page
          .getByLabel(
            input.kind === "OpenAPI" ? "OpenAPI definition URL" : "GraphQL endpoint URL",
            { exact: true },
          )
          .fill(input.url),
      );
      const baseUrl = input.baseUrl;
      if (baseUrl !== undefined)
        yield* browser.use("Override the API server", (page) =>
          page.getByLabel("API base URL (optional)", { exact: true }).fill(baseUrl),
        );
      const auth = input.auth;
      if (auth !== undefined) {
        yield* browser.use("Open authentication choices", (page) =>
          page.getByRole("combobox", { name: "Authentication", exact: true }).click(),
        );
        yield* browser.use(`Choose ${auth}`, (page) =>
          page.getByRole("option", { name: auth, exact: true }).click(),
        );
        if (auth === "API key header")
          yield* browser.use("Name the credential header", (page) =>
            page.getByLabel("API key header name", { exact: true }).fill("Authorization"),
          );
      }
      yield* browser.checkpoint(`${input.kind} URL ready to add without source code`);
      yield* browser.use("Add the API app", (page) =>
        page.getByRole("button", { name: "Add app", exact: true }).click(),
      );
      yield* browser.use("The API app opens", (page) =>
        page.waitForURL(
          (url) => url.pathname.split("/").length === 5 && url.searchParams.has("view"),
        ),
      );
      const inventory = yield* body(
        Inventory,
        yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
      );
      const app = inventory.apps.find(({ name }) => name === input.name);
      if (app === undefined) return yield* Effect.die("The imported API app is missing");
      const path = `${prefix}/apps/${app.id}`;
      apps.push(path);
      return path;
    });
  const connect = (path: string, token: string) =>
    Effect.gen(function* () {
      const request = yield* body(
        Resource,
        yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
      );
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${request.id}/submit`,
        {
          method: "apiKey",
          label: "Synthetic API URL account",
          fields: { token },
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const account = yield* body(Resource, response);
      accounts.push(account.id);
      return account.id;
    });
  const retained = (path: string, url: string, token: string) =>
    Effect.gen(function* () {
      const source = yield* body(Source, yield* api.request(actors.owner, "GET", `${path}/source`));
      const text = JSON.stringify(source.files);
      expect(text).toContain(url);
      expect(text).not.toContain(token);
    });
  const call = (path: string, name: string, accountId: string, login: string) =>
    Effect.gen(function* () {
      const tools = yield* body(Tools, yield* api.request(actors.owner, "GET", `${path}/tools`));
      const tool = tools.items.find((item) => item.name.endsWith(name));
      if (tool === undefined)
        return yield* Effect.die(
          `The imported API has no ${name} tool: ${tools.items.map(({ name }) => name).join(", ")}`,
        );
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool: tool.name,
        kind: "query",
        input: { accountId, input: {} },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((yield* body(User, response)).login).toBe(login);
    });
  return { prefix, importInBrowser, connect, retained, call };
});
