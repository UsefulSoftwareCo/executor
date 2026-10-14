/** Add app lists official catalog apps only and never reads the public registry. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Api, body, SessionClients } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { registryPublication, registryUpstream } from "../support/registry-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Schema.Struct({ slug: Schema.String }));

layer(TestLive, { excludeTestServices: true })("Add app and the public registry", (it) => {
  it.effect(scenarios.addAppRegistry.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const registry = yield* registryUpstream;
        const origin = yield* startFreshSelfHost(target, {
          EXECUTOR_REGISTRY_URL: registry.origin,
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        const account = { email: "registry-owner@example.test", password: "Synthetic-1234!" };
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            ...account,
            name: "Registry Owner",
            organizationName: "Registry lab",
          })).status,
        ).toBe(200);
        expect((yield* api.request(owner, "POST", "/api/auth/sign-in/email", account)).status).toBe(
          200,
        );
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list"),
        );
        yield* browser.login(owner);
        const addApp = `${origin}/org/${organization.slug}/apps/add`;

        yield* browser.use("Open Add app", (page) => page.goto(addApp));
        yield* browser.use("Catalog apps are listed", (page) =>
          page.locator(".catalog-row").first().waitFor(),
        );
        yield* browser.checkpoint("Add app lists catalog apps");
        yield* browser.use("Search for the published app", (page) =>
          page.getByPlaceholder("Search apps…").fill(registryPublication.name),
        );
        yield* browser.use("No published app matches", (page) =>
          page.getByRole("heading", { name: "No matching apps", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Add app without published apps");
        expect(yield* registry.paths, "Add app read nothing from the registry").toEqual([]);
      }),
    ),
  );
});
