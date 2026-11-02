/** An authored app may set site cookies, but cannot choose the dashboard's signed-in user. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors, password } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Target } from "../support/platform.ts";

layer(HostedLive, { excludeTestServices: true })("Dashboard cookie isolation", (it) => {
  it.effect(scenarios.appUiCookieIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const owner = yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Cookie isolation fixture",
          files: [
            {
              path: "index.ts",
              content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
            },
            {
              path: "ui/index.html",
              content: "<!doctype html><html><body><h1>Untrusted app</h1></body></html>",
            },
            appsManifest,
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open the app inside the HTTPS dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=app`),
        );
        yield* browser.use("The authenticated app renders", (page) =>
          page
            .frameLocator(`iframe[title="${app.name} app"]`)
            .getByRole("heading", { name: "Untrusted app" })
            .waitFor(),
        );
        yield* browser.use(
          "Every issued Better Auth cookie uses host-only HTTPS semantics",
          (page) =>
            page
              .context()
              .request.post(`${target.metadata.origin}/api/auth/sign-in/email`, {
                data: { email: "owner@example.test", password, rememberMe: false },
                headers: { origin: target.metadata.origin },
              })
              .then((login) => {
                expect(login.status()).toBe(200);
                const cookies = login
                  .headersArray()
                  .filter((header) => header.name.toLowerCase() === "set-cookie");
                expect(cookies.length).toBeGreaterThan(1);
                for (const { value } of cookies) {
                  expect(value.split("=", 1)[0]).toMatch(/^__Host-executor-hosted\./);
                  expect(/;\s*Path=\/(?:;|$)/i.test(value)).toBe(true);
                  expect(/;\s*Secure(?:;|$)/i.test(value)).toBe(true);
                  expect(/;\s*HttpOnly(?:;|$)/i.test(value)).toBe(true);
                  expect(/;\s*Domain=/i.test(value)).toBe(false);
                }
              }),
        );
        yield* browser.use(
          "The app injects old names and tries to inject the protected name",
          (page) => {
            const frame = page
              .frames()
              .find(
                (frame) =>
                  new URL(frame.url()).hostname === `a-${app.id.slice(4)}.fixture.localhost`,
              );
            expect(frame).toBeDefined();
            return frame!.evaluate(() => {
              for (const name of [
                "__Secure-executor-hosted.session_token",
                "executor-hosted.session_token",
                "__Host-executor-hosted.session_token",
                "__Secure-__Host-executor-hosted.session_token",
              ])
                document.cookie = `${name}=app-injected; Domain=fixture.localhost; Path=/api; Secure; SameSite=Lax`;
            });
          },
        );
        yield* browser.use(
          "Chromium keeps the injected legacy cookie and refuses the protected one",
          (page) =>
            page
              .context()
              .cookies(`${target.metadata.origin}/api/auth/get-session`)
              .then((cookies) => {
                expect(
                  cookies.some(
                    (cookie) =>
                      cookie.name === "__Secure-executor-hosted.session_token" &&
                      cookie.path === "/api" &&
                      cookie.domain === ".fixture.localhost",
                  ),
                ).toBe(true);
                const protectedCookies = cookies.filter(
                  (cookie) => cookie.name === "__Host-executor-hosted.session_token",
                );
                expect(protectedCookies).toHaveLength(1);
                expect(protectedCookies[0]?.domain).toBe("app.fixture.localhost");
                expect(protectedCookies[0]?.path).toBe("/");
              }),
        );
        const sessionSurvived = yield* browser.use(
          "Injected cookies are sent first but do not affect the dashboard session",
          (page) =>
            Promise.all([
              page
                .waitForRequest(
                  (request) => new URL(request.url()).pathname === "/api/auth/get-session",
                )
                .then((request) => request.allHeaders()),
              page.evaluate(() =>
                fetch("/api/auth/get-session", { credentials: "include" })
                  .then((response) => response.json())
                  .then((session) => session?.user?.id),
              ),
            ]).then(([headers, user]) => {
              const cookie = headers.cookie ?? "";
              expect(
                cookie.indexOf("__Secure-executor-hosted.session_token=app-injected"),
              ).toBeGreaterThanOrEqual(0);
              expect(
                cookie.indexOf("__Secure-executor-hosted.session_token=app-injected"),
              ).toBeLessThan(cookie.indexOf("__Host-executor-hosted.session_token="));
              return user === owner.user.id;
            }),
        );
        expect(sessionSurvived).toBe(true);
        yield* browser.use(
          "Legacy cookie names cannot restore even a valid signed session",
          (page) =>
            page
              .context()
              .cookies(target.metadata.origin)
              .then((cookies) => {
                const current = cookies.find(
                  (cookie) => cookie.name === "__Host-executor-hosted.session_token",
                );
                expect(current).toBeDefined();
                return page
                  .context()
                  .request.get(`${target.metadata.origin}/api/auth/get-session`, {
                    headers: {
                      cookie: `__Secure-executor-hosted.session_token=${current!.value}; executor-hosted.session_token=${current!.value}`,
                    },
                  });
              })
              .then((response) => {
                expect(response.status()).toBe(200);
                return response.json();
              })
              .then((session) => expect(session).toBeNull()),
        );
        yield* browser.use("The signed-in dashboard remains usable after injection", (page) =>
          page.reload(),
        );
        yield* browser.use("Reload keeps the app page", (page) =>
          page.getByRole("navigation", { name: "App navigation" }).waitFor(),
        );
        yield* browser.use("Reload restores the embedded app", (page) =>
          page
            .frameLocator(`iframe[title="${app.name} app"]`)
            .getByRole("heading", { name: "Untrusted app" })
            .waitFor(),
        );
        yield* browser.checkpoint("dashboard-session-survives-cookie-tossing");
      }),
    ),
  );
});
