import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { appIconFile, retainedAppIcons } from "../support/app-icons.ts";
import {
  desktopAccountMenu,
  desktopHostAbsent,
  desktopHostPresent,
  desktopInstalledWithoutPage,
} from "../support/desktop-host.ts";

const server = {
  path: "index.ts",
  content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
};
const page = {
  path: "ui/index.html",
  content:
    "<!doctype html><html><head><title>Installable</title></head><body><h1>Installable</h1></body></html>",
};
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String, name: Schema.String }) });

layer(TestLive, { excludeTestServices: true })("Local app desktop install", (it) => {
  it.effect(scenarios.localAppDesktopInstall.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const send = (method: "POST" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const deployed = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* send("POST", "/v1/apps/deploy", {
              owner: "local",
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files,
            });
            expect(response.status).toBe(200);
            const { app } = yield* body(Deployed, response);
            yield* Effect.addFinalizer(() =>
              send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const installable = yield* deployed("Installable", [
          server,
          page,
          appIconFile,
          appsManifest,
        ]);
        const toolsOnly = yield* deployed("Tools only", [server, appsManifest]);
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.use("Pair the browser", (page) => page.goto(url));
        yield* browser.use("Pairing finished", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        yield* retainedAppIcons(
          { list: "/apps", detail: `/apps/${installable.id}` },
          installable,
          toolsOnly,
          `/dashboard/api/apps/${installable.id}/icon`,
        );
        yield* desktopHostAbsent(`/apps/${installable.id}`, installable);
        yield* desktopHostPresent(`/apps/${installable.id}`, installable.id);
        yield* desktopAccountMenu(`/apps/${installable.id}`, "local");

        yield* desktopInstalledWithoutPage(`/apps/${toolsOnly.id}?view=settings`, toolsOnly.id);
      }),
    ),
  );
});
