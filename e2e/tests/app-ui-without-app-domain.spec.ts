/** A self-host with no app domain says so when an agent asks where an app's UI is. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Api, body, SessionClients } from "../support/api.ts";
import { helloIndex } from "../support/app-authoring.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));
/**
 * The public origin a reverse proxy serves the product on. Self-host derives an app domain only
 * from a localhost origin, so with no EXECUTOR_APP_UI_BASE_URL it has none. Requests reach the
 * product's loopback listener and carry this origin, as they would through the proxy.
 */
const publicOrigin = "http://executor.example.test";

layer(TestLive, { excludeTestServices: true })("App UI without an app domain", (it) => {
  it.effect(scenarios.appUiWithoutAppDomain.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const origin = yield* startFreshSelfHost(target, { BETTER_AUTH_URL: publicOrigin });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        const request = (method: "GET" | "POST", path: string, data?: unknown) =>
          api.request(owner, method, path, data, { origin: publicOrigin });
        expect(
          (yield* request("POST", "/api/auth/self-host/setup", {
            name: "Proxy Owner",
            email: "proxy-owner@example.test",
            password: "Synthetic-proxy-password-123!",
            organizationName: "Proxy lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* request("GET", "/api/auth/organization/list"),
        );
        const prefix = `/api/organizations/${organization.id}`;
        const deployed = yield* request("POST", `${prefix}/apps/deploy`, {
          name: "Notes",
          files: [
            { path: "index.ts", content: helloIndex },
            appsManifest,
            { path: "ui/index.html", content: "<!doctype html><title>Notes</title><h1>Notes</h1>" },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        // The app has a UI, so the only reason it has no address is the missing app domain.
        const location = yield* request("GET", `${prefix}/apps/${app.id}/ui`);
        expect(location.status).toBe(200);
        expect(yield* body(Schema.Unknown, location)).toEqual({
          status: "unavailable",
          url: null,
          reason: "no_app_domain",
        });
      }),
    ),
  );
});
