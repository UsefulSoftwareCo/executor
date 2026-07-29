import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import { makeTestExecutor } from "./testing";
import type { ArtifactBinding } from "./artifact";
import { ConnectionName, IntegrationSlug } from "./ids";

const binding = (integration: string, owner: "user" | "org", name: string): ArtifactBinding => ({
  integration: IntegrationSlug.make(integration),
  owner,
  connection: ConnectionName.make(name),
});

// The `executor.artifacts` surface against the real SQLite test db. Artifacts
// are owner-scoped rows with no plugin involvement, so the default test
// executor (one tenant + one bound subject) is the whole fixture.

const CODE = "export default function App() { return <div>hi</div>; }";

describe("executor.artifacts", () => {
  it.effect("list is empty when nothing is saved", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      expect(yield* executor.artifacts.list()).toEqual([]);
    }),
  );

  it.effect("save mints an id and stores the source", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Active users",
        description: "Daily active users over time",
        code: CODE,
      });
      expect(saved.id).not.toBe("");
      expect(saved.owner).toBe("user");
      expect(saved.title).toBe("Active users");
      expect(saved.description).toBe("Daily active users over time");
      expect(saved.code).toBe(CODE);

      const fetched = yield* executor.artifacts.get(saved.id);
      expect(fetched).toEqual(saved);
    }),
  );

  it.effect("round-trips connection bindings through the json column", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const bindings = {
        vercel: binding("vercel", "user", "personalVercel"),
        prod: binding("linear", "org", "linearProd"),
      };
      const saved = yield* executor.artifacts.save({ title: "Domains", code: CODE, bindings });
      expect(saved.bindings).toEqual(bindings);
      expect((yield* executor.artifacts.get(saved.id)).bindings).toEqual(bindings);
    }),
  );

  it.effect("saves an artifact that binds nothing as bound-but-empty, not unbound", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Static", code: CODE, bindings: {} });
      // `{}` and `null` are different facts: `{}` is an artifact that calls no
      // integration, `null` is one written before bindings existed and whose
      // code still carries full addresses.
      expect(saved.bindings).toEqual({});
      expect((yield* executor.artifacts.get(saved.id)).bindings).toEqual({});
    }),
  );

  it.effect("leaves bindings null when a save omits them", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Legacy", code: CODE });
      expect(saved.bindings).toBe(null);
    }),
  );

  it.effect("overwrites bindings along with the source", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Domains",
        code: CODE,
        bindings: { vercel: binding("vercel", "user", "old") },
      });
      const updated = yield* executor.artifacts.save({
        id: saved.id,
        title: "Domains",
        code: CODE,
        bindings: { vercel: binding("vercel", "user", "new") },
      });
      expect(updated.bindings).toEqual({ vercel: binding("vercel", "user", "new") });
      expect((yield* executor.artifacts.get(saved.id)).bindings).toEqual({
        vercel: binding("vercel", "user", "new"),
      });
    }),
  );

  it.effect("save defaults a missing description to null", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Untitled", code: CODE });
      expect(saved.description).toBe(null);
    }),
  );

  it.effect("list omits the source", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Active users",
        description: "described",
        code: CODE,
      });

      const listed = yield* executor.artifacts.list();
      // The list projection is deliberately code-free: a saved component can be
      // large and a picker only needs title/description to match on. The
      // preview is the one exception — the gallery is the surface that draws
      // it — and it is null here because this save supplied none.
      expect(listed).toEqual([
        {
          id: saved.id,
          owner: "user",
          title: "Active users",
          description: "described",
          preview: null,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        },
      ]);
    }),
  );

  // `it.live` (real clock) with a full-second gap: `dateColumn` lands in SQLite
  // as a SECOND-resolution integer, so two artifacts saved inside one second
  // carry the same `updated_at` and only the id tiebreak separates them. This
  // pins the ordering the picker actually depends on, at the resolution the
  // storage layer really has.
  it.live("list returns the most recently updated artifact first", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const first = yield* executor.artifacts.save({ title: "First", code: CODE });
      yield* Effect.sleep("1100 millis");
      const second = yield* executor.artifacts.save({ title: "Second", code: CODE });
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

      expect((yield* executor.artifacts.list()).map((a) => a.id)).toEqual([second.id, first.id]);

      // Touching the OLDER artifact floats it back to the top — the list is
      // keyed on `updated_at`, not on creation order.
      yield* Effect.sleep("1100 millis");
      yield* executor.artifacts.rename({ id: first.id, title: "First, touched" });
      expect((yield* executor.artifacts.list()).map((a) => a.id)).toEqual([first.id, second.id]);
    }),
  );

  it.effect("save with an id overwrites in place", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Draft", code: CODE });
      const updated = yield* executor.artifacts.save({
        id: saved.id,
        title: "Final",
        description: "now described",
        code: "export default function App() { return null; }",
      });

      expect(updated.id).toBe(saved.id);
      expect(updated.title).toBe("Final");
      expect(updated.description).toBe("now described");
      expect(updated.code).toBe("export default function App() { return null; }");
      expect(updated.createdAt.getTime()).toBe(saved.createdAt.getTime());

      // Overwrite, not append: still exactly one row.
      const listed = yield* executor.artifacts.list();
      expect(listed.map((a) => a.id)).toEqual([saved.id]);
    }),
  );

  it.effect("save fails for an id that names no visible artifact", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* Effect.result(
        executor.artifacts.save({ id: "art_missing", title: "Ghost", code: CODE }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("get fails for an unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* Effect.result(executor.artifacts.get("art_missing"));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("rename changes only the title", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({
        title: "Old name",
        description: "kept",
        code: CODE,
      });
      const renamed = yield* executor.artifacts.rename({ id: saved.id, title: "New name" });
      expect(renamed.title).toBe("New name");
      expect(renamed.description).toBe("kept");
      expect(renamed.code).toBe(CODE);
    }),
  );

  it.effect("rename fails for an unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const result = yield* Effect.result(
        executor.artifacts.rename({ id: "art_missing", title: "Nope" }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("remove hard-deletes the artifact", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "Temp", code: CODE });
      yield* executor.artifacts.remove({ id: saved.id });

      expect(yield* executor.artifacts.list()).toEqual([]);
      const result = yield* Effect.result(executor.artifacts.get(saved.id));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
    }),
  );

  it.effect("remove is idempotent", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      yield* executor.artifacts.remove({ id: "art_missing" });
    }),
  );

  it.effect("an executor with no subject cannot save a user artifact", () =>
    Effect.gen(function* () {
      // Pure-org executors (host request paths with no member bound) have no
      // user partition to file a personal artifact into.
      const executor = yield* makeTestExecutor({ subject: null });
      const result = yield* Effect.result(executor.artifacts.save({ title: "Orphan", code: CODE }));
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  describe("previews", () => {
    const MARKUP = '<div class="p-4"><h2>Revenue</h2></div>';
    const SETTLED = '<div class="p-4"><h2>Revenue</h2><p>12,480 active</p></div>';

    it.effect("round-trips layout markup, and reads it back as a layout preview", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({
          title: "Revenue",
          code: CODE,
          preview: MARKUP,
        });
        expect(saved.preview).toEqual({ kind: "layout", markup: MARKUP });
        // The gallery reads it from the LIST, so that is the projection that
        // has to carry it.
        expect((yield* executor.artifacts.list())[0]?.preview).toEqual({
          kind: "layout",
          markup: MARKUP,
        });
      }),
    );

    it.effect("leaves the preview null when a save omits one", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({ title: "Plain", code: CODE });
        expect(saved.preview).toBe(null);
      }),
    );

    it.effect("overwrites the preview along with the source", () =>
      Effect.gen(function* () {
        // The preview interprets `code`, so a save that replaces the source
        // must replace the picture — including back to null. Carrying it
        // forward would advertise a version of the artifact that is gone.
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({
          title: "Revenue",
          code: CODE,
          preview: MARKUP,
        });
        const updated = yield* executor.artifacts.save({
          id: saved.id,
          title: "Revenue",
          code: CODE,
        });
        expect(updated.preview).toBe(null);
        expect((yield* executor.artifacts.get(saved.id)).preview).toBe(null);
      }),
    );

    it.effect("setPreview upgrades the preview to the settled render", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({
          title: "Revenue",
          code: CODE,
          preview: MARKUP,
        });
        yield* executor.artifacts.setPreview({ id: saved.id, preview: SETTLED });
        expect((yield* executor.artifacts.get(saved.id)).preview).toEqual({
          kind: "layout",
          markup: SETTLED,
        });
      }),
    );

    it.effect("setPreview does not reorder the gallery", () =>
      Effect.gen(function* () {
        // `updated_at` is the gallery's sort key. Opening an artifact must not
        // move it to the front — being looked at is not an edit.
        const executor = yield* makeTestExecutor();
        const saved = yield* executor.artifacts.save({ title: "Revenue", code: CODE });
        yield* executor.artifacts.setPreview({ id: saved.id, preview: SETTLED });
        expect((yield* executor.artifacts.get(saved.id)).updatedAt).toEqual(saved.updatedAt);
      }),
    );

    it.effect("setPreview fails for an artifact that is not visible", () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        const result = yield* Effect.result(
          executor.artifacts.setPreview({ id: "art_missing", preview: SETTLED }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(Predicate.isTagged("ArtifactNotFoundError")(result.failure)).toBe(true);
      }),
    );
  });
});
