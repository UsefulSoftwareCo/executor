/** A deployment started with its own product name and logo presents them instead of Executor's. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { productBrand, scenarios } from "../test-plan.ts";

const ResourceMetadata = Schema.Struct({ resource_name: Schema.String });
const executorName = /executor/i;
const callback = "http://127.0.0.1:9/callback";

layer(HostedLive, { excludeTestServices: true })("Product brand", (it) => {
  it.effect(scenarios.productBrand.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          mcp = yield* McpClient,
          target = yield* Target;
        const origin = target.metadata.origin;
        const anonymous = yield* api.session();
        const brandLogos = (scope: string) =>
          browser.use(`Count ${scope} images showing the configured logo`, (page) =>
            page.locator(`${scope} img[src="${productBrand.logo}"]`).count(),
          );

        // The server-rendered document already carries the brand, before any script runs.
        const document = yield* browser.use("Open sign-in signed out", (page) =>
          page.goto(`${origin}/login`).then((response) => response?.text() ?? ""),
        );
        expect(document).toContain(`<title>${productBrand.name}</title>`);
        expect(document).toContain(`<link rel="icon" href="${productBrand.logo}"/>`);
        yield* browser.use("Sign-in names the configured product", (page) =>
          page
            .getByRole("heading", { name: `Sign in to ${productBrand.name}`, exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(yield* browser.use("Read the sign-in title", (page) => page.title())).toBe(
          `Sign in · ${productBrand.name}`,
        );
        expect(yield* brandLogos("body")).toBeGreaterThan(0);
        expect(
          yield* browser.use("Count images showing Executor's logo", (page) =>
            page.locator('img[src="/favicon.png"]').count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Read the sign-in page text", (page) =>
            page.locator("body").innerText(),
          ),
        ).not.toMatch(executorName);
        // The configured privacy page is linked; terms are not configured, so no link shows.
        expect(
          yield* browser.use("Read the privacy link", (page) =>
            page.getByRole("link", { name: "Privacy", exact: true }).getAttribute("href"),
          ),
        ).toBe(productBrand.privacy);
        expect(
          yield* browser.use("Count terms links", (page) =>
            page.getByRole("link", { name: "Terms", exact: true }).count(),
          ),
        ).toBe(0);

        yield* browser.login(actors.owner);
        yield* browser.use("Open apps", (page) =>
          page.goto(`${origin}/org/${actors.organization.slug}/apps`),
        );
        // The built-in app keeps its stored name for agents and shows the product's name.
        yield* browser.use("The built-in app shows the configured name", (page) =>
          page
            .getByRole("link", { name: new RegExp(`^Open ${productBrand.name}\\b`) })
            .waitFor({ state: "visible" }),
        );
        const apps = yield* browser.use("Read the apps page", (page) =>
          page.locator("body").innerText(),
        );
        expect(apps).not.toMatch(executorName);
        expect(
          yield* browser.use("Count the sidebar's Docs links", (page) =>
            page.getByRole("link", { name: "Docs" }).count(),
          ),
        ).toBe(0);
        // The built-in app's own page and its account read under the configured name too.
        yield* browser.use("Open the built-in app", (page) =>
          page.getByRole("link", { name: new RegExp(`^Open ${productBrand.name}\\b`) }).click(),
        );
        yield* browser.use("The built-in app's page names the configured product", (page) =>
          page
            .getByRole("heading", { name: productBrand.name, exact: true })
            .first()
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Read the built-in app's page", (page) =>
            page.locator("main").innerText(),
          ),
        ).not.toMatch(executorName);
        // Its accounts tab names the provider people connect, with the configured name.
        yield* browser.use("Open the built-in app's accounts", (page) =>
          page.goto(`${page.url().split("?")[0]}?view=accounts`),
        );
        yield* browser.use("The provider shows the configured name", (page) =>
          page.getByText(productBrand.name, { exact: true }).first().waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Read the built-in app's accounts", (page) =>
            page.locator("main").innerText(),
          ),
        ).not.toMatch(executorName);
        yield* browser.use("Open accounts", (page) =>
          page.goto(`${origin}/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("The accounts page has loaded", (page) =>
          page.getByText(`Your ${productBrand.name} access`).first().waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Read the accounts page", (page) => page.locator("main").innerText()),
        ).not.toMatch(executorName);
        yield* browser.use("Open assistant setup", (page) =>
          page.goto(`${origin}/org/${actors.organization.slug}/connect`),
        );
        yield* browser.use("The Claude guide names the configured product", (page) =>
          page
            .getByRole("heading", { name: `Add ${productBrand.name} to Claude`, exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(yield* browser.use("Read the setup title", (page) => page.title())).toMatch(
          new RegExp(` · ${productBrand.name}$`),
        );
        const claude = yield* browser.use("Read the Claude guide", (page) =>
          page.locator("main").innerText(),
        );
        expect(claude).toContain(`Name it ${productBrand.name}`);
        expect(claude).not.toMatch(executorName);
        yield* browser.use("Choose Claude Code", (page) =>
          page.getByRole("button", { name: "Claude Code", exact: true }).click(),
        );
        yield* browser.use("The Claude Code guide names the configured product", (page) =>
          page
            .getByRole("heading", { name: `Add ${productBrand.name} to Claude Code`, exact: true })
            .waitFor({ state: "visible" }),
        );
        const claudeCode = yield* browser.use("Read the Claude Code guide", (page) =>
          page.locator("main").innerText(),
        );
        expect(claudeCode).toContain(`claude mcp add --transport http ${productBrand.server} `);
        expect(claudeCode).not.toMatch(executorName);

        // Authorization servers and MCP clients show these names when a person connects.
        for (const [path, name] of [
          ["/.well-known/oauth-protected-resource/mcp", productBrand.name],
          ["/.well-known/oauth-protected-resource/api", `${productBrand.name} API`],
        ] as const) {
          const metadata = yield* api.request(anonymous, "GET", path);
          expect(metadata.status).toBe(200);
          expect((yield* body(ResourceMetadata, metadata)).resource_name).toBe(name);
        }

        const registered = yield* api.request(anonymous, "POST", "/api/auth/oauth2/register", {
          client_name: "Brand check client",
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        });
        expect(registered.status).toBe(201);
        const { client_id } = yield* body(
          Schema.Struct({ client_id: Schema.NonEmptyString }),
          registered,
        );
        const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
        authorization.search = new URLSearchParams({
          response_type: "code",
          client_id,
          redirect_uri: callback,
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
          scope: "mcp",
          resource: `${origin}/mcp`,
          state: "brand-check",
        }).toString();
        // The consent is only read, never approved, so the client gets no grant.
        yield* browser.use("Open the client's MCP consent", (page) =>
          page.goto(authorization.href),
        );
        yield* browser.use("MCP consent names the configured product", (page) =>
          page
            .getByRole("heading", { name: `Connect to ${productBrand.name}`, exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(yield* brandLogos("main")).toBeGreaterThan(0);
        const consent = yield* browser.use("Read the consent page", (page) =>
          page.locator("main").innerText(),
        );
        expect(consent).toContain(productBrand.name.toLowerCase());
        expect(consent).not.toMatch(executorName);

        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Brand check",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "brand", {
          organization: actors.organization.id,
        });
        const server = yield* client.use("The MCP server reports the configured name", (client) =>
          Promise.resolve(client.getServerVersion()),
        );
        expect(server?.name).toBe(productBrand.name);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
