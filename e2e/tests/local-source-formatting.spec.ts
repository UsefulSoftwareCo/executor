import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

layer(TestLive, { excludeTestServices: true })("Local source formatting", (it) => {
  it.effect(scenarios.localSourceFormatting.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const files = [
          {
            path: "index.ts",
            content: 'import {defineApp} from "apps";export default defineApp({accounts:{}},{});',
          },
        ];
        const { app } = yield* body(
          Schema.Struct({
            app: Schema.Struct({ id: Schema.String, activeDeployment: Schema.String }),
          }),
          yield* session.send(
            "POST",
            "/v1/apps/deploy",
            {
              owner: "local",
              name: `Formatting ${randomUUID().slice(0, 6)}`,
              files,
            },
            headers,
          ),
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, headers),
        );
        yield* browser.use("Pair local source browser", (page) => page.goto(url));
        yield* browser.use("Local dashboard ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );

        for (const [endpoint, view] of [
          [`/api/apps/${app.id}/workspace`, "source"],
          [`/dashboard/api/apps/${app.id}/deployments/${app.activeDeployment}`, "deployments"],
        ] as const) {
          const response = yield* browser.use(
            "Read formatted source from the local server",
            (page) => page.request.get(`${endpoint}?format=display`),
          );
          expect(response.status()).toBe(200);
          const display = yield* Schema.decodeUnknownEffect(Source)(
            yield* browser.use("Decode local display response", () => response.json()),
          );
          const expected = display.files[0]?.content;
          expect(expected).toContain('import { defineApp } from "apps";\n');
          yield* browser.use(`Open local ${view}`, (page) =>
            page.goto(`/apps/${app.id}?view=${view}`),
          );
          const shown = yield* browser.use("Read local display text", (page) =>
            page.locator(".code-view code").evaluate((element) => {
              const copy = element.cloneNode(true);
              if (!(copy instanceof Element)) throw new Error("Missing source code");
              copy.querySelectorAll(".line-number").forEach((node) => node.remove());
              return copy.textContent ?? "";
            }),
          );
          expect(shown.trimEnd()).toBe(expected?.trimEnd());
          const rawResponse = yield* browser.use("Read unchanged local source", (page) =>
            page.request.get(endpoint),
          );
          expect(rawResponse.status()).toBe(200);
          const raw = yield* Schema.decodeUnknownEffect(Source)(
            yield* browser.use("Decode unchanged source", () => rawResponse.json()),
          );
          expect(raw.files).toEqual(files);
        }
      }),
    ),
  );
});
