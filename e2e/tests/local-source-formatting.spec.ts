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
const Display = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Number,
      content: Schema.optionalKey(Schema.String),
    }),
  ),
});
const DisplayFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  content: Schema.String,
});
const Revision = Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) });
/** A generated file above the inline budget, like a large OpenAPI operations file. */
const operations = {
  path: "operations.json",
  content: JSON.stringify({
    operations: Array.from({ length: 5000 }, (_, id) => ({ id, name: `operation-${id}` })),
  }),
};

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
          operations,
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

        const { revision } = yield* browser.use("Read the local working revision", (page) =>
          page.request
            .get(`/api/apps/${app.id}/workspace`)
            .then((response) => response.json())
            .then(Schema.decodeUnknownSync(Revision)),
        );
        for (const [endpoint, file, view] of [
          [
            `/api/apps/${app.id}/workspace`,
            `/api/apps/${app.id}/commits/${revision.commit}/display/file`,
            "source",
          ],
          [
            `/dashboard/api/apps/${app.id}/deployments/${app.activeDeployment}`,
            `/dashboard/api/apps/${app.id}/deployments/${app.activeDeployment}/display/file`,
            "deployments",
          ],
        ] as const) {
          const response = yield* browser.use(
            "Read formatted source from the local server",
            (page) => page.request.get(`${endpoint}/display`),
          );
          expect(response.status()).toBe(200);
          const display = yield* Schema.decodeUnknownEffect(Display)(
            yield* browser.use("Decode local display response", () => response.json()),
          );
          const expected = display.files.find((file) => file.path === "index.ts")?.content;
          expect(expected).toContain('import { defineApp } from "apps";\n');
          // The large file is listed by path and size; its contents arrive only when selected.
          const size = new TextEncoder().encode(operations.content).byteLength;
          expect(display.files.find((file) => file.path === operations.path)).toEqual({
            path: operations.path,
            size,
          });
          const loaded = yield* browser.use("Read one large display file", (page) =>
            page.request
              .get(`${file}?path=${operations.path}`)
              .then((response) => response.json())
              .then(Schema.decodeUnknownSync(DisplayFile)),
          );
          expect(loaded.size).toBe(size);
          expect(loaded.content).toContain('\n  "operations": [\n    {\n      "id": 0,');
          yield* browser.use(`Open local ${view}`, (page) =>
            page.goto(`/apps/${app.id}?view=${view}`),
          );
          const read = () =>
            browser.use("Read local display text", (page) =>
              page.locator(".code-view code").evaluate((element) => {
                const copy = element.cloneNode(true);
                if (!(copy instanceof Element)) throw new Error("Missing source code");
                copy.querySelectorAll(".line-number").forEach((node) => node.remove());
                return copy.textContent ?? "";
              }),
            );
          expect((yield* read()).trimEnd()).toBe(expected?.trimEnd());
          yield* browser.use("File count includes files without inlined contents", (page) =>
            page
              .getByRole("navigation", { name: "Source files" })
              .getByText(String(files.length), { exact: true })
              .waitFor(),
          );
          yield* browser.use(`Select ${operations.path}`, (page) =>
            page.getByRole("button", { name: operations.path, exact: true }).click(),
          );
          yield* browser.use("The selected large file loads", (page) =>
            page.locator(".code-view").filter({ hasText: '"name": "operation-4999"' }).waitFor(),
          );
          expect((yield* read()).trimEnd()).toBe(loaded.content.trimEnd());
          yield* browser.use("Line count matches the loaded display text", (page) =>
            page.getByText(`${loaded.content.split("\n").length} lines`, { exact: true }).waitFor(),
          );
          yield* browser.checkpoint(`Local ${view}: loaded ${operations.path}`);
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
