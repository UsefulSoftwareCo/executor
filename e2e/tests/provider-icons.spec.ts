/** Renamed secret providers can use a public host without guessing from private grants. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String, name: Schema.String });
const cases = [
  { name: "Renamed public service", hosts: ["api.example.com:8443"], logo: true },
  { name: "Private service", hosts: ["service.internal"], logo: false },
  { name: "Wildcard service", hosts: ["*.example.com"], logo: false },
  { name: "Ambiguous service", hosts: ["api.example.com", "api.example.org"], logo: false },
];
const source = (name: string, hosts: readonly string[]) => `import {
  defineApp, defineProvider, object, query, router, secrets, string,
} from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ${JSON.stringify(hosts)},
  auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) },
});
export default defineApp({ user: { accounts: { service: service.many() } } }, {
  tools: router({ ping: query({ input: object({}) }, async () => "ready") }),
});`;

layer(HostedLive, { excludeTestServices: true })("Provider icons", (it) => {
  it.effect(scenarios.providerIcons.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const item of cases) {
          const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: item.name,
            files: [{ path: "index.ts", content: source(item.name, item.hosts) }, appsManifest],
          });
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const app = yield* body(App, response);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
        }
        yield* browser.login(actors.owner);
        const requested: string[] = [];
        yield* browser.use("Answer logo requests without contacting a third party", (page) =>
          page.route("https://integrations.sh/**", (route) => {
            requested.push(route.request().url());
            return route.fulfill({
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>',
            });
          }),
        );
        yield* browser.use("Open renamed providers", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        for (const item of cases) {
          const count = yield* browser.use(`Inspect ${item.name}'s icon`, (page) => {
            const icon = page
              .getByRole("link", { name: `Open ${item.name}`, exact: true })
              .locator(".provider-icon");
            return icon
              .waitFor({ state: "visible" })
              .then(() =>
                icon
                  .locator(item.logo ? "img" : "svg")
                  .waitFor({ state: "visible", timeout: 5000 }),
              )
              .then(() => icon.locator("img").count());
          });
          expect(count).toBe(item.logo ? 1 : 0);
        }
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.every((url) => new URL(url).pathname === "/logo/example.com")).toBe(true);
        yield* browser.checkpoint(
          "Public logo and neutral private, wildcard and ambiguous providers",
        );
      }),
    ),
  );
});
