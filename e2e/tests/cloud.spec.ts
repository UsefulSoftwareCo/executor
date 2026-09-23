import { scenarios } from "../test-plan.ts";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Api } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";

layer(TestLive, { excludeTestServices: true })("Cloud smoke", (it) => {
  it.effect(scenarios.cloud.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          anonymous = yield* api.session();
        const health = yield* api.request(anonymous, "GET", "/health");
        expect(health.status).toBe(200);
        expect(health.body).toEqual({ status: "ok" });
        expect((yield* api.request(anonymous, "GET", "/api/viewer")).status).toBe(401);
        yield* browser.use("Open cloud sign-in", (page) => page.goto("/login"));
        yield* browser.use("Email sign-in is available", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Email field is visible", (page) =>
          page.getByLabel("Email", { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Cloud sign-in page on the attached endpoint");
      }),
    ),
  );
});
