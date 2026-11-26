import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { appIconFile, retainedAppIcons } from "../support/app-icons.ts";
import {
  desktopAccountMenu,
  desktopHostAbsent,
  desktopHostPresent,
  desktopInstalledWithoutPage,
} from "../support/desktop-host.ts";

const files = [
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
  },
  {
    path: "ui/index.html",
    content:
      "<!doctype html><html><head><title>Installable</title></head><body><h1>Installable</h1></body></html>",
  },
  appIconFile,
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("App desktop install", (it) => {
  it.effect(scenarios.appDesktopInstall.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (name: string, appFiles: typeof files) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: appFiles,
            });
            expect(deployed.status).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const app = yield* deploy("Installable", files);
        const toolsOnly = yield* deploy(
          "Tools only",
          files.filter((file) => file.path !== "ui/index.html" && file.path !== appIconFile.path),
        );
        yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        yield* browser.login(actors.owner);
        const path = `/org/${actors.organization.slug}/apps/${app.id}`;
        yield* retainedAppIcons(
          { list: `/org/${actors.organization.slug}/apps`, detail: path },
          app,
          toolsOnly,
          `/api/organizations/${actors.organization.id}/apps/${app.id}/icon`,
        );
        yield* desktopHostAbsent(path, {
          id: app.id,
          name: app.name,
          organization: actors.organization.id,
        });
        yield* desktopHostPresent(path, app.id);
        yield* desktopAccountMenu(path, "hosted");
        yield* desktopInstalledWithoutPage(
          `/org/${actors.organization.slug}/apps/${toolsOnly.id}?view=settings`,
          toolsOnly.id,
        );
      }),
    ),
  );
});
