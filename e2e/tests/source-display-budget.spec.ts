/** Verify source display budgets through public hosted reads with full-sized files. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
/** Display listings name every file; contents are inlined only within the budget. */
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
layer(HostedLive, { excludeTestServices: true })("Source display budgets", (it) => {
  it.effect(scenarios.sourceDisplayBudget.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Listings inline and format a bounded amount of source; larger files are read on their own.
        const largeFiles = [
          { path: "index.ts", content: 'export default "draft";' },
          ...Array.from({ length: 5 }, (_, index) => ({
            path: `budget-${index}.ts`,
            content: `export const text="${"a".repeat(60 * 1024)}";`,
          })),
          { path: "formatted.ts", content: `export const text="${"a".repeat(250 * 1024)}";` },
          { path: "oversized.ts", content: `export const text="${"a".repeat(257 * 1024)}";` },
        ];
        const draft = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/drafts`, {
            name: `Formatting budget ${randomUUID().slice(0, 6)}`,
            files: largeFiles,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${draft.id}`).pipe(Effect.orDie),
        );
        const bounded = yield* body(
          Schema.Struct({ ...Display.fields, ...Revision.fields }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${draft.id}/workspace/display`),
        );
        expect(bounded.files.map((file) => file.path).toSorted()).toEqual(
          largeFiles.map((file) => file.path).toSorted(),
        );
        expect(
          bounded.files.filter(
            (file) =>
              file.path.startsWith("budget-") && file.content?.startsWith("export const text =\n"),
          ),
        ).toHaveLength(4);
        for (const file of largeFiles.filter((file) => file.path !== "index.ts"))
          expect(bounded.files.find((item) => item.path === file.path)?.size).toBe(
            new TextEncoder().encode(file.content).byteLength,
          );
        for (const name of ["budget-4.ts", "formatted.ts", "oversized.ts"])
          expect(bounded.files.find((file) => file.path === name)?.content).toBeUndefined();
        const readFile = (name: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `${prefix}/apps/${draft.id}/commits/${bounded.revision.commit}/display/file?path=${name}`,
            )
            .pipe(Effect.flatMap((response) => body(DisplayFile, response)));
        expect((yield* readFile("budget-4.ts")).content).toMatch(/^export const text =\n/);
        expect((yield* readFile("formatted.ts")).content).toMatch(/^export const text =\n/);
        // Files above the formatting budget are returned as their exact stored text.
        expect((yield* readFile("oversized.ts")).content).toBe(
          largeFiles.find((file) => file.path === "oversized.ts")?.content,
        );
        // Raw reads still return every stored file byte for byte.
        const raw = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${draft.id}/workspace`),
        );
        expect(raw.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
          largeFiles.toSorted((a, b) => a.path.localeCompare(b.path)),
        );
      }),
    ),
  );
});
