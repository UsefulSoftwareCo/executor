import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Workspace } from "../support/app-authoring.ts";
import { withApps } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Cloud site Apps directory", (it) => {
  it.effect(scenarios.cloudSiteAppsDirectory.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const browser = yield* Browser;

        const origin = { origin: hosts.edge };
        for (const path of ["/api/registry/apps", "/api/registry/apps?name=%40example%2Fmissing"]) {
          const read = yield* rawRequest(`${hosts.api}${path}`, { headers: origin });
          expect(read.allowOrigin, path).toBe("*");
        }
        expect((yield* rawRequest(`${hosts.api}/api/registry/apps`)).status).toBe(200);
        const preflight = yield* rawRequest(`${hosts.api}/api/registry/apps`, {
          method: "OPTIONS",
          headers: {
            ...origin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "traceparent",
          },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.allowOrigin).toBe("*");
        expect(preflight.allowMethods).toBe("GET");
        expect(
          (yield* rawRequest(`${hosts.api}/api/context`, { headers: origin })).allowOrigin,
        ).toBeNull();

        const listing = yield* browser.use("Open the Apps directory on the edge", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().startsWith(`${hosts.api}/api/registry/apps`) &&
                response.request().method() === "GET",
            ),
            page.goto(`${hosts.edge}/apps`),
          ]).then(([response]) => response.status()),
        );
        expect(listing).toBe(200);
        yield* browser.use("The directory has loaded", (page) =>
          page
            .getByRole("searchbox", { name: "Search apps" })
            .and(page.locator(":enabled"))
            .waitFor(),
        );
        expect(
          yield* browser.use("No load failure is shown", (page) => page.getByRole("alert").count()),
        ).toBe(0);
        yield* browser.checkpoint("Apps directory loaded on the edge");
      }),
    ),
  );
});

layer(HostedLive, { excludeTestServices: true })("Cloud site Apps publication", (it) => {
  it.effect(scenarios.cloudSiteAppPublication.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const slug = `site-apps-${randomUUID().slice(0, 8)}`;
        const name = `@${actors.organization.slug}.executor.community/${slug}`;
        const marker = `Listed from the API host ${randomUUID()}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Site apps ${slug}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";\n// ${marker}\nexport default defineApp({}, {});\n`,
            },
            {
              path: "package.json",
              content: JSON.stringify({
                name,
                description: "A site directory example",
                dependencies: withApps(),
              }),
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const working = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${app.id}/workspace`,
        );
        expect(working.status, JSON.stringify(working.body)).toBe(200);
        const { revision } = yield* body(Workspace, working);
        const published = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/publication`,
          { commit: revision.commit },
        );
        expect(published.status, JSON.stringify(published.body)).toBe(200);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", `${prefix}/app-publications/unpublish`, {
              package: name,
            })
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const source = yield* rawRequest(
          `${hosts.api}/api/registry/source?name=${encodeURIComponent(name)}&commit=${revision.commit}`,
          { headers: { origin: hosts.edge } },
        );
        expect(source.status).toBe(200);
        expect(source.allowOrigin).toBe("*");

        yield* browser.use("Open the Apps directory on the edge", (page) =>
          page.goto(`${hosts.edge}/apps`),
        );
        yield* browser.use("Search the directory", (page) =>
          page.getByRole("searchbox", { name: "Search apps" }).fill(slug),
        );
        yield* browser.use("The publication is listed", (page) =>
          page
            .getByRole("link", { name: new RegExp(`^${slug} by ${actors.organization.slug}\\b`) })
            .waitFor(),
        );
        yield* browser.checkpoint("Apps directory lists the publication");

        yield* browser.use("Open the publication", (page) =>
          page
            .getByRole("heading", { name: `${slug} by ${actors.organization.slug}`, exact: true })
            .click(),
        );
        yield* browser.use("The publication page opens", (page) =>
          page.waitForURL(
            `${hosts.edge}/apps/${actors.organization.slug}.executor.community/${slug}`,
          ),
        );
        yield* browser.use("The published index.ts is shown", (page) =>
          page
            .getByRole("region", { name: "Published source" })
            .locator("pre")
            .filter({ hasText: marker })
            .waitFor(),
        );
        yield* browser.use("Show the published package.json", (page) =>
          page
            .getByRole("navigation", { name: "Source files" })
            .getByRole("button", { name: "package.json", exact: true })
            .click(),
        );
        yield* browser.use("The published package.json is shown", (page) =>
          page
            .getByRole("region", { name: "Published source" })
            .locator("pre")
            .filter({ hasText: "A site directory example" })
            .waitFor(),
        );
        expect(
          yield* browser.use("No load failure is shown", (page) => page.getByRole("alert").count()),
        ).toBe(0);
        yield* browser.checkpoint("Publication page shows its source");
      }),
    ),
  );
});
